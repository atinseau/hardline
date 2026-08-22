import {
  link,
  mkdir,
  readFile,
  rename,
  stat,
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
 * Le verrou date-t-il d'avant le dernier demarrage de la machine ?
 *
 * La comparaison est SIGNEE, et c'est la substance de cette fonction. Un
 * redemarrage ne peut que faire AVANCER l'instant de demarrage : un instant
 * enregistre dans le futur n'est pas une preuve, c'est de la derive d'horloge.
 * Une valeur absolue rendait vrai un pas d'horloge dans les deux sens.
 *
 * Ce que cette fonction rend n'autorise RIEN : elle ne sert qu'a enrichir le
 * message. Voir isReclaimable.
 */
function predatesLastBoot(holder: LockHolder): boolean {
  if (holder.bootedAt === null) return false;
  const recorded = Date.parse(holder.bootedAt);
  if (!Number.isFinite(recorded)) return false;
  return bootInstantMs() - recorded > BOOT_DRIFT_MS;
}

/**
 * Un verrou est reprenable sur une seule preuve : le processus nomme n'existe
 * plus.
 *
 * Le temps ne peut jamais servir de preuve, et c'est un arbitrage, pas un oubli.
 * bootInstantMs melange deux horloges : celle du noyau, monotone, et celle du
 * mur, corrigible a tout instant par le reseau. Un pas d'horloge d'une minute
 * pendant qu'une installation attend l'amorcage rendait alors un verrou VIVANT
 * reprenable, et deux executions ecrivaient le manifeste ensemble. C'est la
 * perte de donnees d'origine, ressuscitee par la preuve censee la fermer.
 *
 * L'arbitrage est desequilibre, donc facile : voler un verrou tenu, c'est une
 * double ecriture silencieuse ; refuser a tort, c'est un rm que le message
 * epelle deja. Le temps reste donc une information : predatesLastBoot le dit
 * dans le message, ce qui rend la suppression manifestement sans risque a qui
 * la lit. Jamais une autorisation.
 */
function isReclaimable(holder: LockHolder): boolean {
  return !isAlive(holder.pid);
}

/**
 * Le chemin du verrou est dans le message, comme il l'est dans celui d'un
 * verrou illisible. Un outil capable de se refuser a son proprietaire doit lui
 * dire comment revenir : sans ce chemin, un pid recycle ou un cas non prevu
 * laisse l'utilisateur devant un refus definitif et muet.
 */
function heldMessage(holder: LockHolder, path: string): string {
  // Le temps n'autorise aucune reprise, mais il renseigne : un verrou anterieur
  // au dernier demarrage ne peut appartenir a aucun processus vivant, et le
  // dire rend la suppression manifestement sans risque a qui la lit.
  const perime = predatesLastBoot(holder)
    ? " Ce verrou est antérieur au dernier démarrage de la machine, donc le " +
      "processus qui porte ce numéro aujourd'hui n'est pas celui qui l'a posé."
    : "";

  return (
    `Une autre exécution de hardline est en cours (processus ${holder.pid}, ` +
    `démarré le ${holder.startedAt})\u00a0: attendre qu'elle se termine.${perime} ` +
    `Si aucune ne tourne, supprimer ${path}. Rien n'a été modifié.`
  );
}

/**
 * Le verrou a change de mains pendant qu'on le regardait. Ne JAMAIS conseiller
 * de le supprimer ici : le fichier qu'on vient de voir disparaitre est en train
 * d'etre repose par un rival legitime, et le conseil ouvrirait le trou que ce
 * verrou existe pour fermer.
 */
function contendedMessage(path: string): string {
  return (
    `Une autre exécution de hardline vient de prendre le verrou ${path}\u00a0: ` +
    `relancer la commande une fois qu'elle sera terminée. Rien n'a été modifié.`
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
  // Deux choses rendent le verrou, et la seconde n'est pas redondante.
  //
  // Le `finally` de l'appelant le rend dans tous les cas ordinaires, succes
  // comme echec. Le gestionnaire ci-dessous couvre celui que le `finally` ne
  // voit jamais : pendant un indicateur d'activite, la bibliotheque d'affichage
  // installe block() (@clack/prompts/dist/index.mjs:988), dont le gestionnaire
  // de touches appelle process.exit(0) sur Ctrl+C
  // (@clack/core/dist/index.mjs:144). Le processus meurt alors immediatement,
  // sans derouler un seul `finally`. C'est l'interruption la plus probable d'un
  // hardline install, et ce gestionnaire est alors la SEULE chose qui rende le
  // verrou : il est porteur, pas decoratif.
  //
  // Ce qu'il ne rattrape pas : une mise a mort du processus, une coupure de
  // courant, un plantage du runtime, un Ctrl+C hors indicateur. Rien n'y est
  // execute. Un verrou orphelin reste donc un etat prevu, que la reprise sur
  // preuve rattrape.
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
 * La regle qui gouverne toute cette fonction : ON NE DETRUIT RIEN QU'ON N'AIT
 * PROUVE ETRE L'ORPHELIN. Les deux versions precedentes la violaient, chacune a
 * sa facon, et laissaient deux executions tenir le verrou ensemble :
 *
 *  - `unlink` inconditionnel : deux pretendants ayant constate le meme orphelin
 *    le reussissaient tous les deux, et la perdante effacait le verrou tout neuf
 *    de la gagnante ;
 *  - `rename` vers un nom unique : la saisie devenait exclusive, mais elle
 *    DEPLACAIT le fichier avant de le lire. Arrivee apres qu'un gagnant a
 *    republie, elle emportait un verrou vivant ; la remise en place echouait des
 *    qu'un troisieme pretendant avait pris le nom libere, et l'echec etait
 *    avale. Trois executions suffisaient a en laisser deux detentrices.
 *
 * D'ou la forme actuelle, en trois temps dont les deux premiers ne touchent a
 * rien :
 *
 *  1. `link` donne un SECOND NOM au fichier present. Rien n'est deplace, rien
 *     n'est efface, `path` reste exactement ce qu'il etait. Une execution qui
 *     s'arrete ici (parce que ce n'est pas l'orphelin, ou parce qu'elle meurt)
 *     n'a rien abime.
 *  2. On lit ce second nom. Ce n'est pas l'orphelin constate ? On lache le nom
 *     et on cede, sans avoir rien detruit.
 *  3. On verifie que `path` designe TOUJOURS ce fichier (meme inode, meme
 *     peripherique) avant l'unique geste destructeur de la fonction.
 *
 * Il reste une fenetre, entre la verification et l'unlink : deux appels systeme
 * consecutifs, sans rien entre eux. Elle ne peut pas etre fermee sans verrou
 * noyau, et fs.constants.O_EXLOCK n'existe pas sous Bun 1.4.0. Elle est nommee
 * ici plutot que tue, et il n'y a plus de branche silencieuse : un seul geste
 * detruit, et il vient apres la preuve.
 */
async function reclaim(path: string, orphan: LockHolder): Promise<boolean> {
  stagingCounter += 1;
  const witness = `${path}.stale.${process.pid}.${stagingCounter}`;

  try {
    await link(path, witness);
  } catch {
    // Plus rien a ce nom : une autre execution est passee avant nous. Elle a
    // gagne le droit de reprendre, pas nous, et nous n'avons touche a rien.
    return false;
  }

  try {
    const seen = await readHolder(witness);
    if (!seen || !sameHolder(seen, orphan)) return false;

    const [atPath, atWitness] = await Promise.all([stat(path), stat(witness)]);
    if (atPath.ino !== atWitness.ino || atPath.dev !== atWitness.dev) {
      return false;
    }

    await unlink(path);
    return true;
  } catch {
    // Disparu sous nos pieds : quelqu'un d'autre a fait le travail.
    return false;
  } finally {
    // Notre nom de travail, et lui seul. Quand la reprise a abouti, c'est le
    // dernier nom de l'orphelin et il disparait avec lui ; quand elle a cede,
    // `path` garde le sien et ne perd qu'un lien surnumeraire.
    await forget(witness);
  }
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
 * n'est repris que sur PREUVE que son detenteur n'existe plus : le pid ne
 * correspond a aucun processus. Un verrou dont le detenteur vit encore n'est
 * jamais vole, et un verrou illisible n'est pas vole non plus : voler un verrou
 * tenu serait exactement le degat que ce verrou existe pour empecher. Dans les
 * deux cas le message nomme le fichier, pour que le refus n'ait jamais le
 * dernier mot.
 *
 * --- Les trois classes de residus, en un seul endroit ---------------------
 *
 * Aucune n'est jamais relue par le programme : readManifest, manifestLockPath
 * et readHolder travaillent sur des chemins exacts, et src/ n'enumere aucun
 * repertoire. Un residu est donc inerte, quel qu'il soit.
 *
 *  - manifest.json.<pid>.tmp : l'ecriture atomique du manifeste. Renomme sur le
 *    manifeste des qu'il est complet ; ne survit qu'a une mort du processus
 *    pendant l'ecriture.
 *  - manifest.json.lock.<pid>.<n>.tmp : le contenu du verrou avant sa
 *    publication par lien dur. Efface immediatement apres ; ne survit qu'a une
 *    mort entre l'ecriture et la publication.
 *  - manifest.json.lock.stale.<pid>.<n> : le second nom pose sur un verrou le
 *    temps de l'examiner. Efface dans tous les cas par le `finally` de reclaim ;
 *    ne survit qu'a une mort pendant l'examen. Contrairement aux deux autres, il
 *    contient le releve d'un verrou qui a reellement existe.
 *
 * Personne ne les efface ensuite : ils sont sans effet, et un nettoyage
 * automatique fonde sur un motif de nom serait le seul code du projet a
 * supprimer un fichier qu'il n'a pas ecrit.
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

  // Reprise cedee, ou nom repris entre-temps. Une derniere tentative, parce que
  // le nom peut etre libre a cet instant precis, puis on dit ce qu'on voit.
  const late = await claim(path);
  if (late) return late;

  const winner = await readHolder(path);
  if (winner) throw new ManifestLockedError(heldMessage(winner, path));
  // Le fichier a disparu entre nos mains : un rival legitime est en train de le
  // reposer. Conseiller de le supprimer ouvrirait le trou.
  throw new ManifestLockedError(contendedMessage(path));
}
