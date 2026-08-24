/**
 * Les valeurs qu'on coud dans un script PowerShell, et le controle qui va avec.
 *
 * Certains contextes compacts du script d'amorcage refusent encore les
 * apostrophes avec assertNoApostrophe. Pour les chaines PowerShell ordinaires,
 * psQuote applique l'echappement natif : une apostrophe devient deux
 * apostrophes et reste dans le litteral.
 *
 * Cette citation centralisee est aussi une barriere contre les valeurs
 * decouvertes ou persistees qui fermeraient autrement le litteral et
 * deviendraient des instructions.
 */

/** Le nom lisible sert au message : une valeur refusee doit se retrouver. */
export function assertNoApostrophe(value: string, what: string): void {
  if (value.includes("'")) {
    throw new Error(
      `Valeur invalide pour ${what}\u00a0: une apostrophe casserait le script PowerShell (${value})`,
    );
  }
}

/** La valeur, echappee et entouree d'apostrophes, prete pour PowerShell. */
export function psQuote(value: string, _what: string): string {
  return `'${value.replaceAll("'", "''")}'`;
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
    throw new Error(
      `Valeur invalide pour ${what}\u00a0: entier attendu, valeur vide`,
    );
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(
      `Valeur invalide pour ${what}\u00a0: entier attendu entre 0 et ${max} (${String(value)})`,
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
      `Valeur invalide pour ${what}\u00a0: attendu ${allowed.join(", ")} (${value})`,
    );
  }
  return value;
}

/**
 * Le contenu d'une chaine PowerShell entre GUILLEMETS, ou l'interpolation est
 * active. C'est le seul endroit du projet qui decide comment une charge est
 * citee pour un shell appelant : la queue detachee s'en sert, et rien d'autre
 * n'a le droit de refaire ce calcul a la main.
 *
 * Trois caracteres sont speciaux, et l'ORDRE des remplacements est la substance
 * de la fonction :
 *
 *   1. l'accent grave, sans quoi les echappements poses ensuite seraient
 *      eux-memes echappes et ne protegeraient plus rien ;
 *   2. le dollar, qu'il faut soustraire au shell appelant : sans cela il
 *      developpe $false en chaine vide, et Remove-NetIPAddress reclame une
 *      confirmation interactive que personne ne donnera jamais ;
 *   3. le guillemet, qui fermerait la chaine et rendrait la fin de la charge
 *      au shell appelant sous forme d'arguments.
 *
 * Un remplacement en bloc des seuls dollars, la forme qui existait ici, tenait
 * par accident : la charge du jour ne contenait ni guillemet ni accent grave.
 *
 * Le contrat est donc net : RIEN dans le contenu n'est developpe par le shell
 * appelant. Une valeur venue de l'exterieur s'interpole cote TypeScript avant
 * l'appel, par psQuote.
 *
 * Ce contrat porte sur le PREMIER saut, et sur lui seul. Quand la chaine sert
 * d'element a un `Start-Process -ArgumentList`, il y a un second saut que
 * personne ne cite : voir assertNoDoubleQuote.
 */
export function psDoubleQuote(content: string): string {
  const escaped = content
    .replaceAll("`", "``")
    .replaceAll("$", "`$")
    .replaceAll('"', '`"');
  return `"${escaped}"`;
}

/**
 * Le second saut : ce que Start-Process transmet a son processus fils.
 *
 * `Start-Process -ArgumentList` ne RECITE PAS ses elements. Il les concatene
 * par des espaces pour former la ligne de commande du fils, qui la reanalyse
 * ensuite avec ses propres regles. psDoubleQuote protege le shell appelant,
 * pas celui-la : un guillemet survivrait au premier saut sous la forme `" puis
 * arriverait nu au second, ou il couperait la ligne de commande en deux.
 *
 * Il n'existe pas d'echappement qui rende ce second saut sur, puisque le
 * decoupage a lieu avant toute citation. On refuse donc franchement, plutot que
 * d'emettre une ligne de commande dont personne ne sait ce qu'elle fera dans un
 * processus detache que le Mac ne verra jamais.
 */
export function assertNoDoubleQuote(content: string, what: string): void {
  if (content.includes('"')) {
    throw new Error(
      `Valeur invalide pour ${what}\u00a0: un guillemet ne survit pas au découpage de Start-Process -ArgumentList (${content})`,
    );
  }
}
