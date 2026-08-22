import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyManifest,
  recordStep,
  forgetStep,
  stepsInReverseOrder,
  readManifest,
  writeManifest,
  type Manifest,
} from "../../src/lib/manifest";

const T1 = "2026-08-22T10:00:00.000Z";
const T2 = "2026-08-22T10:00:01.000Z";
const T3 = "2026-08-22T10:00:02.000Z";

describe("fonctions pures", () => {
  test("un manifeste vide n'a aucune etape", () => {
    expect(stepsInReverseOrder(emptyManifest(T1))).toEqual([]);
  });

  test("recordStep conserve l'etat anterieur", () => {
    const m = recordStep(emptyManifest(T1), "network-mac", { mode: "dhcp" }, T2);
    expect(m.steps["network-mac"]).toEqual({
      step: "network-mac",
      appliedAt: T2,
      previous: { mode: "dhcp" },
    });
  });

  test("reappliquer une etape n'ecrase pas le premier etat anterieur", () => {
    // Sinon rejouer install apres install rendrait la restauration impossible :
    // le second enregistrement capturerait l'etat que hardline a lui-meme pose.
    const once = recordStep(emptyManifest(T1), "network-mac", { mode: "dhcp" }, T2);
    const twice = recordStep(once, "network-mac", { mode: "manual" }, T3);
    expect(twice.steps["network-mac"]?.previous).toEqual({ mode: "dhcp" });
  });

  test("forgetStep retire l'etape", () => {
    const m = recordStep(emptyManifest(T1), "network-mac", null, T2);
    expect(forgetStep(m, "network-mac").steps["network-mac"]).toBeUndefined();
  });

  test("stepsInReverseOrder rend les etapes de la plus recente a la plus ancienne", () => {
    let m = emptyManifest(T1);
    m = recordStep(m, "premiere", null, T1);
    m = recordStep(m, "seconde", null, T2);
    m = recordStep(m, "troisieme", null, T3);
    expect(stepsInReverseOrder(m).map((s) => s.step)).toEqual([
      "troisieme",
      "seconde",
      "premiere",
    ]);
  });
});

describe("persistance", () => {
  test("relire un manifeste ecrit rend le meme contenu", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardline-"));
    const path = join(dir, "nested", "manifest.json");
    try {
      const written = recordStep(emptyManifest(T1), "network-mac", { a: 1 }, T2);
      await writeManifest(path, written);
      expect(await readManifest(path)).toEqual(written);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lire un manifeste absent rend un manifeste vide, sans erreur", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardline-"));
    try {
      const m: Manifest = await readManifest(join(dir, "absent.json"));
      expect(stepsInReverseOrder(m)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("aucun fichier temporaire ne survit a l'ecriture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardline-"));
    const path = join(dir, "manifest.json");
    try {
      await writeManifest(path, emptyManifest(T1));
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(dir)).toEqual(["manifest.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("une lecture concurrente ne voit jamais un fichier tronque", async () => {
    // Le test precedent ne prouve PAS l'atomicite : une ecriture directe sans
    // fichier temporaire le passerait aussi, puisque rien ne "survit". Celui-ci
    // exerce l'invariant reel — pendant qu'un gros manifeste s'ecrit, toute
    // lecture doit rendre un JSON complet, l'ancien ou le nouveau, jamais un
    // fragment. Une ecriture non atomique fait echouer JSON.parse.
    const dir = await mkdtemp(join(tmpdir(), "hardline-"));
    const path = join(dir, "manifest.json");
    try {
      let big = emptyManifest(T1);
      for (let i = 0; i < 3000; i++) {
        big = recordStep(big, `etape-${i}`, { index: i, blob: "x".repeat(80) }, T2);
      }

      await writeManifest(path, emptyManifest(T1));

      const writing = writeManifest(path, big);
      const readings = Array.from({ length: 40 }, () => readManifest(path));
      await writing;

      for (const manifest of await Promise.all(readings)) {
        expect(manifest.version).toBe(1);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("robustesse a la lecture", () => {
  test("rejette un fichier qui n'est pas du JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardline-"));
    const path = join(dir, "manifest.json");
    try {
      await Bun.write(path, "{ ceci n'est pas du json");
      expect(readManifest(path)).rejects.toThrow(/illisible/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejette un JSON valide qui n'est pas un manifeste", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardline-"));
    const path = join(dir, "manifest.json");
    try {
      await Bun.write(path, JSON.stringify({ hello: "world" }));
      expect(readManifest(path)).rejects.toThrow(/invalide/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejette un manifeste d'une version inconnue", async () => {
    // Une version future decrit un etat anterieur dont cette version du code
    // ignore la forme : restaurer a l'aveugle serait pire que refuser.
    const dir = await mkdtemp(join(tmpdir(), "hardline-"));
    const path = join(dir, "manifest.json");
    try {
      await Bun.write(path, JSON.stringify({ ...emptyManifest(T1), version: 2 }));
      expect(readManifest(path)).rejects.toThrow(/invalide/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
