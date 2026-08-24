import type { Config } from "../config";
import type { CommandOutput, CommandResult, CommandRun } from "../command-run";
import { runCommand } from "../command-run";
import { englishStepLabel } from "../command-run/english";
import { ALL_STEPS, CAPTURE_STEPS, LOCAL_STEPS, REMOTE_STEPS, WINDOWS_STEPS } from "../steps";
import { bootstrapWindowsStep } from "../steps/bootstrap-windows";
import { revertSteps, type OrchestratorFact } from "../lib/orchestrator";
import { readManifest } from "../lib/manifest";
import { errorMessage } from "../lib/errors";
import {
  TargetResolutionRefusedError,
  type TargetResolution,
} from "../target-resolution";

type UninstallFact = {
  id:
    | "title"
    | "inspect"
    | "restore"
    | "recorded-title"
    | "recorded"
    | "caveats-title"
    | "caveat"
    | "confirm"
    | "step"
    | "warning"
    | "nothing"
    | "cancelled"
    | "success"
    | "tail-launched"
    | "failed"
    | "incomplete"
    | "unexpected";
  values?: Record<string, unknown>;
};

type UninstallResult = CommandResult<UninstallFact> & {
  readonly terminalLaunched?: true;
};

const fact = (id: UninstallFact["id"], values?: Record<string, unknown>): UninstallFact => ({
  id,
  ...(values ? { values } : {}),
});

export function renderUninstallFact(value: UninstallFact): string {
  const v = value.values ?? {};
  switch (value.id) {
    case "title": return "Uninstall Hardline";
    case "inspect": return "Inspect Recorded State";
    case "restore": return "Restore Previous State";
    case "recorded-title": return "Recorded previous state";
    case "recorded": return String(v.label);
    case "caveats-title": return "Changes that will remain";
    case "caveat": return String(v.text);
    case "confirm": return `Restore the previous network configuration ${v.scope}?`;
    case "step": return `${englishStepLabel(String(v.step))}: ${v.kind}.`;
    case "warning": return String(v.message);
    case "nothing": return "No recorded steps; there is nothing to restore.";
    case "cancelled": return "Nothing was changed.";
    case "success": return "Previous state restored.";
    case "tail-launched": return "Final Windows cleanup was launched. Its completion is intentionally unobservable; local Hardline state can now be removed.";
    case "failed": return "Restoration failed. Unrestored entries remain recorded for another attempt.";
    case "incomplete": return "Restoration was launched on the PC but cannot be observed from the Mac. Verify at the PC that its original addressing and network profile were restored. The previous state remains recorded until it can be confirmed.";
    case "unexpected": return "Uninstall failed safely. Recorded state was retained.";
  }
}

export function scopeLabel(recorded: string[]): string {
  const touches = (steps: { name: string }[]) =>
    recorded.some((name) => steps.some((step) => step.name === name));
  const mac = touches(LOCAL_STEPS);
  const pc = touches(WINDOWS_STEPS);
  if (mac && pc) return "on both machines";
  if (mac) return "on the Mac";
  if (pc) return "on the PC";
  return "on the affected machines";
}

export function recordedLabels(recorded: string[]): string[] {
  return recorded.map(englishStepLabel);
}

export function bootstrapCaveats(recorded: string[]): string[] | null {
  if (!recorded.includes(bootstrapWindowsStep.name)) return null;
  return [
    "The Windows OpenSSH Server capability remains installed because removing it requires a restart and it may be used independently.",
    "The sshd service returns to its original startup and running state.",
    "The Mac public key, firewall rule, direct-link addressing, and network profile are removed, so a future installation requires manual PC bootstrap again.",
    "Apollo configuration backups remain under C:\\ProgramData\\hardline\\ and are never deleted by Hardline.",
  ];
}

const reportStep = (run: CommandRun<UninstallFact>) => (step: OrchestratorFact): void => {
  const value = fact("step", step);
  if (step.kind === "failed" || step.kind === "detached") run.warning(value);
  else run.detail(value);
};

