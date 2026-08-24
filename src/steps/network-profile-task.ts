import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import { psQuote } from "../lib/powershell";
import type { Config } from "../config";
import type { Step } from "./types";

export const TASK_NAME = "hardline-network-profile";

/**
 * Le seul residu que la tache puisse laisser, supprime avec elle.
 *
 * Le repertoire n'appartient PAS a cette etape : il abrite aussi le releve
 * d'etat ecrit par l'amorcage, qui est la seule description du PC d'avant
 * hardline. Cette etape est restauree la premiere ; l'emporter en bloc
 * detruirait ce releve avant que l'etape d'amorcage, restauree en dernier,
 * n'ait pu s'en servir. On ne retire donc que le journal, et le repertoire
 * seulement s'il est vide.
 */
const LOG_DIR = "(Join-Path $env:ProgramData 'hardline')";
const LOG_NAME = "network-profile.log";

export type ScheduledTaskState = {
  present: boolean;
  state: string | null;
};

const INSPECT = `
$task = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue
[pscustomobject]@{
  present = [bool]$task
  state   = if ($task) { [string]$task.State } else { $null }
}`;

/**
 * Le script execute au demarrage. Trois exigences, chacune payee par un bug
 * observe :
 *
 * - il attend l'apparition du profil reseau plutot que de supposer l'interface
 *   prete : au demarrage elle ne l'est pas ;
 * - il ne s'arrete pas sur la simple presence du profil, mais sur sa RELECTURE
 *   en Private : un Set-NetConnectionProfile refuse laissait sinon le lien en
 *   Public — donc le pare-feu ferme — jusqu'au redemarrage suivant ;
 * - il tourne sous $ErrorActionPreference = 'Stop' (ce script-ci est un
 *   contenu encode passe a la tache planifiee, pas un script confie a
 *   runRemoteChecked : la preference doit y etre posee explicitement) et
 *   consigne son echec, faute de quoi une fenetre masquee sous SYSTEM avale
 *   l'erreur sans laisser la moindre trace.
 */
const SCHEDULED_SCRIPT = (alias: string) =>
  [
    "$ErrorActionPreference = 'Stop'",
    `$alias = ${psQuote(alias, "alias de l'interface Windows")}`,
    "$deadline = (Get-Date).AddMinutes(3)",
    "$applied = $false",
    "$last = $null",
    "while ((Get-Date) -lt $deadline) {",
    "  try {",
    "    $p = Get-NetConnectionProfile -InterfaceAlias $alias -ErrorAction SilentlyContinue",
    "    if ($p) {",
    "      $last = [string]$p.NetworkCategory",
    "      if ($p.NetworkCategory -ne 'Private') {",
    "        Set-NetConnectionProfile -InterfaceAlias $alias -NetworkCategory Private",
    "      }",
    "      $check = Get-NetConnectionProfile -InterfaceAlias $alias -ErrorAction SilentlyContinue",
    "      if ($check) { $last = [string]$check.NetworkCategory }",
    "      if ($last -eq 'Private') {",
    "        $applied = $true",
    "        break",
    "      }",
    "    }",
    "  } catch {",
    "    $last = \"erreur\u00a0: $($_.Exception.Message)\"",
    "  }",
    "  Start-Sleep -Seconds 5",
    "}",
    "if (-not $applied) {",
    "  try {",
    `    $dir = ${LOG_DIR}`,
    "    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }",
    `    "$((Get-Date).ToString('s')) profil privé non appliqué sur '$alias' (état constaté\u00a0: $last)" | Add-Content -Path (Join-Path $dir '${LOG_NAME}') -Encoding UTF8`,
    "  } catch { }",
    "}",
  ].join("\n");

const APPLY = (alias: string) => `
$encoded = ${psQuote(Buffer.from(SCHEDULED_SCRIPT(alias), "utf16le").toString("base64"), "script planifié encodé")}
$action = New-ScheduledTaskAction -Execute 'powershell.exe' \`
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded"
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger \`
  -Principal $principal -Settings $settings -Force | Out-Null`;

/**
 * Deux gestes independants, et c'est la correction : le retrait de la tache est
 * conditionne a ce que hardline l'ait posee, le retrait du journal ne l'est pas.
 *
 * Le journal est ecrit sous le nom de hardline, dans le repertoire de hardline,
 * quelle que soit la tache qui l'a rempli. Le lier au retrait de la tache
 * laissait un residu apres une desinstallation qui promet de ne rien laisser,
 * des lors qu'une tache du meme nom existait avant, le seul cas ou l'etape
 * sortait avant d'avoir nettoye.
 *
 * Un journal cote PC est legitime exactement quand quelque chose, plus tard, le
 * supprimera, et quand la panne qu'il consigne est recurrente et autrement
 * indiagnosticable. Cette etape satisfait les deux, et ce "plus tard" est ici.
 */
const RESTORE = (removeTask: boolean): string =>
  [
    ...(removeTask
      ? [
          `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`,
        ]
      : []),
    `Remove-Item -Path (Join-Path ${LOG_DIR} '${LOG_NAME}') -Force -ErrorAction SilentlyContinue`,
    `$dir = ${LOG_DIR}`,
    "if ((Test-Path $dir) -and -not (Get-ChildItem -Path $dir -Force -ErrorAction SilentlyContinue)) {",
    "  Remove-Item -Path $dir -Force -ErrorAction SilentlyContinue",
    "}",
  ].join("\n");

export const windowsProfileTaskStep: Step<ScheduledTaskState> = {
  name: "network-profile-task",
  label: "Maintien du profil privé au démarrage (PC)",

  async inspect(config: Config) {
    const rows = await runRemoteJson<ScheduledTaskState>(config.ssh, INSPECT);
    const current = rows[0];

    if (!current) {
      throw new Error("The PC returned no scheduled task state.");
    }

    const conforming = current.present && current.state !== "Disabled";

    return {
      conforming,
      current,
      detail: conforming
        ? `tâche «\u00a0${TASK_NAME}\u00a0» active`
        : current.present
          ? `tâche «\u00a0${TASK_NAME}\u00a0» en état ${current.state}`
          : "tâche absente",
    };
  },

  async apply(config: Config) {
    await runRemoteChecked(config.ssh, APPLY(config.windows.interfaceAlias));
  },

  async restore(config: Config, previous: ScheduledTaskState) {
    // Si une tache de ce nom existait avant hardline, on n'y touche pas. Le
    // journal part quand meme : il porte le nom de hardline et vit dans son
    // repertoire, et plus rien ne repassera derriere pour l'effacer.
    await runRemoteChecked(config.ssh, RESTORE(!previous.present));
  },
};
