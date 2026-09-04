import {
  listClients,
  sendPin,
  unpairClient,
  type ApolloCredentials,
} from "../lib/apollo-api";
import { isPairedFromMac, spawnPair } from "../lib/moonlight";
import { errorMessage } from "../lib/errors";
import { containsHost, forgetHost, readHosts } from "../lib/moonlight-plist";
import { generatePin, getSecret } from "../lib/keychain";
import {
  normalizeRemoteState,
  normalizeState,
  readRemoteState,
} from "../lib/apollo-state";
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

/**
 * Attend qu'Apollo reponde a son API avant d'ouvrir une session d'appairage.
 *
 * apollo-config relance le service juste avant cette etape, et Apollo met une
 * vingtaine de secondes a detecter ses encodeurs puis a ouvrir ses ports. Se
 * lancer aussitot, c'est un « Unable to connect » de Moonlight sur un serveur
 * qui allait repondre — mesure sur la machine. Le delai plafond est genereux
 * parce qu'il ne coute rien quand tout va bien : on sort a la premiere reponse.
 */
async function waitForApollo(
  config: Config,
  creds: ApolloCredentials,
  deadlineMs = 90_000,
  pollMs = 2_000,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  const limit = now() + deadlineMs;
  let last = "";

  for (;;) {
    try {
      await listClients(config, creds);
      return;
    } catch (error) {
      last = errorMessage(error);
    }

    if (now() >= limit) {
      throw new Error(
        `Apollo n'a pas répondu dans les ${Math.round(deadlineMs / 1000)}\u00a0s ` +
          `qui ont suivi son démarrage\u00a0: ${last}`,
      );
    }
    await sleep(pollMs);
  }
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
    await waitForApollo(config, creds);

    // Un Mac deja appaire fait sortir `moonlight pair` sans rien faire et sans
    // rien dire : le PIN part alors dans le vide, /api/pin rend
    // {"status":false}, et l'etape echouait sur « n'apparait pas » en laissant
    // croire a un probleme d'appairage. On nomme la vraie cause, et on nomme
    // aussi les clients a retirer — hardline ne les depaire pas de lui-meme :
    // ce sont des appairages anterieurs, qui appartiennent a l'utilisateur.
    if (await isPairedFromMac(config)) {
      const existants = await listClients(config, creds);
      throw new Error(
        "Ce Mac est déjà appairé à ce PC, mais sous un autre nom que " +
          `«\u00a0${config.moonlight.clientName}\u00a0»\u00a0: Moonlight refuse alors de ` +
          "recommencer, et l'appairage ne peut pas aboutir. Retirer le ou les " +
          `clients concernés depuis l'interface d'Apollo (${existants.map((c) => `«\u00a0${c.name}\u00a0»`).join(", ") || "aucun client listé"}), ` +
          "puis relancer «\u00a0hardline install\u00a0».",
      );
    }

    const pin = generatePin();
    const pairing = spawnPair(config, pin);
    try {
      await pairing.ready;
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
