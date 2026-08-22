import {
  assertNoDoubleQuote,
  psDoubleQuote,
  psQuote,
} from "../lib/powershell";

/**
 * Le seul idiome du projet pour executer, sur le PC, des instructions qui
 * coupent le canal SSH qui les transporte.
 *
 * Deux etapes en ont besoin — l'amorcage et l'adressage — et elles doivent
 * partager exactement le meme mecanisme : deux variantes voudraient dire deux
 * facons de se tromper, et l'une des deux ne serait jamais exercee.
 */

/**
 * L'adresse locale qui porte la session SSH en cours. Tout ce que hardline
 * execute sur le PC transite par elle : la supprimer coupe la connexion, tue
 * le processus enfant cote sshd, et le reste du script n'est jamais execute.
 * C'est exactement ainsi qu'on laisse un PC sans aucune adresse sur le lien
 * direct, donc sans aucun moyen d'y revenir sans acces physique.
 */
export const SSH_LOCAL_ADDRESS =
  "$sshLocal = (Get-NetTCPConnection -LocalPort 22 -State Established -ErrorAction SilentlyContinue | Select-Object -First 1).LocalAddress";

/**
 * Un processus detache qui survit a la fermeture de la session SSH.
 *
 * La citation de la charge n'est PAS refaite ici : elle appartient a
 * psDoubleQuote, seul endroit du projet qui decide comment un contenu est cite
 * pour un shell PowerShell appelant. Ce qui vivait ici etait un remplacement en
 * bloc des dollars, qui tenait par accident : il ne connaissait ni le
 * guillemet, qui aurait ferme la chaine et rendu la fin de la queue au shell
 * appelant sous forme d'arguments, ni l'accent grave, qui aurait mange le
 * caractere suivant.
 *
 * Le contrat qui en decoule : rien dans `statements` n'est developpe par le
 * shell appelant. Une valeur exterieure s'interpole cote TypeScript, par
 * psQuote, avant d'arriver ici.
 *
 * La charge n'herite d'aucune preference d'erreur : c'est un contenu autonome,
 * et non un script confie a runRemoteChecked. Elle tourne donc sous
 * $ErrorActionPreference = 'Continue', ce qui est ici la bonne valeur : une
 * instruction de restauration qui echoue ne doit pas empecher les suivantes
 * de rendre ce qu'elles savent rendre.
 */
export const detachTail = (statements: string[]): string => {
  const payload = `Start-Sleep -Seconds 2; ${statements.join("; ")}`;

  // Deux sauts, deux regles, toutes deux dans powershell.ts. Le premier est la
  // citation pour le shell appelant ; le second est le decoupage que
  // Start-Process fait de sa liste d'arguments sans les reciter, et qu'aucun
  // echappement ne rend sur.
  assertNoDoubleQuote(payload, "charge de la queue détachée");
  const args = ["-NoProfile", "-Command"]
    .map((argument) => psQuote(argument, "argument de Start-Process"))
    .join(",");

  return (
    `Start-Process powershell -WindowStyle Hidden -ArgumentList ${args},` +
    psDoubleQuote(payload)
  );
};
