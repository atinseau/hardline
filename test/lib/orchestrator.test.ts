import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "../fixtures/config";
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

/**
 * Une etape dont la conformite reflete reellement ce que apply a fait : c'est
 * la seule facon de prouver l'idempotence plutot que de la supposer.
 */
function makeStatefulStep(name: string, trace: Trace): Step<{ marker: string }> {
  let applied = false;
  return {
    name,
    label: `Etape ${name}`,
    async inspect() {
      trace.push(`inspect:${name}`);
      return { conforming: applied, current: { marker: `avant-${name}` }, detail: "d" };
    },
    async apply() {
      trace.push(`apply:${name}`);
      applied = true;
    },
    async restore() {},
  };
}

/** Une etape qui note ce que `pending` lui annonce au moment de restaurer. */
function makeContextSpy(name: string, seen: string[][]): Step<{ marker: string }> {
  return {
    name,
    label: `Etape ${name}`,
    async inspect() {
      return { conforming: false, current: { marker: `avant-${name}` }, detail: "d" };
    },
    async apply() {},
    async restore(_c, _p, context) {
      seen.push([...context.pending]);
    },
  };
}

const reports: string[] = [];
const fakeUi = ({ kind, step }: { kind: string; step: string }) =>
  reports.push(`${kind === "conforming" ? "skipped" : kind}:${step}`);

let dir: string;
let manifestPath: string;

