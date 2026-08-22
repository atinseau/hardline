/**
 * Les valeurs qu'on coud dans un script PowerShell, et le controle qui va avec.
 *
 * Le script d'amorcage refusait deja toute valeur contenant une apostrophe :
 * ses marqueurs sont places entre apostrophes cote PowerShell, et une
 * apostrophe casserait la chaine. Le chemin RETOUR — les valeurs du releve,
 * relues sur le PC et recousues dans un script de restauration — n'avait pas
 * cette rigueur. Elle est ici, en un seul endroit, pour les deux sens.
 *
 * Rien de tout cela n'est une barriere de securite : le releve n'est
 * modifiable que par un administrateur du PC. C'est une garantie de forme —
 * mieux vaut une erreur nommee qu'une instruction muette qui ne repose jamais
 * l'adresse d'origine.
 */

/** Le nom lisible sert au message : une valeur refusee doit se retrouver. */
export function assertNoApostrophe(value: string, what: string): void {
  if (value.includes("'")) {
    throw new Error(
      `Valeur invalide pour ${what} : une apostrophe casserait le script PowerShell (${value})`,
    );
  }
}

/** La valeur, entouree d'apostrophes, prete a etre cousue dans un script. */
export function psQuote(value: string, what: string): string {
  assertNoApostrophe(value, what);
  return `'${value}'`;
}

/**
 * Un entier destine a etre interpole HORS apostrophes. `-PrefixLength undefined`
 * est une instruction qui echoue en silence dans une queue tournant en
 * `Continue` : l'adresse d'origine n'est jamais reposee et personne ne le sait.
 */
export function psInteger(value: unknown, what: string, max: number): number {
  // Number("") vaut 0 et Number(" ") aussi : un prefixe absent deviendrait un
  // /0 silencieux, exactement l'inverse de ce que cette fonction existe pour
  // empecher.
  if (typeof value === "string" && value.trim() === "") {
    throw new Error(`Valeur invalide pour ${what} : entier attendu, valeur vide`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(
      `Valeur invalide pour ${what} : entier attendu entre 0 et ${max} (${String(value)})`,
    );
  }
  return parsed;
}

/**
 * Un mot-cle destine a etre interpole HORS apostrophes : il doit appartenir a
 * un ensemble ferme, sans quoi il n'a rien a faire dans un script.
 */
export function psKeyword(
  value: string,
  what: string,
  allowed: readonly string[],
): string {
  if (!allowed.includes(value)) {
    throw new Error(
      `Valeur invalide pour ${what} : attendu ${allowed.join(", ")} (${value})`,
    );
  }
  return value;
}
