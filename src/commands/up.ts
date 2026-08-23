import { CONFIG, type Config } from "../config";
import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import { lookupMac, sendMagicPacket } from "../lib/wol";
import { waitForRemote } from "../lib/preflight";
import { listDisplays, mainDisplay } from "../lib/display";
import { getSecret } from "../lib/keychain";
import { mountShare, unmountShare } from "../lib/smb";
import { runStream, runQuit, type StreamOptions } from "../lib/moonlight";
import { errorMessage } from "../lib/errors";
import { configureOutput, ui, withSpinner } from "../lib/ui";

const WAKE_DEADLINE_MS = 3 * 60_000;

export type ResolutionOption = { width: number; height: number };

/** Fonction pure. "LARGEURxHAUTEUR" -> les deux entiers, ou leve. */
export function parseResolution(value: string): ResolutionOption {
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) {
    throw new Error(
      `Résolution invalide\u00a0: attendu «\u00a0LARGEURxHAUTEUR\u00a0» (${value})`,
    );
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Fonction pure. Une chaine de frequence en entier positif, ou leve. */
export function parseFps(value: string): number {
  const fps = Number(value);
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new Error(`Fréquence invalide\u00a0: attendu un entier positif (${value})`);
  }
  return fps;
}

/**
 * Les drapeaux tels que commander les rend : une option non passee vaut
 * `undefined`, pas `null`. Le type le dit plutot que de laisser le seul
 * appelant de test decrire la forme reelle.
 */
export type UpCliOptions = {
  fullscreen: boolean;
  resolution?: string | null;
  fps?: string | null;
};

/** Fonction pure. Les drapeaux de la ligne de commande, vers les options de flux. */
export function buildStreamOptions(cli: UpCliOptions): StreamOptions {
  return {
    fullscreen: cli.fullscreen,
    resolution: cli.resolution ? parseResolution(cli.resolution) : null,
    fps: cli.fps ? parseFps(cli.fps) : null,
  };
}

/**
 * Fonction pure. L'adresse de diffusion IPv4 d'un reseau, a partir d'une
 * adresse et d'un masque. Sert a poser le paquet magique sur le bon domaine
 * de diffusion : celui du Mac sur le lien direct, pas celui d'un routeur.
 */
export function broadcastAddress(ip: string, subnetMask: string): string {
  const ipParts = ip.split(".").map(Number);
  const maskParts = subnetMask.split(".").map(Number);
  const valid =
    ipParts.length === 4 &&
    maskParts.length === 4 &&
    ipParts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    maskParts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  if (!valid) {
    throw new Error(
      `Adresse ou masque IPv4 invalide pour le calcul de diffusion\u00a0: ${ip}/${subnetMask}`,
    );
  }
  return ipParts.map((octet, i) => (octet | (~maskParts[i]! & 0xff)) & 0xff).join(".");
}

// --- Frontiere systeme. ---

async function pcReachable(config: Config): Promise<boolean> {
  try {
    await runRemoteJson(config.ssh, "[pscustomobject]@{ ok = $true }");
    return true;
  } catch {
    return false;
  }
}

/**
 * Le paquet magique part sur l'adresse de diffusion du lien direct, calculee
 * a partir de l'adresse du Mac : le poser sur celle d'un routeur ne le ferait
 * jamais atteindre une carte reseau qui dort.
 */
async function wakePC(config: Config): Promise<void> {
  const mac = await lookupMac(config.windows.ip);
  if (!mac) {
    throw new Error(
      `Adresse matérielle introuvable dans la table ARP pour ${config.windows.ip}\u00a0: ` +
        "le PC a-t-il déjà répondu au moins une fois sur ce lien\u00a0?",
    );
  }
  const broadcast = broadcastAddress(config.mac.ip, config.mac.subnetMask);
  await sendMagicPacket(mac, broadcast);

  const woke = await waitForRemote(config, WAKE_DEADLINE_MS);
  if (!woke) {
    throw new Error(
      `Le PC n'a pas répondu dans les ${Math.round(WAKE_DEADLINE_MS / 60_000)} minutes suivant le réveil.`,
    );
  }
}

const APOLLO_STATUS = (name: string) => `
$svc = Get-Service -Name '${name}' -ErrorAction SilentlyContinue
[pscustomobject]@{ status = if ($svc) { [string]$svc.Status } else { $null } }`;

/**
 * Apollo doit tourner avant que le flux ne parte : un serveur arrete rend une
 * erreur de connexion que rien ne distingue d'un PC absent.
 */
async function ensureApolloRunning(config: Config): Promise<void> {
  const rows = await runRemoteJson<{ status: string | null }>(
    config.ssh,
    APOLLO_STATUS(config.apollo.serviceName),
  );
  if (rows[0]?.status === "Running") return;

  await runRemoteChecked(
    config.ssh,
    `Start-Service -Name '${config.apollo.serviceName}'`,
  );

  const recheck = await runRemoteJson<{ status: string | null }>(
    config.ssh,
    APOLLO_STATUS(config.apollo.serviceName),
  );
  if (recheck[0]?.status !== "Running") {
    throw new Error(
      `Le service «\u00a0${config.apollo.serviceName}\u00a0» n'a pas démarré ` +
        `(état\u00a0: ${recheck[0]?.status ?? "inconnu"}).`,
    );
  }
}

