import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
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

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate["version"] === 1 &&
    Array.isArray(candidate["order"]) &&
    typeof candidate["steps"] === "object" &&
    candidate["steps"] !== null
  );
}

export async function readManifest(path: string): Promise<Manifest> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return emptyManifest(new Date().toISOString());
  }

  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    throw new Error(
      `Manifeste illisible : ${path} n'est pas un JSON valide. Ne pas le supprimer sans l'inspecter, il decrit ce que hardline a modifie sur les deux machines.`,
    );
  }

  // Un cast sans verification laisserait la desinstallation restaurer des
  // valeurs dont elle ignore la forme. Mieux vaut refuser franchement.
  if (!isManifest(parsed)) {
    throw new Error(
      `Manifeste invalide : ${path} ne correspond pas au format attendu (version 1).`,
    );
  }

  return parsed;
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

// --- Exclusion mutuelle entre executions. --------------------------------

/**
 * Levee quand une autre execution detient le verrou. Une classe nommee, plutot
 * qu'un message reconnu au jugement : l'appelant doit pouvoir distinguer "un
 * autre hardline tourne" de "le disque a refuse", et ne sortir proprement que
 * dans le premier cas.
 */
export class ManifestLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestLockedError";
  }
}

export type ManifestLock = {
  /** Idempotent : appeler deux fois ne doit pas lever. */
  release(): Promise<void>;
};

export function manifestLockPath(manifestPath: string): string {
  return `${manifestPath}.lock`;
}

/** Qui detient le verrou. Ecrit dedans pour que le message puisse le nommer. */
type LockHolder = { pid: number; startedAt: string };

async function readHolder(path: string): Promise<LockHolder | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate["pid"] !== "number") return null;
    return {
      pid: candidate["pid"],
      startedAt: String(candidate["startedAt"] ?? "date inconnue"),
    };
  } catch {
    return null;
  }
}

/**
 * Le signal 0 ne fait rien : il ne sert qu'a demander au noyau si le processus
 * existe. EPERM veut dire qu'il existe mais appartient a quelqu'un d'autre,
 * donc bien vivant. Les deux machines etant les memes d'une execution a
 * l'autre, c'est une reponse fiable ici.
 */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function heldMessage(holder: LockHolder): string {
  return (
    `Une autre exécution de hardline est en cours (processus ${holder.pid}, ` +
    `démarré le ${holder.startedAt}). Attendre qu'elle se termine\u00a0; ` +
    `rien n'a été modifié.`
  );
}

function unreadableMessage(path: string): string {
  return (
    `Une autre exécution de hardline semble en cours\u00a0: le verrou ${path} ` +
    `existe mais ne nomme aucun processus. Le supprimer s'il ne correspond à ` +
    `plus rien. Rien n'a été modifié.`
  );
}

function hold(path: string): ManifestLock {
  // La bibliotheque d'affichage intercepte Ctrl+C pendant un indicateur
  // d'activite et termine le processus immediatement et de facon synchrone :
  // aucun traitement asynchrone n'a lieu. Un filet synchrone sur 'exit' est
  // donc le seul qui tienne, et c'est exactement le cas qui laisserait sinon
  // un verrou orphelin.
  const onExit = (): void => {
    try {
      unlinkSync(path);
    } catch {
      /* deja parti, ou jamais ecrit : il n'y a rien a sauver ici. */
    }
  };
  process.once("exit", onExit);

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      process.removeListener("exit", onExit);
      try {
        await unlink(path);
      } catch {
        /* Idem : un verrou deja disparu n'est pas une erreur a remonter. */
      }
    },
  };
}

/** Distingue deux poses simultanees venues du meme processus. */
let stagingCounter = 0;

/**
 * Pose le verrou, ou rend null s'il existe deja.
 *
 * Le contenu est ecrit A COTE, puis publie par un lien dur : `link` echoue avec
 * EEXIST si la cible existe, et le verrou apparait donc DEJA REMPLI. Creer un
 * fichier vide en exclusion mutuelle puis l'ecrire laisserait une fenetre ou un
 * concurrent lit un verrou qui ne nomme personne, et le prend pour un verrou
 * abime au lieu d'un verrou tenu.
 */
async function claim(path: string): Promise<ManifestLock | null> {
  const holder: LockHolder = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  stagingCounter += 1;
  const staging = `${path}.${process.pid}.${stagingCounter}.tmp`;
  await writeFile(staging, JSON.stringify(holder), "utf8");

  try {
    await link(staging, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  } finally {
    try {
      await unlink(staging);
    } catch {
      /* Le lien dur publie le contenu : le nom temporaire ne sert plus. */
    }
  }
  return hold(path);
}

/**
 * L'exclusion mutuelle qui manquait au manifeste.
 *
 * `writeManifest` est atomique (fichier temporaire puis rename) mais
 * l'atomicite de l'ecriture ne protege pas la sequence lire-modifier-ecrire.
 * Deux `hardline install` lances ensemble lisaient le meme manifeste vide,
 * chacun y ajoutait son etape, et le second effacait l'enregistrement du
 * premier : l'etat anterieur d'une machine disparaissait sans un mot.
 *
 * Le verrou est un fichier voisin du manifeste, cree en exclusion mutuelle par
 * le systeme de fichiers, tenu pour toute la duree de l'execution.
 *
 * Un verrou orphelin, laisse par un processus tue avant d'avoir pu le rendre,
 * n'est repris que sur PREUVE que son detenteur n'existe plus. Un verrou dont le detenteur
 * vit encore n'est jamais vole, et un verrou illisible n'est pas vole non
 * plus : voler un verrou tenu serait exactement le degat que ce verrou existe
 * pour empecher, et le message dit alors quel fichier regarder.
 */
export async function acquireManifestLock(
  manifestPath: string,
): Promise<ManifestLock> {
  const path = manifestLockPath(manifestPath);
  await mkdir(dirname(path), { recursive: true });

  const first = await claim(path);
  if (first) return first;

  const holder = await readHolder(path);
  if (!holder) throw new ManifestLockedError(unreadableMessage(path));
  if (isAlive(holder.pid)) throw new ManifestLockedError(heldMessage(holder));

  // Orphelin avere. On le retire et on retente UNE fois : si une troisieme
  // execution nous a coiffes entre-temps, elle est legitime et on lui cede.
  try {
    await unlink(path);
  } catch {
    /* Un autre l'a deja retire : la tentative suivante tranchera. */
  }

  const second = await claim(path);
  if (second) return second;

  const winner = await readHolder(path);
  throw new ManifestLockedError(
    winner ? heldMessage(winner) : unreadableMessage(path),
  );
}