beforeEach(async () => {
  reports.length = 0;
  dir = await mkdtemp(join(tmpdir(), "hardline-orch-"));
  manifestPath = join(dir, "manifest.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("applySteps", () => {
  test("saute une etape deja conforme sans l'appliquer", async () => {
    const trace: Trace = [];
    await applySteps([makeStep("a", true, trace)], CONFIG, manifestPath, fakeUi);
    expect(trace).toEqual(["inspect:a"]);
    expect(reports).toEqual(["skipped:a"]);
  });

  test("applique une etape non conforme", async () => {
    const trace: Trace = [];
    await applySteps([makeStep("a", false, trace)], CONFIG, manifestPath, fakeUi);
    expect(trace).toEqual(["inspect:a", "apply:a"]);
    expect(reports).toEqual(["applied:a"]);
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
    expect(reports).toContain("failed:b");
  });

  test("rapporte une inspection en echec avant de propager l'erreur", async () => {
    const step = makeStep("a", false, []);
    step.inspect = async () => {
      throw new Error("inspection refused");
    };

    await expect(applySteps([step], CONFIG, manifestPath, fakeUi)).rejects.toThrow(
      "inspection refused",
    );
    expect(reports).toEqual(["failed:a"]);
  });

  test("rejouer applySteps ne reapplique rien", async () => {
    // Le second passage voit une etape devenue conforme parce que le premier
    // l'a appliquee : c'est l'idempotence reelle, pas un decor.
    const trace: Trace = [];
    const step = makeStatefulStep("a", trace);
    await applySteps([step], CONFIG, manifestPath, fakeUi);
    await applySteps([step], CONFIG, manifestPath, fakeUi);
    expect(trace).toEqual(["inspect:a", "apply:a", "inspect:a"]);

    const manifest = await readManifest(manifestPath);
    expect(manifest.order).toEqual(["a"]);
    expect(manifest.steps["a"]?.previous).toEqual({ marker: "avant-a" });
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

  test("conserve l'etat anterieur d'une etape dont le code a disparu", async () => {
    const steps = [makeStep("a", false, [])];
    await applySteps(steps, CONFIG, manifestPath, fakeUi);
    reports.length = 0;
    // On restaure avec un registre vide : ne doit pas lever.
    const { unrestored } = await revertSteps([], CONFIG, manifestPath, fakeUi);
    expect(reports).toEqual(["failed:a"]);
    expect(unrestored).toEqual(["a"]);

    // Le point critique : oublier cet enregistrement serait irreversible, son
    // etat anterieur etant la seule chose qui sache remettre la machine en etat.
    const manifest = await readManifest(manifestPath);
    expect(manifest.order).toEqual(["a"]);
    expect(manifest.steps["a"]?.previous).toEqual({ marker: "avant-a" });
  });

  test("restaure un manifeste en passes selectionnees sans lancer la queue trop tot", async () => {
    const trace: Trace = [];
    const pending: string[][] = [];
    const mac = makeStep("network-mac", false, trace);
    const observable = makeContextSpy("observable", pending);
    const bootstrap: Step<{ marker: string }> = {
      ...makeStep("bootstrap-windows", false, trace),
      async restore() {
        trace.push("launch:bootstrap-windows");
        return { detached: "queue terminale lancee" };
      },
    };
    const steps = [mac, bootstrap, observable];
    await applySteps(steps, CONFIG, manifestPath, fakeUi);
    trace.length = 0;
    reports.length = 0;

    const observed = await revertSteps(steps, CONFIG, manifestPath, fakeUi, {
      selectedSteps: ["observable"],
    });
    expect(observed).toEqual({ unrestored: [], unconfirmed: [] });
    expect(pending).toEqual([["bootstrap-windows", "network-mac"]]);
    expect((await readManifest(manifestPath)).order).toEqual([
      "network-mac",
      "bootstrap-windows",
    ]);

    const terminal = await revertSteps(steps, CONFIG, manifestPath, fakeUi, {
      selectedSteps: ["network-mac", "bootstrap-windows"],
    });
    expect(trace).toEqual([
      "launch:bootstrap-windows",
      "restore:network-mac:avant-network-mac",
    ]);
    expect(reports).toEqual([
      "restored:observable",
      "detached:bootstrap-windows",
      "restored:network-mac",
    ]);
    expect(terminal).toEqual({
      unrestored: [],
      unconfirmed: ["bootstrap-windows"],
    });
    expect((await readManifest(manifestPath)).order).toEqual(["bootstrap-windows"]);
  });

  test("signale une restauration en echec sans perdre son enregistrement", async () => {
    const trace: Trace = [];
    const steps = [makeStep("a", false, trace), makeStep("b", false, trace)];
    await applySteps(steps, CONFIG, manifestPath, fakeUi);

    const failing: Step<{ marker: string }> = {
      ...steps[0]!,
      async restore() {
        throw new Error("sudo refuse");
      },
    };
    reports.length = 0;
    const { unrestored } = await revertSteps(
      [failing, steps[1]!],
      CONFIG,
      manifestPath,
      fakeUi,
    );

    // b est restauree malgre l'echec de a : une machine qui refuse ne doit pas
    // bloquer l'autre. Et le libelle de l'etape est conserve dans le rapport.
    expect(reports).toEqual(["restored:b", "failed:a"]);
    expect(unrestored).toEqual(["a"]);
  });

  test("annonce a une etape les restaurations connues qui la suivent", async () => {
    // Le controle du test suivant : sans lui, un `pending` toujours vide le
    // satisferait aussi, et le filtre ne prouverait rien.
    const seen: string[][] = [];
    const a = makeStep("a", false, []);
    const b = makeContextSpy("b", seen);
    await applySteps([a, b], CONFIG, manifestPath, fakeUi);
    await revertSteps([a, b], CONFIG, manifestPath, fakeUi);
    expect(seen).toEqual([["a"]]);
  });

  test("n'annonce jamais une etape que cette version ne sait plus restaurer", async () => {
    // `pending` sert a ceder le travail a une couche plus profonde. Une etape
    // dont le code a disparu ne restaurera rien : lui ceder, c'est ceder a
    // personne : zero script emis, machine intacte, et l'enregistrement de
    // celle qui a cede efface au passage.
    const seen: string[][] = [];
    const a = makeStep("a", false, []);
    const b = makeContextSpy("b", seen);
    await applySteps([a, b], CONFIG, manifestPath, fakeUi);

    const { unrestored } = await revertSteps([b], CONFIG, manifestPath, fakeUi);
    expect(seen).toEqual([[]]);
    expect(unrestored).toEqual(["a"]);
  });

  test("une etape qui cede n'est pas rapportee comme restauree", async () => {
    const yielding: Step<{ marker: string }> = {
      ...makeStep("a", false, []),
      async restore() {
        return { yielded: "cédée à plus profond" };
      },
    };
    await applySteps([yielding], CONFIG, manifestPath, fakeUi);
    reports.length = 0;
    await revertSteps([yielding], CONFIG, manifestPath, fakeUi);

    expect(reports).toEqual(["yielded:a"]);
    // L'enregistrement part quand meme : la couche profonde le supplante.
    expect((await readManifest(manifestPath)).order).toEqual([]);
  });

  test("une etape lancee sans confirmation GARDE son enregistrement", async () => {
    // Le geste irreversible du programme est d'oublier un etat anterieur. Il
    // n'a lieu que pour une restauration OBSERVEE. Une queue detachee rend la
    // main avant d'avoir agi, sur une machine que le Mac ne reverra pas :
    // echanger l'enregistrement contre l'espoir qu'elle a abouti serait
    // exactement la malhonnetete que le manifeste existe pour eviter.
    const detached: Step<{ marker: string }> = {
      ...makeStep("a", false, []),
      async restore() {
        return { detached: "queue confiée à un processus détaché" };
      },
    };
    await applySteps([detached], CONFIG, manifestPath, fakeUi);
    reports.length = 0;
    const report = await revertSteps([detached], CONFIG, manifestPath, fakeUi);

    expect(reports).toEqual(["detached:a"]);
    expect(report.unconfirmed).toEqual(["a"]);
    expect(report.unrestored).toEqual([]);

    const manifest = await readManifest(manifestPath);
    expect(manifest.order).toEqual(["a"]);
    expect(manifest.steps["a"]?.previous).toEqual({ marker: "avant-a" });
  });

  test("date le lancement dans le manifeste", async () => {
    const detached: Step<{ marker: string }> = {
      ...makeStep("a", false, []),
      async restore() {
        return { detached: "queue confiée à un processus détaché" };
      },
    };
    await applySteps([detached], CONFIG, manifestPath, fakeUi);
    await revertSteps([detached], CONFIG, manifestPath, fakeUi);

    const record = (await readManifest(manifestPath)).steps["a"];
    expect(typeof record?.launchedAt).toBe("string");
    // Et l'etat anterieur, lui, n'a pas bouge : on ecrit une date, pas un verdict.
    expect(record?.previous).toEqual({ marker: "avant-a" });
  });

  test("une seconde desinstallation ne rapporte pas un echec neuf", async () => {
    // La queue detachee a rendu le PC injoignable par construction : c'est le
    // resultat attendu d'une REUSSITE. Une seconde desinstallation qui echoue
    // a le joindre ne decouvre aucune panne, elle retrouve le meme doute.
    const detached: Step<{ marker: string }> = {
      ...makeStep("a", false, []),
      async restore() {
        return { detached: "queue confiée à un processus détaché" };
      },
    };
    await applySteps([detached], CONFIG, manifestPath, fakeUi);
    await revertSteps([detached], CONFIG, manifestPath, fakeUi);

    const injoignable: Step<{ marker: string }> = {
      ...detached,
      async restore() {
        throw new Error("PC injoignable");
      },
    };
    reports.length = 0;
    const report = await revertSteps(
      [injoignable],
      CONFIG,
      manifestPath,
      fakeUi,
    );

    expect(report.unconfirmed).toEqual(["a"]);
    expect(report.unrestored).toEqual([]);
    expect(reports).toEqual(["detached:a"]);
    expect((await readManifest(manifestPath)).order).toEqual(["a"]);
  });

  test("une etape JAMAIS lancee qui echoue reste un echec", async () => {
    // Le controle : sans lui, toute panne deviendrait une incertitude et
    // le verdict de restauration incomplete ne se dirait plus jamais.
    const step = makeStep("a", false, []);
    await applySteps([step], CONFIG, manifestPath, fakeUi);

    const failing: Step<{ marker: string }> = {
      ...step,
      async restore() {
        throw new Error("sudo refuse");
      },
    };
    reports.length = 0;
    const report = await revertSteps([failing], CONFIG, manifestPath, fakeUi);

    expect(report.unrestored).toEqual(["a"]);
    expect(report.unconfirmed).toEqual([]);
    expect(reports).toEqual(["failed:a"]);
  });

  test("reappliquer une etape efface le doute laisse par une desinstallation", async () => {
    // Le drapeau de lancement decrit une restauration, pas un etat anterieur :
    // reappliquer l'etape reconfigure la machine et le doute n'a plus d'objet.
    // Le laisser ferait passer un futur echec reel pour une simple incertitude.
    const detached: Step<{ marker: string }> = {
      ...makeStatefulStep("a", []),
      async restore() {
        return { detached: "queue confiée à un processus détaché" };
      },
    };
    await applySteps([detached], CONFIG, manifestPath, fakeUi);
    await revertSteps([detached], CONFIG, manifestPath, fakeUi);
    expect(
      typeof (await readManifest(manifestPath)).steps["a"]?.launchedAt,
    ).toBe("string");

    // L'etape n'est plus conforme apres restauration : elle se reapplique.
    await applySteps([makeStep("a", false, [])], CONFIG, manifestPath, fakeUi);
    const record = (await readManifest(manifestPath)).steps["a"];
    expect(record?.launchedAt).toBeUndefined();
    // Et l'etat anterieur d'origine, lui, est toujours celui du premier passage.
    expect(record?.previous).toEqual({ marker: "avant-a" });
  });

  test("une etape observee, elle, perd son enregistrement", async () => {
    // Le controle : sans lui, un manifeste jamais vide satisferait aussi le
    // test precedent, et "restaure" ne voudrait plus rien dire.
    const step = makeStep("a", false, []);
    await applySteps([step], CONFIG, manifestPath, fakeUi);
    reports.length = 0;
    const report = await revertSteps([step], CONFIG, manifestPath, fakeUi);

    expect(reports).toEqual(["restored:a"]);
    expect(report.unconfirmed).toEqual([]);
    expect((await readManifest(manifestPath)).order).toEqual([]);
  });

  test("ecrit le manifeste apres chaque restauration, pas a la fin", async () => {
    const trace: Trace = [];
    const steps = [makeStep("a", false, trace), makeStep("b", false, trace)];
    await applySteps(steps, CONFIG, manifestPath, fakeUi);

    let manifestPendantA = "";
    const failing: Step<{ marker: string }> = {
      ...steps[0]!,
      async restore() {
        manifestPendantA = readFileSync(manifestPath, "utf8");
        throw new Error("sudo refuse");
      },
    };
    const { unrestored } = await revertSteps(
      [failing, steps[1]!],
      CONFIG,
      manifestPath,
      fakeUi,
    );

    // b a ete restauree avant a : au moment ou a s'execute, son enregistrement
    // doit deja avoir disparu du disque. Une ecriture unique en fin de boucle
    // laisserait ici b encore presente, et une interruption la reperdrait.
    expect(manifestPendantA).not.toContain("avant-b");
    expect(manifestPendantA).toContain("avant-a");

    const manifest = await readManifest(manifestPath);
    expect(manifest.order).toEqual(["a"]);
    expect(manifest.steps["a"]?.previous).toEqual({ marker: "avant-a" });
    expect(unrestored).toEqual(["a"]);
  });
});
