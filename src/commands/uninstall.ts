import type { Config } from "../config";
import type { CommandOutput, CommandResult, CommandRun } from "../command-run";
import { runCommand } from "../command-run";
import { englishStepLabel } from "../command-run/english";
import { ALL_STEPS, LOCAL_STEPS, WINDOWS_STEPS } from "../steps";
import { bootstrapWindowsStep } from "../steps/bootstrap-windows";
import { revertSteps, type OrchestratorFact } from "../lib/orchestrator";
import {
  acquireManifestLock,
  defaultManifestPath,
  ManifestLockedError,
  readManifest,
} from "../lib/manifest";
import { errorMessage } from "../lib/errors";

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
    | "failed"
    | "incomplete"
    | "locked"
    | "unexpected";
  values?: Record<string, unknown>;
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
    case "failed": return "Restoration failed. Unrestored entries remain recorded for another attempt.";
    case "incomplete": return "Restoration was launched on the PC but cannot be observed from the Mac. Verify at the PC that its original addressing and network profile were restored. The previous state remains recorded until it can be confirmed.";
    case "locked": return `Uninstall could not start: ${v.error}`;
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
  options: { yes: boolean; manifestPath?: string },
): Promise<CommandResult<UninstallFact>> {
  const manifestPath = options.manifestPath ?? defaultManifestPath();
  let lock;
  try {
    lock = await acquireManifestLock(manifestPath);
  } catch (error) {
    if (error instanceof ManifestLockedError) {
      return { status: "failed", summary: fact("locked", { error: errorMessage(error) }) };
    }
    throw error;
  }

  try {
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

    const report = await run.phase(fact("restore"), () =>
      revertSteps(ALL_STEPS, config, manifestPath, reportStep(run)));
    if (report.unrestored.length > 0) {
      run.warning(fact("warning", {
        message: `Unrestored steps retained in the manifest: ${report.unrestored.join(", ")}.`,
      }));
    }
    if (report.unconfirmed.length > 0) {
      run.warning(fact("warning", {
        message: `Unconfirmed PC steps retained in the manifest: ${report.unconfirmed.join(", ")}.`,
      }));
    }
    if (report.unrestored.length > 0) {
      return { status: "failed", summary: fact("failed") };
    }
    if (report.unconfirmed.length > 0) {
      return { status: "incomplete", summary: fact("incomplete") };
    }
    return { status: "succeeded", summary: fact("success") };
  } finally {
    await lock.release();
  }
}

export function uninstallCommand(options: {
  config: Config;
  output: CommandOutput;
  yes?: boolean;
  manifestPath?: string;
}): Promise<CommandResult<UninstallFact>> {
  return runCommand({
    title: fact("title"),
    render: renderUninstallFact,
    output: options.output,
    cancelled: fact("cancelled"),
    unexpected: (error) => fact("unexpected", { error: errorMessage(error) }),
    execute: (run) => runUninstall(run, options.config, {
      yes: options.yes ?? false,
      ...(options.manifestPath ? { manifestPath: options.manifestPath } : {}),
    }),
  });
}
