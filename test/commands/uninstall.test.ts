import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import type { Manifest } from "../../src/lib/manifest";

const realManifest = await import("../../src/lib/manifest");

let order: string[] = [];
let unrestored: string[] = [];
const prompts: string[] = [];
const reports: { title: string; lines: string[] }[] = [];
const finishes: string[] = [];
const trace: string[] = [];

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
  defaultManifestPath: () => "/tmp/hardline-test/manifest.json",
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
    report: (title: string, lines: string[]) => reports.push({ title, lines }),
  },
}));

const { uninstallCommand, scopeLabel } = await import("../../src/commands/uninstall");

beforeEach(() => {
  order = ["network-mac", "network-windows", "network-profile-task"];
  unrestored = [];
  prompts.length = 0;
  reports.length = 0;
  finishes.length = 0;
  trace.length = 0;
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
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

  test("ne pretend rien d'une etape inconnue", () => {
    expect(scopeLabel(["etape-d-une-version-ulterieure"])).toBe(
      "des machines concernées",
    );
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

  test("ne demande rien et ne restaure rien sur un manifeste vide", async () => {
    order = [];
    await uninstallCommand({ yes: false });
    expect(prompts).toEqual([]);
    expect(trace).toEqual([]);
    expect(finishes.join("\n")).toContain("rien à restaurer");
    expect(process.exitCode).toBe(0);
  });

  test("signale une restauration incomplete", async () => {
    unrestored = ["network-windows"];
    await uninstallCommand({ yes: true });
    expect(trace).toEqual(["revert"]);
    expect(finishes.join("\n")).toContain("Restauration incomplète");
    expect(process.exitCode).toBe(1);
  });
});
