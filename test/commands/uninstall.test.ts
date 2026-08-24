import { test, expect, describe, afterAll, beforeEach, afterEach, mock } from "bun:test";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Manifest } from "../../src/lib/manifest";
import { CONFIG, type Config } from "../fixtures/config";
import { exitCodeFor, type CommandOutput, type PromptAnswer } from "../../src/command-run";
import type {
  LifecycleOutcome,
  ResolvedTarget,
  TargetIntent,
  TargetResolution,
} from "../../src/target-resolution";
import { TargetResolutionRefusedError } from "../../src/target-resolution";

const realManifest = await import("../../src/lib/manifest");
const MANIFEST_PATH = join(tmpdir(), `hardline-uninstall-${process.pid}`, "manifest.json");

let order: string[] = [];
let unrestored: string[] = [];
let unconfirmed: string[] = [];
const prompts: string[] = [];
const reports: { title: string; lines: string[] }[] = [];
const finishes: string[] = [];
const warnings: string[] = [];
const trace: string[] = [];
const destructivePrompts: boolean[] = [];
let confirmation: PromptAnswer = "accepted";
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
  readManifest: async () => manifestOf(order),
}));

mock.module("../../src/lib/orchestrator", () => ({
  revertSteps: async (
    steps: { name: string }[],
    _config: Config,
    _manifestPath: string,
    _reporter: unknown,
    options: { selectedSteps?: readonly string[] } = {},
  ) => {
    trace.push("revert");
    const names = new Set(options.selectedSteps ?? steps.map((step) => step.name));
    return {
      unrestored: unrestored.filter((step) => names.has(step)),
      unconfirmed: unconfirmed.filter((step) => names.has(step)),
    };
  },
}));

const { uninstallCommand: executeUninstallCommand, scopeLabel, bootstrapCaveats } = await import(
  "../../src/commands/uninstall"
);

const output: CommandOutput = {
  interactive: true,
  start: () => {},
  phaseStart: () => {},
  phaseActivity: () => {},
  phaseDetail: () => {},
  phaseEnd: () => {},
  warning: (message) => warnings.push(message),
  report: (title, lines) => {
    reports.push({ title, lines });
    sequence.push(`encart:${title}`);
  },
  confirm: async (message, destructive = false) => {
    prompts.push(message);
    destructivePrompts.push(destructive);
    sequence.push("question");
    return confirmation;
  },
  choice: async (_message, _choices, initialValue) => ({ status: "selected", value: initialValue }),
  secret: async () => ({ status: "unavailable" }),
  finish: (message) => finishes.push(message),
};

const intents: TargetIntent[] = [];
const lifecycleOutcomes: string[] = [];

function targetResolution(): TargetResolution<Config> {
  return {
    async during<Result>(
      intent: TargetIntent,
      callback: (target: ResolvedTarget<Config>) => Promise<LifecycleOutcome<Result>>,
    ): Promise<LifecycleOutcome<Result>> {
      intents.push(intent);
      const lock = await realManifest.acquireManifestLock(MANIFEST_PATH);
      try {
        const outcome = await callback({
          config: CONFIG,
          manifestPath: MANIFEST_PATH,
          profile: { lifecycle: "installed" } as ResolvedTarget<Config>["profile"],
          resolution: "validated",
        });
        lifecycleOutcomes.push(outcome.lifecycle);
        return outcome;
      } finally {
        await lock.release();
      }
    },
  } as TargetResolution<Config>;
}

async function uninstallCommand(options: { yes?: boolean }): Promise<void> {
  const result = await executeUninstallCommand({
    targetResolution: targetResolution(),
    output,
    yes: options.yes,
  });
  process.exitCode = exitCodeFor(result);
}

beforeEach(() => {
  order = [
    "network-mac",
    "bootstrap-windows",
    "network-windows",
    "network-profile-task",
  ];
  unrestored = [];
  unconfirmed = [];
  prompts.length = 0;
  reports.length = 0;
  finishes.length = 0;
  warnings.length = 0;
  trace.length = 0;
  destructivePrompts.length = 0;
  confirmation = "accepted";
  sequence.length = 0;
  intents.length = 0;
  lifecycleOutcomes.length = 0;
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
    expect(scopeLabel(["network-mac"])).toBe("on the Mac");
  });

  test("nomme le PC seul", () => {
    expect(scopeLabel(["network-windows"])).toBe("on the PC");
  });

  test("ne parle des deux machines que si les deux sont enregistrees", () => {
    expect(scopeLabel(["network-mac", "network-windows"])).toBe("on both machines");
  });

  test("nomme le PC quand seul le releve d'amorcage est enregistre", () => {
    // C'est l'etat laisse par un arret sur une precondition distante apres
    // amorcage : le releve est au manifeste, aucune etape de convergence.
    expect(scopeLabel(["network-mac", "bootstrap-windows"])).toBe("on both machines");
    expect(scopeLabel(["bootstrap-windows"])).toBe("on the PC");
  });

  test("ne pretend rien d'une etape inconnue", () => {
    expect(scopeLabel(["etape-d-une-version-ulterieure"])).toBe(
      "on the affected machines",
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
    expect(lines).toContain("remains installed");
  });

  test("dit que le geste manuel d'amorcage sera a refaire", () => {
    const lines = (bootstrapCaveats(["bootstrap-windows"]) ?? []).join("\n");
    expect(lines).toContain("bootstrap again");
    expect(lines).toContain("network profile are removed");
  });

  test("nomme les sauvegardes d'Apollo laissees sur le PC", () => {
    // install montre ce chemin quand il sauvegarde ; la desinstallation le
    // taisait, et ces fichiers s'accumulent sans que rien ne les retire.
    const lines = (bootstrapCaveats(["bootstrap-windows"]) ?? []).join("\n");
    expect(lines).toContain("C:\\ProgramData\\hardline\\");
    expect(lines).toContain("Apollo configuration backups");
  });
});

