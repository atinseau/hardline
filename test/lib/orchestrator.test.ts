import { test, expect, describe, mock, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "../../src/config";
import type { Step } from "../../src/steps/types";
import { readManifest } from "../../src/lib/manifest";
import { applySteps, revertSteps } from "../../src/lib/orchestrator";

type Trace = string[];

function makeStep(
  name: string,
  conforming: boolean,
  trace: Trace,
  onApply?: () => void,
): Step<{ marker: string }> {
  return {
    name,
    label: `Etape ${name}`,
    async inspect() {
      trace.push(`inspect:${name}`);
      return { conforming, current: { marker: `avant-${name}` }, detail: "d" };
    },
    async apply() {
      trace.push(`apply:${name}`);
      onApply?.();
    },
    async restore(_c, previous) {
      trace.push(`restore:${name}:${previous.marker}`);
    },
  };
}

const reports: string[] = [];
const fakeUi = {
  skipped: ({ label }: { label: string }) => reports.push(`skipped:${label}`),
  applied: ({ label }: { label: string }) => reports.push(`applied:${label}`),
  failed: ({ label }: { label: string }) => reports.push(`failed:${label}`),
};

let dir: string;
let manifestPath: string;

beforeEach(async () => {
  reports.length = 0;
  dir = await mkdtemp(join(tmpdir(), "hardline-orch-"));
  manifestPath = join(dir, "manifest.json");
});

describe("applySteps", () => {
  test("saute une etape deja conforme sans l'appliquer", async () => {
    const trace: Trace = [];
    await applySteps([makeStep("a", true, trace)], CONFIG, manifestPath, fakeUi);
    expect(trace).toEqual(["inspect:a"]);
    expect(reports).toEqual(["skipped:Etape a"]);
  });

  test("applique une etape non conforme", async () => {
    const trace: Trace = [];
    await applySteps([makeStep("a", false, trace)], CONFIG, manifestPath, fakeUi);
    expect(trace).toEqual(["inspect:a", "apply:a"]);
    expect(reports).toEqual(["applied:Etape a"]);
  });

  test("ecrit l'etat anterieur AVANT d'appliquer", async () => {
    // Le test qui protege l'invariant de surete : au moment ou apply s'execute,
    // l'etat anterieur doit deja etre sur disque, contenu compris. Si l'ecriture
    // passait apres apply, readFileSync leverait ENOENT et le test echouerait.
    const trace: Trace = [];
    let manifestAtApplyTime = "";
    const step = makeStep("a", false, trace, () => {
      manifestAtApplyTime = readFileSync(manifestPath, "utf8");
    });
    await applySteps([step], CONFIG, manifestPath, fakeUi);
    expect(manifestAtApplyTime).toContain("avant-a");
  });

  test("conserve l'etat anterieur dans le manifeste", async () => {
    await applySteps([makeStep("a", false, [])], CONFIG, manifestPath, fakeUi);
    const manifest = await readManifest(manifestPath);
    expect(manifest.steps["a"]?.previous).toEqual({ marker: "avant-a" });
  });

  test("n'enregistre pas une etape deja conforme", async () => {
    await applySteps([makeStep("a", true, [])], CONFIG, manifestPath, fakeUi);
    expect((await readManifest(manifestPath)).order).toEqual([]);
  });

  test("s'arrete a la premiere etape en echec", async () => {
    const trace: Trace = [];
    const boom = makeStep("b", false, trace, () => {
      throw new Error("refus");
    });
    const steps = [makeStep("a", false, trace), boom, makeStep("c", false, trace)];
    await expect(
      applySteps(steps, CONFIG, manifestPath, fakeUi),
    ).rejects.toThrow("refus");
    // L'etape c n'est meme pas inspectee : l'orchestrateur s'arrete net.
    expect(trace).toEqual(["inspect:a", "apply:a", "inspect:b", "apply:b"]);
  });

  test("rejouer applySteps ne reapplique rien", async () => {
    const trace: Trace = [];
    await applySteps([makeStep("a", true, trace)], CONFIG, manifestPath, fakeUi);
    await applySteps([makeStep("a", true, trace)], CONFIG, manifestPath, fakeUi);
    expect(trace.filter((t) => t.startsWith("apply"))).toHaveLength(0);
  });
});

describe("revertSteps", () => {
  test("restaure dans l'ordre inverse de l'application", async () => {
    const trace: Trace = [];
    const steps = [makeStep("a", false, trace), makeStep("b", false, trace)];
    await applySteps(steps, CONFIG, manifestPath, fakeUi);
    trace.length = 0;
    await revertSteps(steps, CONFIG, manifestPath, fakeUi);
    expect(trace).toEqual(["restore:b:avant-b", "restore:a:avant-a"]);
  });

  test("vide le manifeste apres restauration", async () => {
    const steps = [makeStep("a", false, [])];
    await applySteps(steps, CONFIG, manifestPath, fakeUi);
    await revertSteps(steps, CONFIG, manifestPath, fakeUi);
    expect((await readManifest(manifestPath)).order).toEqual([]);
  });

  test("ignore une etape enregistree dont le code a disparu", async () => {
    const steps = [makeStep("a", false, [])];
    await applySteps(steps, CONFIG, manifestPath, fakeUi);
    // On restaure avec un registre vide : ne doit pas lever.
    await revertSteps([], CONFIG, manifestPath, fakeUi);
    expect(reports.some((r) => r.startsWith("failed"))).toBe(true);
  });
});

import { afterEach } from "bun:test";
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
