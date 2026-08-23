import {
  listClients,
  sendPin,
  unpairClient,
  type ApolloCredentials,
} from "../lib/apollo-api";
import { spawnPair } from "../lib/moonlight";
import { containsHost, forgetHost, readHosts } from "../lib/moonlight-plist";
import { generatePin, getSecret } from "../lib/keychain";
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

export const pairingStep: Step<PairingState> = {
  name: "pairing",
  label: "Mac appairé au serveur (Mac)",

  async inspect(config: Config) {
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
  },

  /**
   * Se defait EN PREMIER parmi les etapes distantes, puisqu'elle vient en
   * dernier dans REMOTE_STEPS : on depaire tant que le serveur repond encore.
   */
  async restore(config: Config, previous: PairingState, _context: RestoreContext) {
    const creds = await credentials(config);
    const clients = await listClients(config, creds);
    const ours = clients.find((c) => c.name === config.moonlight.clientName);
    if (ours) {
      await unpairClient(config, creds, ours.uuid);
    }

    // Un hote deja connu du plist avant hardline n'est jamais le notre a
    // effacer. forgetHost() rend false quand l'hote y figurait encore et que
    // la suppression a echoue : ce cas ne doit jamais etre pris pour un
    // succes silencieux, donc on le dit plutot que de laisser croire que le
    // Mac a tout oublie.
    if (!previous.hostKnown) {
      const forgotten = await forgetHost(config.ssh.host);
      if (!forgotten) {
        return {
          yielded:
            "Hôte encore connu de Moonlight sur ce Mac\u00a0: la suppression via " +
            "PlistBuddy n'a pas pu être confirmée.",
        };
      }
    }
  },
};
