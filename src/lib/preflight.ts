import { readFile } from "node:fs/promises";
import { listNetworkServices } from "./shell";
import { runRemoteJson } from "./ssh";
import { errorMessage } from "./errors";
import { psQuote } from "./powershell";
import type { Config } from "../config";

export type CheckResult = {
  name: string;
  ok: boolean;
  /** Un échec bloquant arrête l'installation avant toute modification. */
  blocking: boolean;
  /**
   * Vrai quand la verification est une precondition de l'INSTALLATION et ne dit
   * rien de la sante de la liaison. `doctor` la montre sans la compter : son
   * code de sortie est fait pour etre scripte, et une liaison qui fonctionne ne
   * doit pas sortir en 1 parce qu'une reinstallation demanderait un fichier de
   * plus. Le champ vit ici, sur la verification elle-meme, parce que c'est une
   * propriete de ce qu'elle observe et non de qui la lit : une liste tenue a
   * part devrait etre resynchronisee par chaque appelant qui ajoute un controle.
   */
  installOnly: boolean;
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

/**
 * La cle publique deposee sur le PC par l'amorcage. Son chemin se deduit de la
 * cle privee : une seule source, celle de la configuration.
 */
export function publicKeyPath(config: Config): string {
  return `${config.ssh.identityFile}.pub`;
}

/** Le message qui dit comment creer la cle, partage avec la commande install. */
export function missingPublicKeyMessage(config: Config): string {
  return (
    `Public key is missing or empty: ${publicKeyPath(config)}. Create it with ` +
    `'ssh-keygen -t ed25519 -f ${config.ssh.identityFile}'.`
  );
}

/** Nom de la verification de la cle publique, partage avec la commande install. */
export const PUBLIC_KEY_CHECK = "cle-publique";

const EXPECTED_BUILD = 26200;

const FACTS = (alias: string) => `
$os = Get-CimInstance Win32_OperatingSystem
$adapter = Get-NetAdapter -Name ${psQuote(alias, "alias de l'interface Windows")} -ErrorAction SilentlyContinue
[pscustomobject]@{
  caption       = [string]$os.Caption
  build         = [int]$os.BuildNumber
  gpus          = @((Get-CimInstance Win32_VideoController).Name)
  adapterPresent = [bool]$adapter
  adapterStatus  = if ($adapter) { [string]$adapter.Status } else { $null }
}`;

/**
 * Preconditions observables sans toucher au reseau : le service du Mac existe
 * et son adaptateur est branche. Bloquante, et rien n'est modifie avant
 * qu'elle passe.
 */
export async function runLocalPreflight(config: Config): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const services = await listNetworkServices();
  const macService = services.find((s) => s.name === config.mac.serviceName);
  results.push({
    name: "service-mac",
    ok: Boolean(macService?.enabled),
    blocking: true,
    // Sans ce service, le Mac n'a pas d'interface sur le lien direct : c'est
    // bien la sante de la liaison qui est en cause.
    installOnly: false,
    detail: !macService
      ? `no network service named '${config.mac.serviceName}'. Is the USB adapter disconnected?`
      : macService.enabled
        ? `service '${config.mac.serviceName}' on ${macService.device}`
        : `service '${config.mac.serviceName}' is disabled in Network Settings`,
  });

  // L'amorcage depose cette cle sur le PC. Sa presence est une precondition
  // purement locale : la constater ici, c'est arreter avant toute modification
  // plutot qu'apres la convergence du Mac, quand il est trop tard pour dire
  // que rien n'a bouge.
  let key = "";
  try {
    key = (await readFile(publicKeyPath(config), "utf8")).trim();
  } catch {
    key = "";
  }
  results.push({
    name: PUBLIC_KEY_CHECK,
    ok: key.length > 0,
    blocking: true,
    // La cle publique sert a AMORCER le PC. Une fois deposee la-bas, la liaison
    // tient sans elle : la supprimer sur le Mac empeche une reinstallation, pas
    // le lien. Elle bloque install et ne compte pas dans le diagnostic.
    installOnly: true,
    detail:
      key.length > 0
        ? `public key ${publicKeyPath(config)}`
        : missingPublicKeyMessage(config),
  });

  return results;
}

/**
 * Preconditions cote PC. Elles ne sont observables qu'apres la convergence
 * locale : tant que le Mac n'a pas d'adresse sur le lien direct, aucune route
 * ne mene au PC et une sonde SSH partirait par la passerelle Wi-Fi pour
 * expirer, quel que soit l'etat reel du PC.
 */
export async function runRemotePreflight(config: Config): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

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
      installOnly: false,
      detail: facts ? `PC reachable at ${config.ssh.host}` : "empty response from PC",
    });
  } catch (error) {
    results.push({
      name: SSH_CHECK,
      ok: false,
      blocking: true,
      installOnly: false,
      detail: `PC unreachable at ${config.ssh.host}: ${errorMessage(error)}`,
    });
  }

  // Sans SSH, toute vérification distante échouerait pour la même raison.
  // On s'arrête là plutôt que d'aligner des échecs redondants.
  if (!facts) return results;

  results.push({
    name: "windows-version",
    ok: facts.build === EXPECTED_BUILD,
    blocking: false,
    installOnly: false,
    detail: `${facts.caption} build ${facts.build}${
      facts.build === EXPECTED_BUILD ? "" : ` (expected: ${EXPECTED_BUILD})`
    }`,
  });

  const nvidia = facts.gpus.find((name) => /nvidia/i.test(name));
  results.push({
    name: "gpu",
    ok: Boolean(nvidia),
    blocking: true,
    installOnly: false,
    detail: nvidia ?? `no NVIDIA GPU among: ${facts.gpus.join(", ")}`,
  });

  const linkUp = facts.adapterPresent && facts.adapterStatus === "Up";
  results.push({
    name: "lien-windows",
    ok: linkUp,
    blocking: true,
    installOnly: false,
    detail: linkUp
      ? `interface '${config.windows.interfaceAlias}' is active`
      : `interface '${config.windows.interfaceAlias}' is ${facts.adapterStatus ?? "absent"}. Check the cable.`,
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