export async function runUninstall(
  run: CommandRun<UninstallFact>,
  config: Config,
  options: { yes: boolean; manifestPath: string },
): Promise<UninstallResult> {
  const manifestPath = options.manifestPath;
  const manifest = await run.phase(fact("inspect"), () => readManifest(manifestPath));
  const recorded = manifest.order;
  if (recorded.length === 0) return { status: "succeeded", summary: fact("nothing") };

  run.report(
    fact("recorded-title"),
    recordedLabels(recorded).map((label) => fact("recorded", { label })),
  );
  const caveats = bootstrapCaveats(recorded);
  if (caveats) {
    run.report(
      fact("caveats-title"),
      caveats.map((text) => fact("caveat", { text })),
    );
  }

  const answer = await run.confirm(fact("confirm", { scope: scopeLabel(recorded) }), {
    assumeYes: options.yes,
    destructive: true,
  });
  if (answer !== "accepted") return { status: "cancelled", summary: fact("cancelled") };

  const macNetwork = LOCAL_STEPS.filter((step) => step.name === "network-mac");
  const observable = [
    ...LOCAL_STEPS.filter((step) => step.name !== "network-mac"),
    ...REMOTE_STEPS,
  ];
  const observed = await run.phase(fact("restore"), () =>
    revertSteps(ALL_STEPS, config, manifestPath, reportStep(run), {
      selectedSteps: observable.map((step) => step.name),
    }));
  if (observed.unrestored.length > 0 || observed.unconfirmed.length > 0) {
    for (const step of observed.unrestored) {
      run.warning(fact("warning", { message: `Unrestored step retained in the manifest: ${step}.` }));
    }
    for (const step of observed.unconfirmed) {
      run.warning(fact("warning", { message: `PC cleanup step launched without observable completion: ${step}.` }));
    }
    return observed.unrestored.length > 0
      ? { status: "failed", summary: fact("failed") }
      : { status: "incomplete", summary: fact("incomplete") };
  }

  // The channel-cutting tail is launched only after every fallible,
  // independently observable restoration has succeeded. Mac networking is
  // restored last because it carries the SSH session used to launch the tail.
  const terminal = [...macNetwork, ...CAPTURE_STEPS];
  const report = await run.phase(fact("restore"), () =>
    revertSteps(ALL_STEPS, config, manifestPath, reportStep(run), {
      selectedSteps: terminal.map((step) => step.name),
    }));
  if (report.unrestored.length > 0) {
    run.warning(fact("warning", {
      message: `Unrestored steps retained in the manifest: ${report.unrestored.join(", ")}.`,
    }));
  }
  if (report.unconfirmed.length > 0) {
    run.warning(fact("warning", {
      message: `PC cleanup steps launched without observable completion: ${report.unconfirmed.join(", ")}.`,
    }));
  }
  if (report.unrestored.length > 0) {
    return {
      status: "failed",
      summary: fact("failed"),
      ...(report.unconfirmed.length > 0 ? { terminalLaunched: true as const } : {}),
    };
  }
  if (report.unconfirmed.length > 0) {
    const terminal = report.unconfirmed.every((step) =>
      step === bootstrapWindowsStep.name || step === "network-windows");
    if (terminal) {
      return { status: "succeeded", summary: fact("tail-launched") };
    }
    return { status: "incomplete", summary: fact("incomplete") };
  }
  return { status: "succeeded", summary: fact("success") };
}

export function uninstallCommand(options: {
  targetResolution: TargetResolution<Config>;
  output: CommandOutput;
  yes?: boolean;
}): Promise<CommandResult<UninstallFact>> {
  return runCommand({
    title: fact("title"),
    render: renderUninstallFact,
    output: options.output,
    cancelled: fact("cancelled"),
    unexpected: (error) => fact("unexpected", { error: errorMessage(error) }),
    execute: async (run) => {
      try {
        const outcome = await options.targetResolution.during<CommandResult<UninstallFact>>(
          "uninstall",
          async (target) => {
            const result = await runUninstall(run, target.config, {
              yes: options.yes ?? false,
              manifestPath: target.manifestPath,
            });
            if (result.status === "succeeded") {
              return { lifecycle: "ready-to-retire", result } as const;
            }
            if (result.terminalLaunched) {
              return { lifecycle: "terminal-incomplete", result } as const;
            }
            if (result.status === "cancelled") {
              return { lifecycle: "unchanged", result } as const;
            }
            return { lifecycle: "incomplete", result } as const;
          },
        );
        return outcome.result;
      } catch (error) {
        if (
          error instanceof TargetResolutionRefusedError &&
          error.reason === "profile-absent"
        ) {
          return { status: "succeeded", summary: fact("nothing") };
        }
        throw error;
      }
    },
  });
}
