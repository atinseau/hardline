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

export async function upCommand(_cliOptions: UpCliOptions): Promise<void> {
  throw new Error("non implemente a ce cycle");
}
