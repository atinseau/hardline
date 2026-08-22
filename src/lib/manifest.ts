import {
  link,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, uptime } from "node:os";

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
      `Manifeste illisible\u00a0: ${path} n'est pas un JSON valide. Ne pas le ` +
        `supprimer sans l'inspecter, il décrit ce que hardline a modifié sur les ` +
        `deux machines.`,
    );
  }

  // Un cast sans verification laisserait la desinstallation restaurer des
  // valeurs dont elle ignore la forme. Mieux vaut refuser franchement.
  if (!isManifest(parsed)) {
    throw new Error(
      `Manifeste invalide\u00a0: ${path} ne correspond pas au format attendu (version 1).`,
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

/**
 * Qui detient le verrou.
 *
 * `pid` seul ne suffit pas a identifier un detenteur : les pid sont recycles,
 * et macOS les redistribue depuis le bas apres un demarrage. Un verrou orphelin
 * laisse avant un redemarrage a donc toutes les chances de nommer, apres, un
 * processus etranger bien vivant, et l'outil se refusait alors a lui-meme,
 * definitivement, en accusant un inconnu. `bootedAt` est ce qui manquait :
 * l'instant du demarrage de la machine ou le verrou a ete pose.
 */
type LockHolder = {
  pid: number;
  startedAt: string;
  /** null pour un verrou pose par une version anterieure de hardline. */
  bootedAt: string | null;
};

async function readHolder(path: string): Promise<LockHolder | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate["pid"] !== "number") return null;
    const bootedAt = candidate["bootedAt"];
    return {
      pid: candidate["pid"],
      startedAt: String(candidate["startedAt"] ?? "date inconnue"),
      bootedAt: typeof bootedAt === "string" ? bootedAt : null,
    };
  } catch {
    return null;
  }
}

/** Deux lectures decrivent-elles le MEME verrou, et non deux poses du meme pid. */
function sameHolder(a: LockHolder, b: LockHolder): boolean {
  return (
    a.pid === b.pid && a.startedAt === b.startedAt && a.bootedAt === b.bootedAt
  );
}

/**
 * Tolerance sur l'instant de demarrage. `uptime` est compte par le noyau,
 * `Date.now` peut etre corrige par le reseau en cours de session : la
 * difference des deux derive de quelques secondes au plus. Une minute laisse
 * toute la marge voulue sans jamais declarer vivant un verrou d'avant
 * redemarrage.
 */
const BOOT_DRIFT_MS = 60_000;

function bootInstantMs(): number {
  return Date.now() - uptime() * 1000;
}

/**
 * Le signal 0 ne fait rien : il ne sert qu'a demander au noyau si UN processus
 * porte ce numero. EPERM veut dire qu'il existe mais appartient a quelqu'un
 * d'autre, donc bien vivant. Ce que cette fonction ne sait pas dire, c'est si
 * ce processus est le notre : voir isReclaimable.
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

/**
 * Un verrou est reprenable sur PREUVE, jamais sur presomption. Deux preuves,
 * dans cet ordre :
 *
 *  - la machine a redemarre depuis que le verrou a ete pose. Aucun processus ne
 *    survit a un redemarrage : celui qui est nomme n'existe plus, quoi que
 *    porte son numero aujourd'hui. C'est la preuve qui compte, parce que le
 *    scenario reel est exactement celui-la (Ctrl+C pendant la convergence,
 *    redemarrage, pid reattribue) et que sans elle install et uninstall se
 *    refusaient definitivement en accusant un processus etranger ;
 *  - a defaut, pour un verrou pose par une version anterieure qui n'ecrivait
 *    pas d'instant de demarrage, le pid ne correspond a aucun processus.
 *
 * Reste hors de portee : un pid recycle SANS redemarrage, ce qui suppose
 * d'epuiser les pid de la machine dans la meme session. Le message nomme alors
 * le fichier a supprimer, ce qui ramene le blocage a dix secondes.
 */
function isReclaimable(holder: LockHolder): boolean {
  if (holder.bootedAt !== null) {
    const recorded = Date.parse(holder.bootedAt);
    if (
      Number.isFinite(recorded) &&
      Math.abs(bootInstantMs() - recorded) > BOOT_DRIFT_MS
    ) {
      return true;
    }
  }
  return !isAlive(holder.pid);
}

/**
 * Le chemin du verrou est dans le message, comme il l'est dans celui d'un
 * verrou illisible. Un outil capable de se refuser a son proprietaire doit lui
 * dire comment revenir : sans ce chemin, un pid recycle ou un cas non prevu
 * laisse l'utilisateur devant un refus definitif et muet.
 */
