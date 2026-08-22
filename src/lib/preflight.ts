import { listNetworkServices } from "./shell";
import { runRemoteJson } from "./ssh";
import { errorMessage } from "./errors";
import type { Config } from "../config";

export type CheckResult = {
  name: string;
  ok: boolean;
  /** Un échec bloquant arrête l'installation avant toute modification. */
  blocking: boolean;
  detail: string;
};

type RemoteFacts = {
  caption: string;
  build: number;
  gpus: string[];
  adapterPresent: boolean;
  adapterStatus: string | null;
};

/** Nom de la verification SSH, partage avec la commande install. */
export const SSH_CHECK = "ssh";

const EXPECTED_BUILD = 26200;

const FACTS = (alias: string) => `
$os = Get-CimInstance Win32_OperatingSystem
$adapter = Get-NetAdapter -Name '${alias}' -ErrorAction SilentlyContinue
[pscustomobject]@{
  caption       = [string]$os.Caption
  build         = [int]$os.BuildNumber
  gpus          = @((Get-CimInstance Win32_VideoController).Name)
  adapterPresent = [bool]$adapter
  adapterStatus  = if ($adapter) { [string]$adapter.Status } else { $null }
}`;

export async function runPreflight(config: Config): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const services = await listNetworkServices();
  const macService = services.find((s) => s.name === config.mac.serviceName);
  results.push({
    name: "service-mac",
    ok: Boolean(macService?.enabled),
    blocking: true,
    detail: !macService
      ? `aucun service réseau nommé «\u00a0${config.mac.serviceName}\u00a0». Adaptateur USB débranché\u00a0?`
      : macService.enabled
        ? `service «\u00a0${config.mac.serviceName}\u00a0» sur ${macService.device}`
        : `service «\u00a0${config.mac.serviceName}\u00a0» désactivé dans les Réglages Réseau`,
  });

  let facts: RemoteFacts | undefined;
  try {
    const rows = await runRemoteJson<RemoteFacts>(
      config.ssh,
      FACTS(config.windows.interfaceAlias),
    );
    facts = rows[0];
    results.push({
      name: SSH_CHECK,
      ok: Boolean(facts),
      blocking: true,
      detail: facts ? `PC joignable sur ${config.ssh.host}` : "réponse vide du PC",
    });
  } catch (error) {
    results.push({
      name: SSH_CHECK,
      ok: false,
      blocking: true,
      detail: `PC injoignable sur ${config.ssh.host}\u00a0: ${errorMessage(error)}`,
    });
  }

  // Sans SSH, toute vérification distante échouerait pour la même raison.
  // On s'arrête là plutôt que d'aligner des échecs redondants.
  if (!facts) return results;

  results.push({
    name: "windows-version",
    ok: facts.build === EXPECTED_BUILD,
    blocking: false,
    detail: `${facts.caption} build ${facts.build}${
      facts.build === EXPECTED_BUILD ? "" : ` (référence\u00a0: ${EXPECTED_BUILD})`
    }`,
  });

  const nvidia = facts.gpus.find((name) => /nvidia/i.test(name));
  results.push({
    name: "gpu",
    ok: Boolean(nvidia),
    blocking: true,
    detail: nvidia ?? `aucun GPU NVIDIA parmi\u00a0: ${facts.gpus.join(", ")}`,
  });

  const linkUp = facts.adapterPresent && facts.adapterStatus === "Up";
  results.push({
    name: "lien-windows",
    ok: linkUp,
    blocking: true,
    detail: linkUp
      ? `interface «\u00a0${config.windows.interfaceAlias}\u00a0» active`
      : `interface «\u00a0${config.windows.interfaceAlias}\u00a0» en état ${facts.adapterStatus ?? "absent"}. Vérifier le câble.`,
  });

  return results;
}

export function hasBlockingFailure(results: CheckResult[]): boolean {
  return results.some((r) => !r.ok && r.blocking);
}

const PROBE_INTERVAL_MS = 5_000;

/**
 * Attend que le PC reponde en SSH, au plus jusqu'a l'echeance. L'echeance est
 * mesuree en temps reel : une sonde qui echoue coute le delai de connexion SSH,
 * et compter les seules pauses ferait durer une attente annoncee a dix minutes
 * bien plus longtemps. `sleep` et `now` sont injectables pour que les tests
 * n'attendent pas reellement.
 */
export async function waitForRemote(
  config: Config,
  deadlineMs: number,
  sleep: (ms: number) => Promise<void> = Bun.sleep,
  now: () => number = Date.now,
): Promise<boolean> {
  const deadline = now() + deadlineMs;

  for (;;) {
    try {
      await runRemoteJson(config.ssh, "[pscustomobject]@{ ok = $true }");
      return true;
    } catch {
      if (now() + PROBE_INTERVAL_MS >= deadline) return false;
      await sleep(PROBE_INTERVAL_MS);
    }
  }
}
