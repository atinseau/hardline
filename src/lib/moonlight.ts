import type { Config } from "../config";
import type { Display } from "./display";

export type StreamOptions = {
  fullscreen: boolean;
  resolution: { width: number; height: number } | null;
  fps: number | null;
};

/** Fonction pure. Compose `moonlight pair <hote> --pin <code>`. */
export function pairArgs(config: Config, pin: string): string[] {
  return ["pair", config.ssh.host, "--pin", pin];
}

/**
 * Fonction pure. Compose la ligne de streaming a partir de l'ecran et des
 * options. Les options gagnent quand elles sont fournies, l'ecran sert de
 * defaut, et quand aucun ecran n'est detecte et qu'aucune option n'impose de
 * definition, aucune option de definition n'est passee du tout : Moonlight se
 * debrouille seul.
 */
export function streamArgs(
  config: Config,
  display: Display | null,
  options: StreamOptions,
): string[] {
  const args = [
    "stream",
    config.ssh.host,
    config.moonlight.app,
    "--display-mode",
    options.fullscreen ? "fullscreen" : "windowed",
  ];

  const resolution =
    options.resolution ??
    (display ? { width: display.widthPx, height: display.heightPx } : null);
  if (resolution) {
    args.push("--resolution", `${resolution.width}x${resolution.height}`);
  }

  const fps = options.fps ?? (display ? display.refreshHz : null);
  if (fps !== null) {
    args.push("--fps", String(fps));
  }

  return args;
}

/** Fonction pure. Compose `moonlight quit <hote>`. */
export function quitArgs(config: Config): string[] {
  return ["quit", config.ssh.host];
}

// --- Frontiere systeme. ---

/** Lance l'appairage sans attendre sa fin. */
export function spawnPair(config: Config, pin: string): { kill(): void } {
  const proc = Bun.spawn([config.moonlight.binary, ...pairArgs(config, pin)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return { kill: () => proc.kill() };
}

/** Lance le flux et attend sa fin. Rend le code de sortie. */
export async function runStream(
  config: Config,
  display: Display | null,
  options: StreamOptions,
): Promise<number> {
  const proc = Bun.spawn(
    [config.moonlight.binary, ...streamArgs(config, display, options)],
    { stdout: "inherit", stderr: "inherit" },
  );
  return await proc.exited;
}

/** Clot la session cote serveur. */
export async function runQuit(config: Config): Promise<void> {
  const proc = Bun.spawn([config.moonlight.binary, ...quitArgs(config)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}
