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
});
