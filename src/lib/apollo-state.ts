/**
 * Le contournement d'un defaut d'Apollo 0.4.6, mesure sur la machine.
 *
 * Apollo ecrit trois champs de chaque client appaire comme des CHAINES JSON
 * ("false" / "true") dans config\sunshine_state.json, puis les relit au
 * demarrage suivant comme des BOOLEENS. Le chargeur leve, la CRT appelle
 * abort(), et Sunshine.exe meurt en boucle : journal d'evenements Windows
 * `Sunshine.exe / ucrtbase.dll / 0xc0000409`, toujours au meme point — juste
 * apres « Found AV1 encoder », au moment d'ouvrir l'interface web. Aucun port
 * n'ecoute, donc plus rien ne repond : ni l'API, ni le flux.
 *
 * Le defaut n'est PAS celui de hardline. src/steps/pairing.ts poste
 * {pin, name} sur /api/pin, exactement le corps que l'interface web d'Apollo
 * envoie elle-meme (registerDevice(), dans assets\web\assets\pin-*.js). Tout
 * appairage, y compris depuis l'interface officielle, produit un etat qui tue
 * Apollo au demarrage suivant. hardline le contourne parce qu'il promet un PC
 * qui survit a un redemarrage, pas parce qu'il l'a provoque.
 *
 * Table de decision etablie en onze essais sur le PC, service arrete et
 * journal vide entre chaque, verdict = processus vivant ET port 47990 en
 * ecoute apres 45-60 s :
 *
 *   etat plat (username/salt/password)          VIVANT
 *   + root.uniqueid seul                        VIVANT
 *   + entree named_devices d'origine            CRASH
 *   entree sans display_mode                    CRASH
 *   entree + do/undo vides                      CRASH
 *   entree SANS cert                            CRASH
 *   entree name/uuid/cert/perm                  VIVANT
 *   la meme + allow_client_commands "false"     CRASH
 *   la meme + always_use_virtual_display "false" CRASH
 *   la meme + enable_legacy_ordering "true"     CRASH
 *   la meme + les trois en BOOLEENS JSON        VIVANT
 *
 * D'ou les deux faits que ce module tient pour acquis : ces trois champs, et
 * eux seuls, doivent etre des booleens ; `cert` doit survivre a l'operation,
 * puisque son absence plante aussi.
 */

/** Les trois champs mesures coupables. Rien d'autre n'est touche. */
export const BOOLEAN_DEVICE_FIELDS = [
  "allow_client_commands",
  "always_use_virtual_display",
  "enable_legacy_ordering",
] as const;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fonction pure. Rend le texte du fichier avec les trois champs convertis en
 * booleens, ou null quand il n'y a rien a changer — etat deja conforme, ou
 * aucun client appaire. Ce null n'est pas une commodite : il evite de
 * reecrire un fichier qu'Apollo tient ouvert, et rend l'etape idempotente
 * sans qu'elle ait a comparer elle-meme deux textes.
 *
 * La sortie est reserialisee, donc non verbatim — contrairement a patchConf
 * (src/lib/apollo-conf.ts), qui preserve commentaires et ordre parce que
 * sunshine.conf appartient a l'utilisateur. Ici le fichier appartient a
 * Apollo, qui le reecrit entierement a chaque appairage : preserver sa mise
 * en forme n'aurait aucun lecteur.
 */
export function normalizeState(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `sunshine_state.json illisible : ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isObject(parsed)) return null;

  const root = parsed.root;
  if (!isObject(root)) return null;

  const devices = root.named_devices;
  if (!Array.isArray(devices)) return null;

  let changed = false;

  for (const device of devices) {
    if (!isObject(device)) continue;

    for (const field of BOOLEAN_DEVICE_FIELDS) {
      const value = device[field];
      if (typeof value !== "string") continue;

      // Une valeur qu'on ne sait pas interpreter reste telle quelle. La
      // convertir en `false` par defaut changerait une permission — perm et
      // allow_client_commands decident de ce qu'un client a le droit de
      // faire — au nom d'une supposition, et sans que personne le voie.
      if (value !== "true" && value !== "false") continue;

      device[field] = value === "true";
      changed = true;
    }
  }

  return changed ? JSON.stringify(parsed, null, 4) : null;
}
