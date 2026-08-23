import {
  listClients,
  sendPin,
  unpairClient,
  type ApolloCredentials,
} from "../lib/apollo-api";
import { spawnPair } from "../lib/moonlight";
import { errorMessage } from "../lib/errors";
import { containsHost, forgetHost, readHosts } from "../lib/moonlight-plist";
import { generatePin, getSecret } from "../lib/keychain";
import { normalizeState } from "../lib/apollo-state";
import { psDoubleQuote, psQuote } from "../lib/powershell";
import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import type { Config } from "../config";
import type { RestoreContext, Step } from "./types";

export type PairingState = {
  clients: readonly string[];
  hostKnown: boolean;
};

/**
 * Les identifiants web d'Apollo, ranges au trousseau par apollo-config qui
 * s'applique avant cette etape. Leur absence est une anomalie d'ordre, pas un
 * cas a deviner en silence.
 */
async function credentials(config: Config): Promise<ApolloCredentials> {
  const password = await getSecret("apollo-web");
  if (password === null) {
    throw new Error(
      "Aucun mot de passe Apollo au trousseau\u00a0: apollo-config doit s'appliquer " +
        "avant l'appairage.",
    );
  }
  return { user: config.apollo.webUser, password };
}

const STATE_PATH_EXPR = (installDirQ: string) =>
  `(Join-Path ${installDirQ} (Join-Path 'config' 'sunshine_state.json'))`;

/**
 * Le fichier d'etat tel qu'il est sur le PC, ou null s'il n'existe pas.
 *
 * Se lit par SSH et non par l'API : quand cet etat est toxique, Apollo est
 * mort et l'API ne repond plus du tout. Un diagnostic qui passerait par elle
 * ne pourrait jamais nommer la cause de sa propre panne. Le cast [string]
 * reste DANS la branche Test-Path, pour la meme raison que dans
 * src/steps/apollo-config.ts : [string]$null vaut "" et confondrait « fichier
 * absent » avec « fichier vide ».
 */
async function readRemoteState(config: Config): Promise<string | null> {
  const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
  const rows = await runRemoteJson<{ state: string | null }>(
    config.ssh,
    `
$statePath = ${STATE_PATH_EXPR(installDirQ)}
$state = if (Test-Path $statePath) { [string](Get-Content -Path $statePath -Raw) } else { $null }
[pscustomobject]@{ state = $state }`,
  );
  const value = rows[0]?.state ?? null;
  return typeof value === "string" ? value : null;
}

/**
 * Desamorce le fichier d'etat qu'Apollo vient d'ecrire. Rend true quand une
 * correction a ete posee, false quand il n'y avait rien a corriger.
 *
 * Aucun redemarrage du service : Apollo tourne deja avec cet etat en memoire,
 * et c'est SON PROCHAIN demarrage que la correction sauve. Le relancer ici
 * lui offrirait au contraire l'occasion de reecrire le fichier.
 */
async function normalizeRemoteState(config: Config): Promise<boolean> {
  const text = await readRemoteState(config);
  if (text === null) return false;

  const patched = normalizeState(text);
  if (patched === null) return false;

  const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
  await runRemoteChecked(
    config.ssh,
    `[System.IO.File]::WriteAllText(${STATE_PATH_EXPR(installDirQ)}, ${psDoubleQuote(patched)}, (New-Object System.Text.UTF8Encoding($false)))`,
  );
  return true;
}

