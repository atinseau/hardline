import { psKeyword, psQuote } from "../lib/powershell";
import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import type { Config } from "../config";
import type { RestoreContext, Step } from "./types";

export type ServiceState = { startType: string | null; status: string | null };

const STARTUP_TYPES = ["Automatic", "Manual", "Disabled", "Boot", "System"] as const;

const INSPECT = (serviceName: string) => `
$service = Get-Service -Name ${psQuote(serviceName, "nom du service")} -ErrorAction SilentlyContinue
[pscustomobject]@{
  startType = if ($service) { [string]$service.StartType } else { $null }
  status    = if ($service) { [string]$service.Status } else { $null }
}`;

export const apolloServiceStep: Step<ServiceState> = {
  name: "apollo-service",
  label: "Service Apollo au démarrage (PC)",

  async inspect(config: Config) {
    const rows = await runRemoteJson<ServiceState>(
      config.ssh,
      INSPECT(config.apollo.serviceName),
    );
    const current = rows[0];
    if (!current) {
      throw new Error("The PC returned no Apollo service state. Check the SSH connection.");
    }
    const conforming = current.startType === "Automatic" && current.status === "Running";
    return {
      conforming,
      current,
      detail: conforming
        ? "service déjà en démarrage automatique et démarré"
        : `service ${current.status ?? "absent"}, démarrage ${current.startType ?? "inconnu"}`,
    };
  },

  async apply(config: Config) {
    const serviceNameQ = psQuote(config.apollo.serviceName, "nom du service");
    // "start= auto" : espace apres le signe egal, aucun avant. Un des rares
    // pieges de syntaxe de sc.exe, non negociable.
    await runRemoteChecked(
      config.ssh,
      `sc.exe config ${serviceNameQ} start= auto | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Echec de sc.exe config (code $LASTEXITCODE)" }
Start-Service -Name ${serviceNameQ}`,
    );
  },

  /**
   * Rend startType et status tels que releves par inspect, independamment de
   * ce qu'apollo-install fera ensuite (il s'execute apres, dans l'ordre
   * inverse) : si Apollo est etranger et qu'apollo-install cede sa place,
   * c'est cette etape qui reste seule responsable de rendre l'etat du
   * service.
   */
  async restore(config: Config, previous: ServiceState, _context: RestoreContext) {
    const serviceNameQ = psQuote(config.apollo.serviceName, "nom du service");
    const lines: string[] = [];

    if (previous.startType) {
      const startupType = psKeyword(previous.startType, "type de démarrage relevé", STARTUP_TYPES);
      lines.push(
        `Set-Service -Name ${serviceNameQ} -StartupType ${startupType} -ErrorAction SilentlyContinue`,
      );
    }

    if (previous.status === "Running") {
      lines.push(`Start-Service -Name ${serviceNameQ} -ErrorAction SilentlyContinue`);
    } else if (previous.status === "Stopped") {
      lines.push(`Stop-Service -Name ${serviceNameQ} -Force -ErrorAction SilentlyContinue`);
    }

    if (lines.length === 0) return;
    await runRemoteChecked(config.ssh, lines.join("\n"));
  },
};
