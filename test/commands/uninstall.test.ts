import { test, expect, describe, afterAll, beforeEach, afterEach, mock } from "bun:test";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Manifest } from "../../src/lib/manifest";

const realManifest = await import("../../src/lib/manifest");
const MANIFEST_PATH = `/tmp/hardline-uninstall-${process.pid}/manifest.json`;

let order: string[] = [];
let unrestored: string[] = [];
const prompts: string[] = [];
const reports: { title: string; lines: string[] }[] = [];
const finishes: string[] = [];
const trace: string[] = [];
/** L'ordre reel entre les encarts affiches et la question posee. */
const sequence: string[] = [];

function manifestOf(names: string[]): Manifest {
  const now = "2026-08-22T10:00:00.000Z";
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    order: names,
    steps: Object.fromEntries(
      names.map((n) => [n, { step: n, appliedAt: now, previous: {} }]),
    ),
  };
}

mock.module("../../src/lib/manifest", () => ({
  ...realManifest,
  defaultManifestPath: () => MANIFEST_PATH,
  readManifest: async () => manifestOf(order),
}));

mock.module("../../src/lib/orchestrator", () => ({
  revertSteps: async () => {
    trace.push("revert");
    return unrestored;
  },
}));

mock.module("../../src/lib/ui", () => ({
  configureOutput: () => {},
  askConfirmation: async (message: string) => {
    prompts.push(message);
    sequence.push("question");
    return true;
  },
  ui: {
    start: () => {},
    finish: (message: string) => finishes.push(message),
    skipped: () => {},
    applied: () => {},
    restored: () => {},
    failed: () => {},
    info: () => {},
    warn: () => {},
    report: (title: string, lines: string[]) => {
      reports.push({ title, lines });
      sequence.push(`encart:${title}`);
    },
  },
}));

const { uninstallCommand, scopeLabel, bootstrapCaveats } = await import(
  "../../src/commands/uninstall"
);

beforeEach(() => {
  order = [
    "network-mac",
    "bootstrap-windows",
    "network-windows",
    "network-profile-task",
  ];
  unrestored = [];
  prompts.length = 0;
  reports.length = 0;
  finishes.length = 0;
  trace.length = 0;
  sequence.length = 0;
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

afterAll(async () => {
  await rm(dirname(MANIFEST_PATH), { recursive: true, force: true });
});

describe("scopeLabel", () => {
  test("nomme le Mac seul apres un arret en phase distante", () => {
    expect(scopeLabel(["network-mac"])).toBe("du Mac");
  });

  test("nomme le PC seul", () => {
    expect(scopeLabel(["network-windows"])).toBe("du PC");
  });

  test("ne parle des deux machines que si les deux sont enregistrees", () => {
    expect(scopeLabel(["network-mac", "network-windows"])).toBe("des deux machines");
  });

  test("nomme le PC quand seul le releve d'amorcage est enregistre", () => {
    // C'est l'etat laisse par un arret sur une precondition distante apres
    // amorcage : le releve est au manifeste, aucune etape de convergence.
    expect(scopeLabel(["network-mac", "bootstrap-windows"])).toBe("des deux machines");
    expect(scopeLabel(["bootstrap-windows"])).toBe("du PC");
  });

  test("ne pretend rien d'une etape inconnue", () => {
    expect(scopeLabel(["etape-d-une-version-ulterieure"])).toBe(
      "des machines concernées",
    );
  });
});

describe("bootstrapCaveats", () => {
  test("ne nuance rien quand l'amorcage n'est pas enregistre", () => {
    expect(bootstrapCaveats(["network-mac", "network-windows"])).toBeNull();
  });

  test("dit que la capacite OpenSSH reste installee", () => {
    const lines = (bootstrapCaveats(["bootstrap-windows"]) ?? []).join("\n");
    expect(lines).toContain("OpenSSH Server");
    expect(lines).toContain("reste installée");
  });

  test("dit que le geste manuel d'amorcage sera a refaire", () => {
    const lines = (bootstrapCaveats(["bootstrap-windows"]) ?? []).join("\n");
    expect(lines).toContain("amorçage");
    expect(lines).toContain("plus joignable en SSH");
  });
});

describe("uninstallCommand", () => {
  test("ne demande que le Mac quand le manifeste ne contient que lui", async () => {
    // C'est l'etat laisse par un arret en phase 3 : promettre la restauration
    // des deux machines serait promettre ce qui n'aura pas lieu.
    order = ["network-mac"];
    await uninstallCommand({ yes: false });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("du Mac");
    expect(prompts[0]).not.toContain("des deux machines");
  });

  test("demande les deux machines quand les deux sont enregistrees", async () => {
    await uninstallCommand({ yes: false });
    expect(prompts[0]).toContain("des deux machines");
  });

  test("liste les etapes reellement enregistrees", async () => {
    order = ["network-mac"];
    await uninstallCommand({ yes: false });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.lines).toEqual(["Adresse fixe sur le lien direct (Mac)"]);
  });

  test("dit ce qui ne sera pas defait AVANT de poser la question", async () => {
    // Une restauration qui tait ses limites apres coup n'a plus rien a
    // proposer : l'utilisateur a deja repondu.
    await uninstallCommand({ yes: false });
    expect(sequence).toEqual([
      "encart:État antérieur enregistré",
      "encart:Ce qui ne sera pas défait",
      "question",
    ]);
  });

  test("n'affiche aucune nuance quand l'amorcage n'est pas enregistre", async () => {
    order = ["network-mac"];
    await uninstallCommand({ yes: false });
    expect(sequence).toEqual(["encart:État antérieur enregistré", "question"]);
  });

  test("ne demande rien et ne restaure rien sur un manifeste vide", async () => {
    order = [];
    await uninstallCommand({ yes: false });
    expect(prompts).toEqual([]);
    expect(trace).toEqual([]);
    expect(finishes.join("\n")).toContain("rien à restaurer");
    expect(process.exitCode).toBe(0);
  });

  test("une autre execution en cours ne pose meme pas la question", async () => {
    // Restaurer pendant qu'une install ecrit, c'est effacer une entree que
    // l'autre vient de poser. On s'arrete avant de lire quoi que ce soit.
    const lockPath = realManifest.manifestLockPath(MANIFEST_PATH);
    await mkdir(dirname(MANIFEST_PATH), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: "2026-08-22T10:00:00.000Z" }),
    );
    try {
      await uninstallCommand({ yes: true });
    } finally {
      await unlink(lockPath);
    }

    expect(prompts).toEqual([]);
    expect(reports).toEqual([]);
    expect(trace).toEqual([]);
    expect(finishes.join("\n")).toContain("Désinstallation abandonnée");
    expect(process.exitCode).toBe(1);
  });

  test("signale une restauration incomplete", async () => {
    unrestored = ["network-windows"];
    await uninstallCommand({ yes: true });
    expect(trace).toEqual(["revert"]);
    expect(finishes.join("\n")).toContain("Restauration incomplète");
    expect(process.exitCode).toBe(1);
  });
});
