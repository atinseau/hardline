import type { Config } from "../config";
import type { Display } from "./display";

export type StreamOptions = {
  fullscreen: boolean;
  resolution: { width: number; height: number } | null;
  fps: number | null;
  monitor?: boolean;
  /** Debit demande en kbit/s. Absent, il se deduit de la nature du lien. */
  bitrateKbps?: number;
};

/** Plafond experimental accepte par Moonlight 6.1 avec Sunshine/Apollo. */
const DESKTOP_BITRATE_KBPS = 500_000;

/**
 * Ce qu'un lien partage peut porter sans ruiner l'image.
 *
 * Le plafond ci-dessus est un chiffre de cable dedie a un gigabit : personne
 * d'autre ne passe dessus. Sur un reseau partage, le demander revient a
 * saturer le lien, et Moonlight rend alors une image qui saute au lieu d'une
 * image nette. 80 Mbit/s tient sur un Wi-Fi 5 GHz correct pour du bureau en
 * 4:4:4, et `--bitrate` reste la pour le corriger a la hausse comme a la
 * baisse : aucun chiffre pose ici ne connait la maison de l'utilisateur.
 */
const SHARED_BITRATE_KBPS = 80_000;

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
    // La RTX 4090 sait encoder HEVC 4:4:4 mais pas AV1 4:4:4. Forcer HEVC
    // empeche une preference Moonlight persistante de sacrifier le 4:4:4.
    "--video-codec",
    "HEVC",
    // Apollo ne change la definition du bureau que lorsque le client autorise
    // l'optimisation. L'imposer garantit une capture et un flux de meme taille.
    "--game-optimization",
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

  args.push(
    "--bitrate",
    String(
      options.bitrateKbps ??
        (config.linkKind === "shared" ? SHARED_BITRATE_KBPS : DESKTOP_BITRATE_KBPS),
    ),
  );

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

export function spawnPair(
  config: Config,
  pin: string,
): { ready: Promise<void>; said(): Promise<string>; kill(): void } {
  // Moonlight etait lance muet. Quand l'appairage n'aboutissait pas, il ne
  // restait que « le client n'apparait pas », sans la seule piste utile : la
  // premiere chose que Moonlight ecrit est le chemin de son journal.
  const proc = Bun.spawn([config.moonlight.binary, ...pairArgs(config, pin)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    // Moonlight detache son journal puis initialise la session GameStream.
    // Apollo rejette un PIN envoye avant la fin de cette initialisation.
    // Le tout premier lancement qui suit l'installation du cask est le plus
    // lent : c'est celui qui decide de la marge.
    ready: new Promise((resolve) => setTimeout(resolve, 6_000)),
    said: async () => {
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return `${out}${err}`.trim();
    },
    kill: () => proc.kill(),
  };
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
