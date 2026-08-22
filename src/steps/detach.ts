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
 * Un processus detache qui survit a la fermeture de la session SSH. Les `$` du
 * script confie doivent etre echappes en `` `$ `` : sans cet echappement, le
 * shell appelant developpe $false en chaine vide et Remove-NetIPAddress
 * reclame une confirmation interactive que personne ne donnera jamais.
 *
 * La charge n'herite d'aucune preference d'erreur : c'est un contenu autonome,
 * et non un script confie a runRemoteChecked. Elle tourne donc sous
 * $ErrorActionPreference = 'Continue', ce qui est ici la bonne valeur — une
 * instruction de restauration qui echoue ne doit pas empecher les suivantes
 * de rendre ce qu'elles savent rendre.
 */
export const detachTail = (statements: string[]): string =>
  "Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command'," +
  `"Start-Sleep -Seconds 2; ${statements.join("; ").replaceAll("$", "`$")}"`;
