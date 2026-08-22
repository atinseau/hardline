import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";

/**
 * La reprise d'un verrou orphelin, vue de tres pres.
 *
 * Deux defauts ont ete fermes ici, du meme genre et de plus en plus etroits :
 *
 *  - `unlink` inconditionnel : deux pretendants ayant constate le meme orphelin
 *    le reussissaient tous les deux, et la perdante effacait le verrou tout neuf
 *    de la gagnante ;
 *  - `rename` vers un nom unique : la saisie devenait exclusive, mais elle
 *    DEPLACAIT le fichier avant de le lire. Arrivee apres qu'un gagnant a
 *    republie, elle emportait un verrou vivant, un troisieme pretendant prenait
 *    le nom libere, la remise en place echouait et l'echec etait avale.
 *
 * Le premier test ci-dessous rejoue cette sequence a trois pretendants contre le
 * code reel. Le mock de `node:fs/promises` ne remplace aucune fonction : il
 * delegue tout aux vraies, et n'injecte que deux points de synchronisation pour
 * que l'entrelacement soit reproductible au lieu d'etre tire au sort.
 */

const realFs = await import("node:fs/promises");
// Capturees AVANT le mock : lues apres coup, elles rendraient le mock lui-meme
// et la delegation serait une recursion infinie.
const linkReel = realFs.link;
const renameReel = realFs.rename;
const unlinkReel = realFs.unlink;
const readFileReel = realFs.readFile;
const writeFileReel = realFs.writeFile;
const mkdtempReel = realFs.mkdtemp;
const rmReel = realFs.rm;
const readdirReel = realFs.readdir;

const renames: string[] = [];
const unlinks: string[] = [];

/** Une barriere a un coup : s'arme, se declenche une fois, puis s'efface. */
function barriere() {
  let armee = false;
  let atteinte!: () => void;
  let liberee!: () => void;
  let attendreAtteinte!: Promise<void>;
  let attendreLiberation!: Promise<void>;

  return {
    armer() {
      armee = true;
      attendreAtteinte = new Promise<void>((r) => (atteinte = r));
      attendreLiberation = new Promise<void>((r) => (liberee = r));
    },
    get armee() {
      return armee;
    },
    /** Appelee depuis le mock : signale, puis attend qu'on la libere. */
    async franchir() {
      armee = false;
      atteinte();
      await attendreLiberation;
    },
    atteinte: () => attendreAtteinte,
    liberer: () => liberee(),
  };
}

/** Juste apres la lecture du detenteur, avant toute tentative de reprise. */
const apresLecture = barriere();
/** Juste apres le geste par lequel la reprise saisit le verrou. */
const apresSaisie = barriere();

let lockPath = "";

mock.module("node:fs/promises", () => ({
  ...realFs,
  readFile: async (path: string, ...reste: never[]) => {
    const contenu = await readFileReel(path, ...reste);
    if (apresLecture.armee && String(path) === lockPath) {
      await apresLecture.franchir();
    }
    return contenu;
  },
  // Les deux gestes par lesquels une reprise peut saisir le verrou : le lien dur
  // de la version actuelle, le renommage de la precedente. La source est le
  // verrou lui-meme, ce qui les distingue du lien dur de `claim`, dont la source
  // est un fichier de travail.
  link: async (from: string, to: string) => {
    await linkReel(from, to);
    if (apresSaisie.armee && String(from) === lockPath) {
      await apresSaisie.franchir();
    }
  },
  rename: async (from: string, to: string) => {
    renames.push(String(from));
    await renameReel(from, to);
    if (apresSaisie.armee && String(from) === lockPath) {
      await apresSaisie.franchir();
    }
  },
  unlink: async (path: string) => {
    unlinks.push(String(path));
    return unlinkReel(path);
  },
}));

import type { ManifestLock } from "../../src/lib/manifest";

const { acquireManifestLock, manifestLockPath } = await import(
  "../../src/lib/manifest"
);

/** Un pid qui ne peut correspondre a aucun processus vivant. */
const PID_MORT = 2_147_483_646;

let dir: string;
let manifestPath: string;

async function poserOrphelin(): Promise<void> {
  await writeFileReel(
    lockPath,
    JSON.stringify({
      pid: PID_MORT,
      startedAt: "2026-08-22T10:00:00.000Z",
      bootedAt: new Date().toISOString(),
    }),
    "utf8",
  );
}

type Tentative = { lock: ManifestLock | null };

async function tenter(): Promise<Tentative> {
  return acquireManifestLock(manifestPath).then(
    (lock) => ({ lock }),
    () => ({ lock: null }),
  );
}