/**
 * Enveloppe la phase preparatoire. Meme forme que `withSpinner`, dont c'est
 * le seul emploi legitime ici : la preparation capture toutes ses sorties,
 * le flux non.
 */
export type PreparationWrapper = <T>(
  label: string,
  run: (progress: (message: string) => void) => Promise<T>,
) => Promise<T>;

export type UpHooks = {
  /** Enveloppe la seule phase preparatoire, jamais le flux. */
  withPreparation: PreparationWrapper;
  /** Appele une fois tout pret, juste avant que le flux ne parte. */
  onStreamStart: () => void;
};

const NO_HOOKS: UpHooks = {
  withPreparation: (_label, run) => run(() => {}),
  onStreamStart: () => {},
};

/**
 * L'enchainement complet d'une session.
 *
 * `runStream` lance Moonlight avec les flux du terminal HERITES : il ecrit
 * directement sur stdout et prend le terminal jusqu'a la fermeture de la
 * session. Aucun spinner ne peut tourner par-dessus sans entrelacer son rendu
 * et rester fige sur son libelle (voir le contrat de withSpinner,
 * src/lib/ui.ts). La phase preparatoire — reveil, ecrans, service, montages —
 * capture au contraire tout ce qu'elle lance : c'est elle, et elle seule, que
 * `hooks.withPreparation` enveloppe.
 *
 * Le demontage et l'appel a `moonlight quit` sont dans un `finally` qui
 * englobe le montage ET le flux : une interruption a n'importe quel point
 * apres le premier montage doit encore defaire ce qui a ete monte et fermer la
 * session cote serveur, sans quoi l'ecran virtuel reste sur le PC.
 * unmountShare ne leve jamais pour un partage jamais monte (voir
 * src/lib/smb.ts), ce qui rend sur d'appeler ce nettoyage sur TOUS les
 * partages, meme ceux qu'un montage partiel n'a jamais atteints.
 *
 * `monte` garde la frontiere d'avant : un PC qui ne se reveille jamais n'a
 * rien fait monter, et rien ne doit alors etre demonte ni clos sur une machine
 * qu'on n'a jamais atteinte.
 */
export async function runUp(
  config: Config,
  options: StreamOptions,
  hooks: UpHooks = NO_HOOKS,
): Promise<number> {
  let monte = false;

  try {
    const display = await hooks.withPreparation(
      "Préparation de la session",
      async (progress) => {
        if (!(await pcReachable(config))) {
          progress("réveil du PC");
          await wakePC(config);
        }

        const ecran = mainDisplay(await listDisplays());

        progress("démarrage du service Apollo");
        await ensureApolloRunning(config);

        // Le mot de passe ne quitte jamais cette portee : il part dans
        // mountShare, qui compose l'URL SMB lui-meme et retire le secret de
        // ses propres messages d'erreur. Il n'est ni journalise, ni passe en
        // argument de commande, ni repris dans une erreur d'ici.
        const password = await getSecret("windows-account");
        if (password === null) {
          throw new Error(
            "Aucun mot de passe Windows au trousseau\u00a0: lancer «\u00a0hardline install\u00a0» d'abord.",
          );
        }

        progress("montage des partages");
        monte = true;
        for (const share of config.smb.shares) {
          await mountShare(share, config, password);
        }

        return ecran;
      },
    );

    hooks.onStreamStart();
    return await runStream(config, display, options);
  } finally {
    if (monte) {
      await releaseSession(config);
    }
  }
}

/** Defait ce que la session a monte, puis la clot cote serveur. */
async function releaseSession(config: Config): Promise<void> {
  for (const share of config.smb.shares) {
    try {
      await unmountShare(share);
    } catch {
      // Demontage en best effort a la fermeture : un partage qui refuse de se
      // demonter ne doit ni empecher les autres ni empecher la fermeture cote
      // serveur.
    }
  }
  try {
    await runQuit(config);
  } catch {
    // La session doit se fermer cote client quoi qu'il arrive : une erreur
    // ici ne doit pas masquer celle, plus importante, du flux lui-meme.
  }
}

/**
 * Les options sont validees AVANT la moindre action sur les machines : une
 * definition mal ecrite ne doit pas reveiller un PC pour rien.
 */
export async function upCommand(cliOptions: UpCliOptions): Promise<void> {
  configureOutput();
  ui.start("hardline — up");

  let options: StreamOptions;
  try {
    options = buildStreamOptions(cliOptions);
  } catch (error) {
    ui.failed({ label: "Options", detail: errorMessage(error) });
    ui.finish("Options invalides.");
    process.exitCode = 1;
    return;
  }

  try {
    // Le spinner n'enveloppe que la preparation : Moonlight herite du terminal
    // et le garde jusqu'a la fin de la session.
    const exitCode = await runUp(CONFIG, options, {
      withPreparation: withSpinner,
      onStreamStart: () =>
        ui.info(
          "Session ouverte\u00a0: Moonlight prend le terminal jusqu'à sa fermeture.",
        ),
    });
    ui.finish(
      exitCode === 0 ? "Session terminée." : `Session terminée avec le code ${exitCode}.`,
    );
  } catch (error) {
    ui.failed({ label: "up", detail: errorMessage(error) });
    ui.finish("Échec de l'ouverture de la session.");
    process.exitCode = 1;
  }
}
