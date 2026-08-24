import type { Config } from "../config";
import type { Display } from "./display";

export type StreamOptions = {
  fullscreen: boolean;
  resolution: { width: number; height: number } | null;
  fps: number | null;
  monitor?: boolean;
};

const BITRATE_STEPS = [
  { pixels: 640 * 360, factor: 1 },
  { pixels: 854 * 480, factor: 2 },
  { pixels: 1280 * 720, factor: 5 },
  { pixels: 1920 * 1080, factor: 10 },
  { pixels: 2560 * 1440, factor: 20 },
  { pixels: 3840 * 2160, factor: 40 },
] as const;

/** Le debit recommande par Moonlight, double pour la chrominance 4:4:4. */
export function desktopBitrateKbps(width: number, height: number, fps: number): number {
  const pixels = width * height;
  let resolutionFactor = BITRATE_STEPS.at(-1)!.factor;

  for (let i = 0; i < BITRATE_STEPS.length; i++) {
    const upper = BITRATE_STEPS[i]!;
    if (pixels === upper.pixels || i === 0) {
      resolutionFactor = upper.factor;
      if (pixels <= upper.pixels) break;
      continue;
    }
    if (pixels < upper.pixels) {
      const lower = BITRATE_STEPS[i - 1]!;
      const position = (pixels - lower.pixels) / (upper.pixels - lower.pixels);
      resolutionFactor = lower.factor + position * (upper.factor - lower.factor);
      break;
    }
  }

  // Moonlight croit encore etre en 4:2:0 quand il calcule son debit, car son
  // parseur applique --yuv444 apres ce calcul. Le facteur deux corrige cet
  // ordre et reprend son propre cout estime pour le 4:4:4.
  resolutionFactor *= 2;
  const frameRateFactor = (fps <= 60 ? fps : Math.sqrt(fps / 60) * 60) / 30;
  return Math.round(resolutionFactor * frameRateFactor) * 1000;
}

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
    // Le curseur du Mac n'est plus capture par la fenetre : on en sort comme
    // de n'importe quelle autre. Moonlight decrit lui-meme ce mode comme
    // « optimise pour le bureau a distance » ; sans lui, il faut connaitre
    // Ctrl+Alt+Shift+Z pour recuperer sa souris, ce qui est exactement le
    // genre de detail que hardline existe pour eviter. Contrepartie assumee :
    // la souris relative des jeux en vue subjective ne fonctionne pas dans ce
    // mode — hardline sert a travailler sur le PC, pas a y jouer.
    "--absolute-mouse",
    // 4:4:4 transmet la chrominance a pleine resolution. Par defaut, le flux
    // est en 4:2:0 : la couleur est sous-echantillonnee d'un facteur deux en
    // largeur ET en hauteur, ce qui suffit a une image filmee mais fait baver
    // le texte fin et colore — du code, une interface. C'est le seul reglage
    // qui change vraiment la nettete d'un bureau distant. Moonlight le
    // demande « si le serveur le sait faire » et retombe seul en 4:2:0 sinon,
    // donc le passer n'est jamais un pari.
    "--yuv444",
  ];

  if (options.monitor) {
    args.push("--performance-overlay");
  }

  const resolution =
    options.resolution ??
    (display ? { width: display.widthPx, height: display.heightPx } : null);
  if (resolution) {
    args.push("--resolution", `${resolution.width}x${resolution.height}`);
  }

  const fps = options.fps ?? (display && display.refreshHz > 0 ? display.refreshHz : null);
  if (fps !== null) {
    args.push("--fps", String(fps));
  }

  if (resolution && fps !== null) {
    args.push("--bitrate", String(desktopBitrateKbps(resolution.width, resolution.height, fps)));
  }

  return args;
}

/** Fonction pure. Compose `moonlight quit <hote>`. */
export function quitArgs(config: Config): string[] {
  return ["quit", config.ssh.host];
}

// --- Frontiere systeme. ---

/** Lance l'appairage sans attendre sa fin. */
/** Fonction pure. La ligne qui interroge les applications d'un hote. */
export function listArgs(config: Config): string[] {
  return ["list", config.ssh.host];
}

/**
 * Ce Mac est-il deja appaire avec le PC ?
 *
 * `moonlight list` exige l'appairage : il rend 0 et enumere les applications
 * quand ce Mac est appaire, et 255 avec « n'a pas ete couple » sinon. C'est
 * le SEUL signal fiable cote Mac — `serverinfo?uniqueid=…` rend PairStatus=0
 * meme pour un client appaire, parce que ce champ ne vaut que sur la requete
 * HTTPS portant le certificat client, que curl ne presente pas.
 *
 * Pourquoi c'est indispensable : quand ce Mac est deja appaire,
 * `moonlight pair` n'a rien a faire et sort SANS RIEN DIRE. Le code y voyait
 * un appairage qui echoue, et l'etape rendait « hardline-mac n'apparait pas »
 * sans jamais nommer la vraie cause.
 *
 * Le delai plafond evite qu'un Moonlight qui n'aboutit pas retienne l'etape
 * indefiniment ; un depassement se lit « pas appaire », le cas ou l'on agit.
 */
export async function isPairedFromMac(
  config: Config,
  deadlineMs = 30_000,
): Promise<boolean> {
  const proc = Bun.spawn([config.moonlight.binary, ...listArgs(config)], {
    stdout: "ignore",
    stderr: "ignore",
  });

  const code = await Promise.race([
    proc.exited,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), deadlineMs)),
  ]);

  if (code === null) {
    proc.kill();
    return false;
  }
  return code === 0;
}

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
    {
      stdout: "inherit",
      stderr: "inherit",
      // Le renderer Metal de Moonlight 6.1 annonce sinon Rec.601 limite au
      // serveur. La capture Windows est RGB complet Rec.709 : demander la meme
      // conversion evite d'ecraser les noirs et de deplacer les couleurs.
      env: {
        ...process.env,
        COLOR_SPACE_OVERRIDE: "1", // COLORSPACE_REC_709
        COLOR_RANGE_OVERRIDE: "1", // COLOR_RANGE_FULL
      },
    },
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
