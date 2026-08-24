import { $ } from "bun";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Display = {
  /** Definition reelle en pixels. */
  widthPx: number;
  heightPx: number;
  /** Frequence en hertz. 0 quand le systeme ne la rapporte pas. */
  refreshHz: number;
  /** Taille en points, c'est-a-dire l'echelle vue par l'interface. */
  widthPt: number;
  heightPt: number;
  /** L'ecran ou s'ouvre une fenetre neuve. */
  main: boolean;
  /** Profil ColorSync actif, et conformite minimale display/RGB. */
  colorProfile: string | null;
  colorProfileValid: boolean;
};

const FIELD_COUNT = 8;

/** Fonction pure. Lit la sortie de la sonde, une ligne par ecran. */
export function parseDisplays(stdout: string): Display[] {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const displays: Display[] = [];

  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== FIELD_COUNT) continue;

    const [
      widthPx,
      heightPx,
      refreshHz,
      widthPt,
      heightPt,
      main,
      colorProfile,
      colorProfileValid,
    ] = fields;

    displays.push({
      widthPx: Number(widthPx),
      heightPx: Number(heightPx),
      refreshHz: Number(refreshHz),
      widthPt: Number(widthPt),
      heightPt: Number(heightPt),
      main: main === "1",
      colorProfile: colorProfile === "-" ? null : colorProfile!,
      colorProfileValid: colorProfileValid === "1",
    });
  }

  return displays;
}

/** null quand le profil actif convient a un flux SDR RGB. */
export function colorProfileIssue(display: Display): string | null {
  if (display.colorProfile === null) {
    return "No active color profile was detected for this display.";
  }
  if (!display.colorProfileValid) {
    return `Color profile '${display.colorProfile}' may be unsuitable for an RGB display.`;
  }
  return null;
}

/** L'ecran principal, ou le premier a defaut, ou null si aucun. */
export function mainDisplay(displays: Display[]): Display | null {
  return displays.find((display) => display.main) ?? displays[0] ?? null;
}

/**
 * Levee quand la sonde s'execute mais echoue (code de sortie non nul). Une
 * liste vide de listDisplays doit rester la preuve que la sonde a tourne et
 * n'a rien vu, jamais la consequence silencieuse d'un binaire absent ou
 * corrompu, ou d'un appel CoreGraphics en echec.
 */
export class DisplayProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisplayProbeError";
  }
}

// --- Frontiere systeme. Aucune logique ici, seulement l'extraction et l'appel. ---

export async function listDisplays(): Promise<Display[]> {
  // Import dynamique et non statique : un import statique en tete de fichier
  // ferait echouer le chargement du module entier des que le binaire compile
  // est absent, ce qui casserait les tests des fonctions pures ci-dessus tant
  // que `bun run build` n'a pas tourne une fois.
  const probe = await import("../assets/display-probe.bin", {
    with: { type: "file" },
  });
  const embeddedPath: string = probe.default;

  const tmpPath = join(tmpdir(), `hardline-display-probe-${randomUUID()}`);
  await Bun.write(tmpPath, Bun.file(embeddedPath));
  await $`chmod +x ${tmpPath}`.quiet().nothrow();

  try {
    const result = await $`${tmpPath}`.quiet().nothrow();
    if (result.exitCode !== 0) {
      throw new DisplayProbeError(`Display probe failed with exit code ${result.exitCode}.`);
    }
    return parseDisplays(result.stdout.toString());
  } finally {
    await $`rm -f ${tmpPath}`.quiet().nothrow();
  }
}
