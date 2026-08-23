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

export type UpCliOptions = {
  fullscreen: boolean;
  resolution: string | null;
  fps: string | null;
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
 * L'enchainement complet d'une session. Le demontage et l'appel a `moonlight
 * quit` sont dans un `finally` qui englobe le montage ET le flux : une
 * interruption a n'importe quel point apres le premier montage doit encore
 * defaire ce qui a ete monte et fermer la session cote serveur, sans quoi
 * l'ecran virtuel reste sur le PC. unmountShare ne leve jamais pour un
 * partage jamais monte (voir src/lib/smb.ts), ce qui rend sur d'appeler ce
 * nettoyage sur TOUS les partages, meme ceux qu'un montage partiel n'a
 * jamais atteints.
 */
export async function runUp(config: Config, options: StreamOptions): Promise<number> {
  if (!(await pcReachable(config))) {
    await wakePC(config);
  }

  const display = mainDisplay(await listDisplays());
  await ensureApolloRunning(config);

  // Le mot de passe ne quitte jamais cette portee : il part dans mountShare,
  // qui compose l'URL SMB lui-meme et retire le secret de ses propres messages
  // d'erreur. Il n'est ni journalise, ni passe en argument de commande, ni
  // repris dans une erreur d'ici.
  const password = await getSecret("windows-account");
  if (password === null) {
    throw new Error(
      "Aucun mot de passe Windows au trousseau\u00a0: lancer «\u00a0hardline install\u00a0» d'abord.",
    );
  }

  try {
    for (const share of config.smb.shares) {
      await mountShare(share, config, password);
    }
    return await runStream(config, display, options);
  } finally {
    for (const share of config.smb.shares) {
      try {
        await unmountShare(share);
      } catch {
        // Demontage en best effort a la fermeture : un partage qui refuse de
        // se demonter ne doit ni empecher les autres ni empecher la fermeture
        // cote serveur.
      }
    }
    try {
      await runQuit(config);
    } catch {
      // La session doit se fermer cote client quoi qu'il arrive : une erreur
      // ici ne doit pas masquer celle, plus importante, du flux lui-meme.
    }
  }
}

export async function upCommand(_cliOptions: UpCliOptions): Promise<void> {
  throw new Error("non implemente a ce cycle");
}
