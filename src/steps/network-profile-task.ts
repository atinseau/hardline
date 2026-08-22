import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import type { Config } from "../config";
import type { Step } from "./types";

export const TASK_NAME = "hardline-network-profile";

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
 * Le script execute au demarrage. Il attend l'apparition du profil reseau
 * plutot que de supposer l'interface prete : au demarrage elle ne l'est pas.
 */
const SCHEDULED_SCRIPT = (alias: string) =>
  [
    "$deadline = (Get-Date).AddMinutes(3)",
    "while ((Get-Date) -lt $deadline) {",
    `  $p = Get-NetConnectionProfile -InterfaceAlias '${alias}' -ErrorAction SilentlyContinue`,
    "  if ($p) {",
    "    if ($p.NetworkCategory -ne 'Private') {",
    `      Set-NetConnectionProfile -InterfaceAlias '${alias}' -NetworkCategory Private`,
    "    }",
    "    break",
    "  }",
    "  Start-Sleep -Seconds 5",
    "}",
  ].join("; ");

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

const RESTORE = `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`;

export const windowsProfileTaskStep: Step<ScheduledTaskState> = {
  name: "network-profile-task",
  label: "Maintien du profil prive au demarrage (PC)",

  async inspect(config: Config) {
    const rows = await runRemoteJson<ScheduledTaskState>(config.ssh, INSPECT);
    const current = rows[0];

    if (!current) {
      throw new Error("Le PC n'a renvoye aucun etat de tache planifiee.");
    }

    const conforming = current.present && current.state !== "Disabled";

    return {
      conforming,
      current,
      detail: conforming
        ? `tache "${TASK_NAME}" active`
        : current.present
          ? `tache "${TASK_NAME}" en etat ${current.state}`
          : "tache absente",
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
