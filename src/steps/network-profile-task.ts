import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import type { Config } from "../config";
import type { Step } from "./types";

export const TASK_NAME = "hardline-network-profile";

/** Le seul residu que la tache puisse laisser, supprime avec elle. */
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
    "$deadline = (Get-Date).AddMinutes(3)",
    "$applied = $false",
    "$last = $null",
    "while ((Get-Date) -lt $deadline) {",
    "  try {",
    `    $p = Get-NetConnectionProfile -InterfaceAlias '${alias}' -ErrorAction SilentlyContinue`,
    "    if ($p) {",
    "      $last = [string]$p.NetworkCategory",
    "      if ($p.NetworkCategory -ne 'Private') {",
    `        Set-NetConnectionProfile -InterfaceAlias '${alias}' -NetworkCategory Private`,
    "      }",
    `      $check = Get-NetConnectionProfile -InterfaceAlias '${alias}' -ErrorAction SilentlyContinue`,
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
    `    "$((Get-Date).ToString('s')) profil privé non appliqué sur '${alias}' (état constaté\u00a0: $last)" | Add-Content -Path (Join-Path $dir '${LOG_NAME}') -Encoding UTF8`,
    "  } catch { }",
    "}",
  ].join("\n");

const APPLY = (alias: string) => `
$inner = @'
${SCHEDULED_SCRIPT(alias)}
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
$action = New-ScheduledTaskAction -Execute 'powershell.exe' \`
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded"
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger \`
  -Principal $principal -Settings $settings -Force | Out-Null`;

const RESTORE = `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item -Path ${LOG_DIR} -Recurse -Force -ErrorAction SilentlyContinue`;

export const windowsProfileTaskStep: Step<ScheduledTaskState> = {
  name: "network-profile-task",
  label: "Maintien du profil privé au démarrage (PC)",

  async inspect(config: Config) {
    const rows = await runRemoteJson<ScheduledTaskState>(config.ssh, INSPECT);
    const current = rows[0];

    if (!current) {
      throw new Error("Le PC n'a renvoyé aucun état de tâche planifiée.");
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
    // Si une tache de ce nom existait avant hardline, on n'y touche pas.
    if (previous.present) return;
    await runRemoteChecked(config.ssh, RESTORE);
  },
};
