import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "../../src/config";
import type { Step } from "../../src/steps/types";
import {
  acquireManifestLock,
  ManifestLockedError,
  manifestLockPath,
  readManifest,
} from "../../src/lib/manifest";
import { applySteps } from "../../src/lib/orchestrator";
import { errorMessage } from "../../src/lib/errors";

/**
 * L'invariant de cette suite : deux executions de hardline ne modifient jamais
 * le manifeste en meme temps.
 *
 * `writeManifest` est atomique, mais l'atomicite de l'ecriture ne protege pas
 * la sequence lire-modifier-ecrire. Deux `applySteps` concurrents lisaient le
 * meme manifeste vide, chacun y ajoutait son etape, et le second effacait
 * l'enregistrement du premier : l'etat anterieur d'une machine disparaissait
 * sans un mot.
 */

/** Un pid qui ne peut correspondre a aucun processus vivant. */
const PID_MORT = 2_147_483_646;

const reporter = {
  skipped: () => {},
  applied: () => {},
  restored: () => {},
  yielded: () => {},
  failed: () => {},
};

let dir: string;
let manifestPath: string;
let lockPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hardline-lock-"));
  manifestPath = join(dir, "manifest.json");
  lockPath = manifestLockPath(manifestPath);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Une etape dont l'inspection attend un signal : c'est ce qui force les deux
 * executions a se recouvrir, au lieu de se suivre par hasard d'ordonnancement.
 */
function makeStep(name: string, gate: Promise<void>): Step<{ marker: string }> {
  return {
    name,
    label: `Etape ${name}`,
    async inspect() {
      await gate;
      return { conforming: false, current: { marker: `avant-${name}` }, detail: "d" };
    },
    async apply() {},
    async restore() {},
  };
}

/** Une execution complete : verrou, convergence, liberation. */
async function run(step: Step<{ marker: string }>): Promise<string | null> {
  let lock;
  try {
    lock = await acquireManifestLock(manifestPath);
  } catch (error) {
    // Refusee : elle n'a rien touche, et elle dit pourquoi.
    return errorMessage(error);
  }
  try {
    await applySteps([step], CONFIG, manifestPath, reporter);
    return null;
  } finally {
    await lock.release();
  }
}

describe("deux executions concurrentes", () => {
  test("la seconde est refusee, et le manifeste garde la premiere entiere", async () => {
    let ouvrir = (): void => {};
    const gate = new Promise<void>((resolve) => {
      ouvrir = resolve;
    });

    const executions = Promise.all([
      run(makeStep("network-mac", gate)),
      run(makeStep("network-windows", gate)),
    ]);
    // Les deux ont demande le verrou avant qu'aucune ne puisse avancer.
    ouvrir();
    const resultats = await executions;

    const refusees = resultats.filter((r): r is string => r !== null);
    expect(refusees).toHaveLength(1);
    // Elle dit clairement qu'une autre execution tient le verrou.
    expect(refusees[0]).toContain("Une autre exécution de hardline est en cours");
    expect(refusees[0]).toContain("Rien n'a été modifié");

    // Et le manifeste ne porte que l'execution qui a gagne : sans verrou, les
    // deux ecrivaient et la seconde effacait la premiere.
    const manifest = await readManifest(manifestPath);
    expect(manifest.order).toHaveLength(1);
    const gagnante = manifest.order[0] as string;
    expect(resultats[gagnante === "network-mac" ? 0 : 1]).toBeNull();
    expect(manifest.steps[gagnante]?.previous).toEqual({
      marker: `avant-${gagnante}`,
    });
  });

  test("le verrou libere laisse passer l'execution suivante", async () => {
    // Le controle : sans lui, un verrou qui refuse TOUT satisferait aussi le
    // test precedent, et hardline ne tournerait plus jamais deux fois.
    const passee = new Promise<void>((resolve) => resolve());
    expect(await run(makeStep("network-mac", passee))).toBeNull();
    expect(await run(makeStep("network-windows", passee))).toBeNull();
    expect((await readManifest(manifestPath)).order).toEqual([
      "network-mac",
      "network-windows",
    ]);
  });
});

