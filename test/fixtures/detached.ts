/**
 * La queue detachee part en base64 : une tache planifiee la porte, et son
 * contenu n'est plus lisible dans le script emis. Ces fonctions rendent aux
 * tests ce que la session envoie vraiment, sans que chacun refasse le decodage.
 */
const ENCODED = /\$encoded = '([A-Za-z0-9+/=]+)'\n\$action = /;
/** La meme charge, une fois `readable` passee dessus : le litteral est en clair. */
const PLAIN = /\$encoded = '([\s\S]*?)'\n\$action = /;

/** Ce qui reconnait une queue dans un script emis. */
export const DETACHED_MARKER = "Register-ScheduledTask -TaskName 'hardline-cleanup'";

/**
 * La charge de la queue, en clair. Accepte le script tel qu'il part comme
 * celui deja rendu lisible, pour qu'un test n'ait pas a savoir lequel il tient.
 * Chaine vide quand le script ne porte aucune queue.
 */
export function detachedPayload(script: string): string {
  const encoded = ENCODED.exec(script);
  if (encoded) return Buffer.from(encoded[1]!, "base64").toString("utf16le");
  return PLAIN.exec(script)?.[1] ?? "";
}

/** Le script, charge decodee en place : les assertions restent lisibles. */
export function readable(script: string): string {
  const match = ENCODED.exec(script);
  return match ? script.replace(match[1]!, detachedPayload(script)) : script;
}

const REGISTRAR = /^\$(encoded|action|trigger|principal|settings) =|^Register-ScheduledTask/;

/** Ce que la session SSH execute elle-meme, hors charge confiee au planificateur. */
export function inSession(script: string): string {
  // La charge part d'abord, qu'elle soit encodee ou rendue lisible : ce que la
  // session execute ne doit jamais contenir ce que le planificateur executera.
  return script
    .replace(/\$encoded = '[\s\S]*?'\n(?=\$action = )/, "")
    .split("\n")
    .filter((line) => !REGISTRAR.test(line.trim()))
    .join("\n");
}