export const pairingStep: Step<PairingState> = {
  name: "pairing",
  label: "Mac appairé au serveur (Mac)",

  /**
   * Le fichier d'etat est releve AVANT l'API, et un etat toxique rend l'etape
   * non conforme sans qu'aucune requete ne parte. Sans cela, le seul cas ou
   * la reparation compte serait aussi le seul ou elle serait impossible :
   * Apollo mort, listClients qui leve, et l'etape en echec plutot qu'en
   * « a appliquer ». Un client deja appaire ne suffit donc pas a etre
   * conforme — encore faut-il que le PC survive a son prochain demarrage.
   */
  async inspect(config: Config) {
    const rawState = await readRemoteState(config);
    if (rawState !== null && normalizeState(rawState) !== null) {
      return {
        conforming: false,
        current: { clients: [], hostKnown: containsHost(await readHosts(), config.ssh.host) },
        detail:
          "état Apollo à désamorcer\u00a0: les booléens du client appairé y sont " +
          "des chaînes, ce qui fait planter Apollo au prochain démarrage",
      };
    }

    const creds = await credentials(config);
    const clients = await listClients(config, creds);
    const hostKnown = containsHost(await readHosts(), config.ssh.host);

    const conforming = clients.some((c) => c.name === config.moonlight.clientName);

    return {
      conforming,
      current: { clients: clients.map((c) => c.uuid), hostKnown },
      detail: conforming
        ? `«\u00a0${config.moonlight.clientName}\u00a0» déjà appairé (${clients.length} client(s) au total)`
        : `«\u00a0${config.moonlight.clientName}\u00a0» absent des ${clients.length} client(s) appairés`,
    };
  },

  /**
   * La sequence exacte imposee par la spec, sans humain :
   *   1. tirer un code a quatre chiffres ;
   *   2. lancer `moonlight pair` avec ce code, SANS attendre sa fin ;
   *   3. poster ce meme code sur /api/pin ;
   *   4. RELIRE /api/clients/list pour confirmer.
   *
   * L'etape 4 n'est pas une precaution de style : /api/pin est documente
   * comme repondant parfois "c'est fait" alors qu'aucune session d'appairage
   * n'attendait. sendPin() est appelee et son resultat deliberement IGNORE
   * pour decider du succes ; seule la relecture de listClients fait foi.
   *
   * Le processus Moonlight lance par spawnPair() est arrete dans un
   * finally : qu'il ait reussi, echoue, ou que l'appel ait leve, il ne
   * doit jamais rester en attente d'un code qui ne viendra plus.
   */
  async apply(config: Config) {
    const creds = await credentials(config);
    const pin = generatePin();

    const pairing = spawnPair(config, pin);
    try {
      await sendPin(config, creds, pin, config.moonlight.clientName);

      const confirmed = await listClients(config, creds);
      if (!confirmed.some((c) => c.name === config.moonlight.clientName)) {
        throw new Error(
          `Appairage non confirmé\u00a0: «\u00a0${config.moonlight.clientName}\u00a0» n'apparaît pas ` +
            "dans la liste des clients relue après l'envoi du code.",
        );
      }
    } finally {
      pairing.kill();
    }

    // HORS du finally : desamorcer un etat qu'on n'a pas reussi a produire
    // n'a pas de sens, et masquerait l'echec d'appairage derriere une erreur
    // d'ecriture. Voir src/lib/apollo-state.ts pour le defaut contourne.
    await normalizeRemoteState(config);
  },

  /**
   * Se defait EN PREMIER parmi les etapes distantes, puisqu'elle vient en
   * dernier dans REMOTE_STEPS : on depaire tant que le serveur repond encore.
   *
   * Les deux volets sont INDEPENDANTS, et le volet Mac ne doit jamais etre pris
   * en otage par le volet PC. Apollo arrete alors que le PC repond encore en
   * SSH faisait lever listClients, l'etape restait au manifeste, et la boucle
   * de restauration continuait jusqu'a apollo-config, qui efface le secret
   * apollo-web du trousseau. La desinstallation suivante levait alors sur ce
   * secret disparu, avant meme d'avoir touche au Mac : l'appairage ne se
   * restaurait plus jamais, uninstall sortait en echec a perpetuite, et
   * l'entree d'hote restait a demeure dans le plist de Moonlight. forgetHost,
   * elle, aurait reussi dans tous ces cas. Elle passe donc INCONDITIONNELLEMENT,
   * et ce que le PC n'a pas rendu est NOMME plutot que remonte.
   *
   * Le desamorcage de sunshine_state.json (voir apply) n'est deliberement PAS
   * defait ici, alors que hardline restaure tout le reste. Le remettre en
   * l'etat, ce serait reecrire des chaines la ou Apollo attend des booleens,
   * c'est-a-dire rendre le PC dans un etat ou Apollo meurt au demarrage
   * suivant. Une restauration fidele n'a de sens que quand l'etat d'origine
   * fonctionnait. Le contournement disparait de lui-meme : depaire, Apollo
   * reecrit ce fichier sans l'entree fautive.
   */
  async restore(config: Config, previous: PairingState, _context: RestoreContext) {
    const cedes: string[] = [];

    try {
      const creds = await credentials(config);
      const clients = await listClients(config, creds);
      const ours = clients.find((c) => c.name === config.moonlight.clientName);
      if (ours) {
        await unpairClient(config, creds, ours.uuid);
      }
    } catch (error) {
      cedes.push(
        `Client «\u00a0${config.moonlight.clientName}\u00a0» peut-être encore appairé côté PC\u00a0: ` +
          `${errorMessage(error)}`,
      );
    }

    // Un hote deja connu du plist avant hardline n'est jamais le notre a
    // effacer. forgetHost() rend false quand l'hote y figurait encore et que
    // la suppression a echoue : ce cas ne doit jamais etre pris pour un
    // succes silencieux, donc on le dit plutot que de laisser croire que le
    // Mac a tout oublie.
    if (!previous.hostKnown) {
      const forgotten = await forgetHost(config.ssh.host);
      if (!forgotten) {
        cedes.push(
          "Hôte encore connu de Moonlight sur ce Mac\u00a0: la suppression via " +
            "PlistBuddy n'a pas pu être confirmée.",
        );
      }
    }

    if (cedes.length > 0) return { yielded: cedes.join(" ") };
  },
};
