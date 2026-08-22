import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { ManifestLockedError } from "../../src/lib/manifest";

/**
 * La reprise d'un verrou orphelin, vue de tres pres.
 *
 * Le defaut ferme ici : la reprise faisait `unlink` sans condition. Deux
 * executions ayant constate le MEME orphelin le reussissaient toutes les deux,
 * et la seconde effacait le verrou tout neuf que la premiere venait de publier.
 * Les deux ecrivaient alors le manifeste ensemble, ce qui est exactement le
 * degat que ce verrou existe pour empecher.
 *
 * La course entre processus n'est pas rejouable dans une suite de tests. Ce que
 * ces tests observent, c'est ce qui la rend impossible : le vol passe par un
 * renommage, atomique, et jamais par une suppression ; et ce qu'on a deplace
 * est relu avant d'etre garde.
 */

const realFs = await import("node:fs/promises");
// Capturees AVANT le mock : lues apres coup, elles rendraient le mock lui-meme
// et la delegation serait une recursion infinie.
const renameReel = realFs.rename;
const unlinkReel = realFs.unlink;
const writeFileReel = realFs.writeFile;
const readFileReel = realFs.readFile;
const mkdtempReel = realFs.mkdtemp;
const rmReel = realFs.rm;
const readdirReel = realFs.readdir;

const renames: string[] = [];
const unlinks: string[] = [];
/** Ce que le verrou doit devenir juste avant le renommage, une seule fois. */
let substitutionAvantVol: string | null = null;

mock.module("node:fs/promises", () => ({
  ...realFs,
  rename: async (from: string, to: string) => {
    renames.push(String(from));
    if (substitutionAvantVol !== null) {
      // La fenetre exacte : un gagnant a republie entre notre lecture du
      // detenteur et notre renommage.
      const contenu = substitutionAvantVol;
      substitutionAvantVol = null;
      await writeFileReel(String(from), contenu, "utf8");
    }
    return renameReel(from, to);
  },
  unlink: async (path: string) => {
    unlinks.push(String(path));
    return unlinkReel(path);
  },
}));

const { acquireManifestLock, manifestLockPath } = await import(
  "../../src/lib/manifest"
);
const { errorMessage } = await import("../../src/lib/errors");

/** Un pid qui ne peut correspondre a aucun processus vivant. */
const PID_MORT = 2_147_483_646;

let dir: string;
let manifestPath: string;
let lockPath: string;

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

beforeEach(async () => {
  dir = await mkdtempReel("/tmp/hardline-steal-");
  manifestPath = `${dir}/manifest.json`;
  lockPath = manifestLockPath(manifestPath);
  renames.length = 0;
  unlinks.length = 0;
  substitutionAvantVol = null;
});

afterEach(async () => {
  await rmReel(dir, { recursive: true, force: true });
});

describe("la reprise d'un orphelin", () => {
  test("deplace le verrou, elle ne le supprime jamais", async () => {
    // `unlink` reussit pour tout le monde ; `rename` vers un nom unique
    // n'aboutit que pour un seul. C'est la difference entre une reprise qui
    // designe un gagnant et une reprise qui n'en designe aucun.
    await poserOrphelin();
    const lock = await acquireManifestLock(manifestPath);

    expect(renames).toContain(lockPath);
    expect(unlinks).not.toContain(lockPath);
    // Et le verrou publie est bien le notre.
    expect(await readFileReel(lockPath, "utf8")).toContain(`"pid":${process.pid}`);
    await lock.release();
  });

  test("ne laisse aucun residu du verrou vole", async () => {
    await poserOrphelin();
    const lock = await acquireManifestLock(manifestPath);
    try {
      const restes = (await readdirReel(dir)).filter(
        (n) => n.includes(".stale.") || n.endsWith(".tmp"),
      );
      expect(restes).toEqual([]);
    } finally {
      await lock.release();
    }
  });

  test("remet en place un verrou republie entre la lecture et le vol", async () => {
    // Le renommage arrive APRES qu'un gagnant a republie : on emporte alors un
    // verrou VIVANT. On relit ce qu'on a deplace, on constate que ce n'est pas
    // l'orphelin, on le remet, et on cede.
    await poserOrphelin();
    const vivant = JSON.stringify({
      pid: process.pid,
      startedAt: "2026-08-22T11:00:00.000Z",
      bootedAt: new Date().toISOString(),
    });
    substitutionAvantVol = vivant;

    const refus = await acquireManifestLock(manifestPath).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refus).toBeInstanceOf(ManifestLockedError);
    expect(errorMessage(refus)).toContain(`processus ${process.pid}`);
    // Le verrou du gagnant est intact, a sa place, et rien ne traine a cote.
    expect(await readFileReel(lockPath, "utf8")).toBe(vivant);
    const restes = (await readdirReel(dir)).filter((n) => n.includes(".stale."));
    expect(restes).toEqual([]);
  });
});