describe("acquireManifestLock", () => {
  test("retire le verrou en le liberant", async () => {
    const lock = await acquireManifestLock(manifestPath);
    expect(await Bun.file(lockPath).exists()).toBe(true);
    await lock.release();
    expect(await Bun.file(lockPath).exists()).toBe(false);
  });

  test("liberer deux fois ne leve pas", async () => {
    const lock = await acquireManifestLock(manifestPath);
    await lock.release();
    await lock.release();
  });

  test("nomme le processus qui tient le verrou ET le fichier a supprimer", async () => {
    // Sans le chemin, un refus que l'utilisateur ne comprend pas (un pid
    // recycle, un cas non prevu) le laisse sans le moindre geste possible.
    // Un outil capable de se refuser a son proprietaire doit dire comment
    // revenir, exactement comme le fait le message d'un verrou illisible.
    const lock = await acquireManifestLock(manifestPath);
    try {
      const refus = await acquireManifestLock(manifestPath).catch(errorMessage);
      expect(refus).toContain(`processus ${process.pid}`);
      expect(refus).toContain(lockPath);
    } finally {
      await lock.release();
    }
  });

  test("ne vole pas un verrou vivant, meme repute anterieur au demarrage", async () => {
    // L'instant de demarrage est calcule a partir de DEUX horloges : celle du
    // noyau et celle du mur, corrigible a tout instant par le reseau. Un pas
    // d'horloge suffit a faire passer un verrou tenu pour un verrou d'avant
    // redemarrage, et le voler, c'est deux executions ecrivant le manifeste
    // ensemble, la perte de donnees que ce verrou existe pour empecher.
    const vivant = JSON.stringify({
      pid: process.pid,
      startedAt: "2020-01-01T00:00:00.000Z",
      bootedAt: "2020-01-01T00:00:00.000Z",
    });
    await writeFile(lockPath, vivant);

    await expect(acquireManifestLock(manifestPath)).rejects.toBeInstanceOf(
      ManifestLockedError,
    );
    // Rigoureusement intact : ni repris, ni reecrit.
    expect(await readFile(lockPath, "utf8")).toBe(vivant);
  });

  test("un verrou d'avant le dernier demarrage le dit dans son refus", async () => {
    // Le temps ne peut prouver qu'une chose : que le verrou est VIEUX. Il ne
    // prouve jamais que son detenteur est mort. Il n'autorise donc rien, mais
    // il renseigne, et c'est ce qui rend le rm manifestement sans risque a qui
    // le lit.
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        startedAt: "2020-01-01T00:00:00.000Z",
        bootedAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    const refus = await acquireManifestLock(manifestPath).catch(errorMessage);
    expect(refus).toContain("antérieur au dernier démarrage");
    expect(refus).toContain(lockPath);
  });

  test("un verrou de la session courante ne dit rien de tel", async () => {
    // Le controle : sans lui, une mention systematique passerait aussi le test
    // precedent et ne prouverait rien de la comparaison.
    const lock = await acquireManifestLock(manifestPath);
    try {
      const refus = await acquireManifestLock(manifestPath).catch(errorMessage);
      expect(refus).not.toContain("antérieur au dernier démarrage");
      expect(refus).toContain(lockPath);
    } finally {
      await lock.release();
    }
  });

  test("ne reprend pas un verrou pose depuis le dernier demarrage", async () => {
    // Le controle : sans lui, une reprise inconditionnelle passerait aussi le
    // test precedent, et le verrou ne verrouillerait plus rien.
    const lock = await acquireManifestLock(manifestPath);
    try {
      await expect(acquireManifestLock(manifestPath)).rejects.toBeInstanceOf(
        ManifestLockedError,
      );
    } finally {
      await lock.release();
    }
  });

  test("ne vole JAMAIS un verrou dont le detenteur vit encore", async () => {
    // C'est le remede pire que le mal : reprendre le verrou d'une execution en
    // cours, c'est autoriser exactement l'entrelacement qu'on vient de fermer.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: "2026-08-22T10:00:00.000Z" }),
    );
    await expect(acquireManifestLock(manifestPath)).rejects.toBeInstanceOf(
      ManifestLockedError,
    );
    // Et il est laisse intact : on ne l'a ni retire, ni reecrit.
    expect(await readFile(lockPath, "utf8")).toContain(
      '"startedAt":"2026-08-22T10:00:00.000Z"',
    );
  });

  test("reprend un verrou laisse par un processus qui n'existe plus", async () => {
    // Un hardline tue au mauvais moment ne doit pas condamner la machine a une
    // intervention manuelle.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: PID_MORT, startedAt: "2026-08-22T10:00:00.000Z" }),
    );
    const lock = await acquireManifestLock(manifestPath);
    expect(await readFile(lockPath, "utf8")).toContain(`"pid":${process.pid}`);
    await lock.release();
  });

  test("refuse un verrou illisible plutot que de le voler", async () => {
    // Ne nommant aucun processus, il ne prouve rien : ni qu'une execution
    // tourne, ni qu'aucune ne tourne. On refuse, et on dit quel fichier
    // regarder.
    await writeFile(lockPath, "ceci n'est pas du JSON");
    await expect(acquireManifestLock(manifestPath)).rejects.toThrow(
      new RegExp(lockPath.replaceAll(".", "\\.")),
    );
    expect(await readFile(lockPath, "utf8")).toBe("ceci n'est pas du JSON");
  });

  test("le verrou est voisin du manifeste, jamais le manifeste lui-meme", async () => {
    expect(lockPath).not.toBe(manifestPath);
    expect(lockPath.startsWith(manifestPath)).toBe(true);
    const lock = await acquireManifestLock(manifestPath);
    // Poser le verrou ne cree aucun manifeste : rien n'est modifie tant que
    // rien n'est applique.
    expect(await Bun.file(manifestPath).exists()).toBe(false);
    await lock.release();
  });
});
