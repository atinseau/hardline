import { beforeEach, describe, expect, mock, test } from "bun:test";
import { CONFIG, type Config } from "../fixtures/config";
import { exitCodeFor, type CommandOutput } from "../../src/command-run";
import type {
  LifecycleOutcome,
  ResolvedTarget,
  TargetIntent,
  TargetResolution,
} from "../../src/target-resolution";
import { TargetResolution as RealTargetResolution } from "../../src/target-resolution/resolution";
import { DirectLinkUnavailableError } from "../../src/target-resolution/link-recovery";

let shutdownError: Error | null = null;
const runRemoteChecked = mock(async (..._args: unknown[]) => {
  if (shutdownError) throw shutdownError;
  return { exitCode: 0, stdout: "", stderr: "" };
});
mock.module("../../src/lib/ssh", () => ({ runRemoteChecked }));

const { downCommand: executeDownCommand } = await import("../../src/commands/down");

const phases: string[] = [];
const finishes: Array<{ message: string; status: string }> = [];
const output: CommandOutput = {
  interactive: true,
  start: () => {},
  phaseStart: (message) => phases.push(message),
  phaseActivity: () => {},
  phaseDetail: () => {},
  phaseEnd: () => {},
  warning: () => {},
  report: () => {},
  confirm: async () => "accepted",
  choice: async (_message, _choices, initialValue) => ({ status: "selected", value: initialValue }),
  secret: async () => ({ status: "unavailable" }),
  finish: (message, status) => finishes.push({ message, status }),
};

const intents: TargetIntent[] = [];
const lifecycles: string[] = [];
const targetResolution = {
  async during<Result>(
    intent: TargetIntent,
    callback: (target: ResolvedTarget<Config>) => Promise<LifecycleOutcome<Result>>,
  ): Promise<LifecycleOutcome<Result>> {
    intents.push(intent);
    const outcome = await callback({
      config: CONFIG,
      manifestPath: "/state/manifest.json",
      profile: { lifecycle: "installed" } as ResolvedTarget<Config>["profile"],
      resolution: "validated",
    });
    lifecycles.push(outcome.lifecycle);
    return outcome;
  },
} as TargetResolution<Config>;

beforeEach(() => {
  shutdownError = null;
  runRemoteChecked.mockClear();
  phases.length = 0;
  finishes.length = 0;
  intents.length = 0;
  lifecycles.length = 0;
});

describe("downCommand", () => {
  test("demande un arret Windows immediat et planifie", async () => {
    const result = await executeDownCommand({ targetResolution, output });
    const script = String((runRemoteChecked.mock.calls[0] as unknown[])[1]);

    expect(result.status).toBe("succeeded");
    expect(script).toContain('$env:SystemRoot\\System32\\shutdown.exe');
    expect(script).toContain("/s /f /t 5");
    expect(script).toContain("/d p:0:0");
    expect(script).toContain("$LASTEXITCODE -ne 0");
    expect(script).toContain("throw");
    expect(phases).toEqual(["Shut Down PC"]);
  });

  test("passe l'intention down et conserve le cycle de vie", async () => {
    await executeDownCommand({ targetResolution, output });
    expect(intents).toEqual(["down"]);
    expect(lifecycles).toEqual(["unchanged"]);
  });

  test("rapporte seulement que la demande a ete acceptee", async () => {
    const result = await executeDownCommand({ targetResolution, output });
    expect(exitCodeFor(result)).toBe(0);
    expect(finishes).toEqual([{
      message: "PC shutdown requested.",
      status: "succeeded",
    }]);
  });

  test("sort en echec quand Windows refuse la demande", async () => {
    shutdownError = new Error("Remote command failed with exit code 1.");
    const result = await executeDownCommand({ targetResolution, output });
    expect(exitCodeFor(result)).toBe(1);
    expect(finishes[0]?.message).toContain("exit code 1");
    expect(finishes[0]?.status).toBe("failed");
  });

  test("ne demande aucun arret quand Link Recovery ne peut pas joindre le PC", async () => {
    const profile = { lifecycle: "installed" } as ResolvedTarget<Config>["profile"];
    const realTargetResolution = new RealTargetResolution<Config>({
      paths: { profile: "/state/target-profile.json", manifest: "/state/manifest.json" },
      profiles: {
        read: async () => profile,
        write: async () => {},
        remove: async () => {},
      },
      acquireLock: async () => ({ release: async () => {} }),
      validateProfile: async () => profile,
      projectConfig: () => CONFIG,
      recoverLink: async () => {
        throw new DirectLinkUnavailableError("pc-inaccessible");
      },
      removeManifest: async () => {},
      removeIdentity: async () => {},
    });

    const result = await executeDownCommand({ targetResolution: realTargetResolution, output });
    expect(result.status).toBe("failed");
    expect(runRemoteChecked).not.toHaveBeenCalled();
  });
});
