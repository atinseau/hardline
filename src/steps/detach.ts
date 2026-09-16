import { psQuote } from "../lib/powershell";

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

/** La tache qui porte la queue. Elle se supprime elle-meme en terminant. */
export const CLEANUP_TASK_NAME = "hardline-cleanup";

/** Le delai avant declenchement : le temps que la session SSH se referme. */
const CLEANUP_DELAY_SECONDS = 5;

/**
 * Une queue qui survit a la fermeture de la session SSH.
 *
 * `Start-Process` ne suffit pas, et c'est une desinstallation reelle qui l'a
 * montre : le port 22 du PC repondait encore une minute apres le lancement
 * d'une charge censee arreter sshd au bout de deux secondes. Windows OpenSSH
 * place les processus de sa session dans un objet Job, et la fermeture de la
 * session emporte le processus « detache » avec elle. La queue ne detachait
 * donc rien, dans ses deux usages, et la desinstallation annoncait un menage
 * qui n'avait pas lieu.
 *
 * Une tache planifiee, elle, appartient au planificateur. Fermer la session ne
 * l'atteint pas, et son principal SYSTEM lui donne les droits d'arreter sshd et
 * de rendre l'adressage. C'est l'idiome que network-profile-task emploie deja
 * pour la meme raison, reutilise ici plutot que reinvente.
 *
 * La charge part encodee en base64, ce qui supprime entierement la question du
 * quoting : aucune valeur de `statements` n'est relue par un shell entre ici et
 * son execution. Elle tourne sous $ErrorActionPreference = 'Continue' — une
 * instruction de restauration qui echoue ne doit pas empecher les suivantes de
 * rendre ce qu'elles savent rendre — et se termine en supprimant sa propre
 * tache : une desinstallation qui promet de ne rien laisser ne laisse pas non
 * plus l'outil de son propre menage.
 */
export const detachTail = (statements: string[]): string => {
  const payload = [
    "$ErrorActionPreference = 'Continue'",
    ...statements,
    `Unregister-ScheduledTask -TaskName '${CLEANUP_TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`,
  ].join("\n");
  const encoded = Buffer.from(payload, "utf16le").toString("base64");

  return [
    `$encoded = ${psQuote(encoded, "charge de la queue détachée")}`,
    "$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument \"-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded\"",
    `$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddSeconds(${CLEANUP_DELAY_SECONDS}))`,
    "$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable",
    `Register-ScheduledTask -TaskName '${CLEANUP_TASK_NAME}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null`,
  ].join("\n");
};