describe("uninstallCommand", () => {
  test("traite explicitement l'absence de Target Profile comme deja desinstalle", async () => {
    const absent = {
      async during(): Promise<never> {
        throw new TargetResolutionRefusedError("profile-absent", "No Target Profile exists.");
      },
    } as unknown as TargetResolution<Config>;

    const result = await executeUninstallCommand({ targetResolution: absent, output, yes: true });

    expect(result.status).toBe("succeeded");
    expect(finishes.join("\n")).toContain("nothing to restore");
  });

  test("passe l'intention uninstall et publie ready-to-retire au succes", async () => {
    await uninstallCommand({ yes: true });
    expect(intents).toEqual(["uninstall"]);
    expect(lifecycleOutcomes).toEqual(["ready-to-retire"]);
  });

  test("ne demande que le Mac quand le manifeste ne contient que lui", async () => {
    // C'est l'etat laisse par un arret en phase 3 : promettre la restauration
    // des deux machines serait promettre ce qui n'aura pas lieu.
    order = ["network-mac"];
    await uninstallCommand({ yes: false });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("on the Mac");
    expect(prompts[0]).not.toContain("on both machines");
  });

  test("demande les deux machines quand les deux sont enregistrees", async () => {
    await uninstallCommand({ yes: false });
    expect(prompts[0]).toContain("on both machines");
    expect(destructivePrompts).toEqual([true]);
  });

  test("refuse la restauration non interactive sans autorisation explicite", async () => {
    confirmation = "unavailable";
    await uninstallCommand({ yes: false });

    expect(destructivePrompts).toEqual([true]);
    expect(trace).toEqual([]);
    expect(finishes.join("\n")).toBe("Nothing was changed.");
    expect(process.exitCode).toBe(1);
  });

  test("liste les etapes reellement enregistrees", async () => {
    order = ["network-mac"];
    await uninstallCommand({ yes: false });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.lines).toEqual(["Static address on the direct link (Mac)"]);
  });

  test("dit ce qui ne sera pas defait AVANT de poser la question", async () => {
    // Une restauration qui tait ses limites apres coup n'a plus rien a
    // proposer : l'utilisateur a deja repondu.
    await uninstallCommand({ yes: false });
    expect(sequence).toEqual([
      "encart:Recorded previous state",
      "encart:Changes that will remain",
      "question",
    ]);
  });

  test("n'affiche aucune nuance quand l'amorcage n'est pas enregistre", async () => {
    order = ["network-mac"];
    await uninstallCommand({ yes: false });
    expect(sequence).toEqual(["encart:Recorded previous state", "question"]);
  });

  test("ne demande rien et ne restaure rien sur un manifeste vide", async () => {
    order = [];
    await uninstallCommand({ yes: false });
    expect(prompts).toEqual([]);
    expect(trace).toEqual([]);
    expect(finishes.join("\n")).toContain("nothing to restore");
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
    expect(finishes.join("\n")).toContain("Uninstall failed safely");
    expect(process.exitCode).toBe(1);
  });

  test("annonce le lancement terminal sans pretendre en observer l'achevement", async () => {
    // Le seul endroit du programme ou il serait tentant d'affirmer ce qu'on ne
    // peut pas savoir : la derniere queue part dans un processus detache qui
    // retire l'adresse portant la session SSH. Le Mac ne reverra jamais ce PC.
    unconfirmed = ["bootstrap-windows"];
    await uninstallCommand({ yes: true });

    const message = finishes.join("\n");
    expect(message).not.toContain("Previous state restored");
    expect(message).toContain("Final Windows cleanup was launched");
    expect(message).toContain("intentionally unobservable");
    expect(process.exitCode).toBe(0);
  });

  test("annonce l'etat rendu quand tout a ete observe", async () => {
    // Le controle : sans lui, un message d'incertitude systematique
    // satisferait aussi le test precedent.
    await uninstallCommand({ yes: true });
    expect(finishes.join("\n")).toBe("Previous state restored.");
    expect(process.exitCode).toBe(0);
  });

  test("un echec observe prime sur un lancement non confirme", async () => {
    unrestored = ["network-mac"];
    unconfirmed = ["bootstrap-windows"];
    await uninstallCommand({ yes: true });
    expect(finishes.join("\n")).toContain("Restoration failed");
    expect(warnings.join("\n")).toContain("launched without observable completion");
    expect(lifecycleOutcomes).toEqual(["terminal-incomplete"]);
    expect(process.exitCode).toBe(1);
  });

  test("signale une restauration incomplete", async () => {
    unrestored = ["network-windows"];
    await uninstallCommand({ yes: true });
    expect(trace).toEqual(["revert"]);
    expect(finishes.join("\n")).toContain("Restoration failed");
    expect(process.exitCode).toBe(1);
  });
});
