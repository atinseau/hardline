import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type StepRecord = {
  step: string;
  appliedAt: string;
  previous: unknown;
};

export type Manifest = {
  version: 1;
  createdAt: string;
  updatedAt: string;
  order: string[];
  steps: Record<string, StepRecord>;
};

export function defaultManifestPath(): string {
  return join(homedir(), ".config", "hardline", "manifest.json");
}

export function emptyManifest(now: string): Manifest {
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    order: [],
    steps: {},
  };
}

/**
 * Enregistre une etape appliquee. Si l'etape est deja connue, l'etat anterieur
 * d'origine est conserve : rejouer install ne doit jamais faire oublier a
 * hardline ce qu'il a trouve la premiere fois.
 */
export function recordStep(
  manifest: Manifest,
  step: string,
  previous: unknown,
  now: string,
): Manifest {
  const existing = manifest.steps[step];

  return {
    ...manifest,
    updatedAt: now,
    order: existing ? manifest.order : [...manifest.order, step],
    steps: {
      ...manifest.steps,
      [step]: existing ?? { step, appliedAt: now, previous },
    },
  };
}

export function forgetStep(manifest: Manifest, step: string): Manifest {
  const { [step]: _removed, ...rest } = manifest.steps;
  return {
    ...manifest,
    order: manifest.order.filter((s) => s !== step),
    steps: rest,
  };
}

export function stepsInReverseOrder(manifest: Manifest): StepRecord[] {
  return [...manifest.order]
    .reverse()
    .map((name) => manifest.steps[name])
    .filter((r): r is StepRecord => r !== undefined);
}

// --- Frontière fichier. ---

export async function readManifest(path: string): Promise<Manifest> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return emptyManifest(new Date().toISOString());
  }
  return (await file.json()) as Manifest;
}

/**
 * Ecriture atomique : Bun.write ne l'est pas, et le manifeste est precisement
 * ce dont depend la desinstallation. On ecrit a cote puis on renomme, rename
 * etant atomique sur un meme volume.
 */
export async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest, null, 2), "utf8");
  await rename(temporary, path);
}