function heldMessage(holder: LockHolder, path: string): string {
  return (
    `Une autre exécution de hardline est en cours (processus ${holder.pid}, ` +
    `démarré le ${holder.startedAt})\u00a0: attendre qu'elle se termine. ` +
    `Si aucune ne tourne, ce processus n'est pas hardline\u00a0: supprimer ` +
    `${path}. Rien n'a été modifié.`
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
  // Ce qui rend le verrou est le `finally` de l'appelant, succes comme echec.
  //
  // Le gestionnaire ci-dessous ne double qu'un cas : un process.exit, qu'aucune
  // commande n'appelle aujourd'hui. Il ne rattrape RIEN d'autre, et surtout pas
  // une mise a mort du processus : un signal non intercepte, une coupure de
  // courant, un plantage du runtime n'executent aucun traitement de sortie. Un
  // verrou orphelin est donc un etat prevu et non un accident a conjurer, et
  // c'est la reprise sur preuve qui le rattrape.
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

/** Distingue deux noms de travail simultanes venus du meme processus. */
let stagingCounter = 0;

/** Un fichier de travail dont la disparition n'est jamais une erreur. */
async function forget(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    /* Deja parti : c'est le resultat voulu. */
  }
}

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
    bootedAt: new Date(bootInstantMs()).toISOString(),
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
    // Le lien dur publie le contenu : le nom de travail ne sert plus.
    await forget(staging);
  }
  return hold(path);
}

/**
 * Reprend un verrou orphelin. Rend true si la reprise nous revient.
 *
 * Le vol passe par `rename` vers un nom UNIQUE, et c'est toute la substance de
 * cette fonction. Deplacer une entree de repertoire est atomique : parmi
 * plusieurs executions qui ont constate le meme orphelin, une seule emporte le
 * fichier, les autres echouent et n'ont rien supprime. `unlink` ne donnait pas
 * cette propriete : deux executions le reussissaient toutes les deux, et la
 * seconde effacait le verrou tout neuf que la premiere venait de publier, si
 * bien que les deux tenaient le manifeste ensemble. C'est exactement le degat
 * que ce verrou existe pour empecher. Le nom de destination est unique parce
 * qu'un nom commun ramenerait le meme defaut : deux renames vers la meme cible
 * reussiraient tous les deux.
 *
 * Reste une fenetre : notre renommage peut arriver APRES qu'un gagnant a
 * republie, et emporter alors un verrou vivant. On relit donc ce qu'on a
 * deplace ; si ce n'est pas l'orphelin constate, on le remet ou il etait et on
 * cede.
 */
async function reclaim(path: string, orphan: LockHolder): Promise<boolean> {
  stagingCounter += 1;
  const aside = `${path}.stale.${process.pid}.${stagingCounter}`;

  try {
    await rename(path, aside);
  } catch {
    // Plus de fichier a ce nom : une autre execution l'a emporte avant nous.
    // Elle a gagne le droit de reprendre, pas nous, et nous n'avons rien
    // supprime.
    return false;
  }

  const moved = await readHolder(aside);
  if (moved && sameHolder(moved, orphan)) {
    await forget(aside);
    return true;
  }

  // Ce n'est pas l'orphelin qu'on avait constate : quelqu'un a republie entre
  // notre lecture et notre renommage. On le remet ou il etait. `link` echoue si
  // un tiers detient deja le verrou, auquel cas il n'y a rien a remettre.
  try {
    await link(aside, path);
  } catch {
    /* Un tiers tient le verrou : le remettre l'ecraserait. */
  }
  await forget(aside);
  return false;
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
 * n'est repris que sur PREUVE que son detenteur n'existe plus : la machine a
 * redemarre depuis, ou le pid ne correspond a aucun processus. Un verrou dont
 * le detenteur vit encore n'est jamais vole, et un verrou illisible n'est pas
 * vole non plus : voler un verrou tenu serait exactement le degat que ce verrou
 * existe pour empecher. Dans les deux cas le message nomme le fichier, pour que
 * le refus n'ait jamais le dernier mot.
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
  if (!isReclaimable(holder)) {
    throw new ManifestLockedError(heldMessage(holder, path));
  }

  // Orphelin avere. La reprise elle-meme est atomique : si une autre execution
  // nous coiffe, elle est legitime et on lui cede.
  if (await reclaim(path, holder)) {
    const second = await claim(path);
    if (second) return second;
  }

  const winner = await readHolder(path);
  throw new ManifestLockedError(
    winner ? heldMessage(winner, path) : unreadableMessage(path),
  );
}