beforeEach(async () => {
  dir = await mkdtempReel("/tmp/hardline-steal-");
  manifestPath = `${dir}/manifest.json`;
  lockPath = manifestLockPath(manifestPath);
  renames.length = 0;
  unlinks.length = 0;
});

afterEach(async () => {
  await rmReel(dir, { recursive: true, force: true });
});

describe("trois pretendants sur un meme orphelin", () => {
  test("un seul detient le verrou, et celui du gagnant n'est jamais touche", async () => {
    // A lit l'orphelin. W reprend et publie le sien. A saisit alors ce que le
    // nom porte : le verrou VIVANT de W. C se precipite sur le nom. A constate
    // que ce n'est pas son orphelin. Aucun plantage nulle part.
    await poserOrphelin();

    apresLecture.armer();
    const a = tenter();
    await apresLecture.atteinte();

    const w = await tenter();
    expect(w.lock).not.toBeNull();
    const verrouDeW = await readFileReel(lockPath, "utf8");

    apresSaisie.armer();
    apresLecture.liberer();
    await apresSaisie.atteinte();

    // La fenetre exacte : le nom est-il libre ?
    const c = await tenter();

    apresSaisie.liberer();
    const resultatA = await a;

    const detenteurs = [w, c, resultatA].filter((t) => t.lock !== null);
    expect(detenteurs).toHaveLength(1);
    expect(detenteurs[0]).toBe(w);

    // Et le verrou de W est reste le sien, octet pour octet : personne ne l'a
    // deplace, efface, ni remplace.
    expect(await readFileReel(lockPath, "utf8")).toBe(verrouDeW);

    for (const t of detenteurs) await t.lock?.release();
  });
});

describe("le nom est repris entre le second lien et la preuve", () => {
  test("la preuve d'identite le voit, et le verrou du rival est epargne", async () => {
    // Le cas que la comparaison ino/dev existe pour attraper, et le seul ou
    // elle decide. A pose son second nom sur l'inode de l'orphelin ; W reprend
    // et republie sous le MEME nom ; la relecture de A, faite sur son temoin,
    // voit encore l'orphelin et le reconnait: le lien dur maintient cet inode
    // vivant. Le detenteur est donc le bon, et pourtant `path` ne designe plus
    // ce fichier. Seule la comparaison des inodes les distingue.
    //
    // Sans elle : A supprime `path`, c'est-a-dire le verrou VIVANT de W, puis
    // publie le sien. Deux detenteurs, et le verrou de W introuvable.
    await poserOrphelin();

    apresSaisie.armer();
    const a = tenter();
    await apresSaisie.atteinte();

    // A tient son temoin sur l'inode de l'orphelin. W passe entierement : il
    // reprend cet orphelin et publie son propre verrou sous le meme nom.
    const w = await tenter();
    expect(w.lock).not.toBeNull();
    const verrouDeW = await readFileReel(lockPath, "utf8");

    apresSaisie.liberer();
    const resultatA = await a;

    const detenteurs = [w, resultatA].filter((t) => t.lock !== null);
    expect(detenteurs).toHaveLength(1);
    expect(detenteurs[0]).toBe(w);
    // Octet pour octet : ce n'est pas seulement un verrou, c'est le SIEN. Sans
    // la preuve d'identite, A l'aurait efface et publie le sien a la place.
    expect(await readFileReel(lockPath, "utf8")).toBe(verrouDeW);

    for (const t of detenteurs) await t.lock?.release();
  });
});

describe("la sonde d'un orphelin", () => {
  test("ne deplace ni ne supprime le verrou qu'elle examine", async () => {
    // Le geste de saisie est un lien dur : il donne un second nom au fichier
    // present sans y toucher. Une execution qui s'arrete la (parce que ce
    // n'est pas l'orphelin, ou parce qu'elle meurt) n'a rien abime.
    await poserOrphelin();
    const contenuOrphelin = await readFileReel(lockPath, "utf8");

    apresSaisie.armer();
    const a = tenter();
    await apresSaisie.atteinte();

    // A tient son second nom. Le verrou d'origine est intact et toujours la.
    expect(renames).toEqual([]);
    expect(unlinks).not.toContain(lockPath);
    expect(await readFileReel(lockPath, "utf8")).toBe(contenuOrphelin);

    apresSaisie.liberer();
    const resultat = await a;
    expect(resultat.lock).not.toBeNull();
    await resultat.lock?.release();
  });

  test("ne laisse aucun residu une fois la reprise aboutie", async () => {
    await poserOrphelin();
    const resultat = await tenter();
    expect(resultat.lock).not.toBeNull();
    try {
      const restes = (await readdirReel(dir)).filter(
        (n) => n.includes(".stale.") || n.endsWith(".tmp"),
      );
      expect(restes).toEqual([]);
    } finally {
      await resultat.lock?.release();
    }
  });
});
