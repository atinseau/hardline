import { readFile } from "node:fs/promises";
import type { Config } from "../config";
import type { CommandOutput, CommandResult, CommandRun } from "../command-run";
import { runCommand } from "../command-run";
import { englishCheckName, englishStepLabel } from "../command-run/english";
import { CAPTURE_STEPS, LOCAL_STEPS, REMOTE_STEPS } from "../steps";
import { BOOTSTRAP_STEP_NAME } from "../steps/bootstrap-name";
import { applySteps, type OrchestratorFact } from "../lib/orchestrator";
import {
  acquireManifestLock,
  defaultManifestPath,
  ManifestLockedError,
  type Manifest,
} from "../lib/manifest";
import type { CheckResult } from "../lib/preflight";
import {
  SSH_CHECK,
  hasBlockingFailure,
  missingPublicKeyMessage,
  publicKeyPath,
  runLocalPreflight,
  runRemotePreflight,
  waitForRemote,
} from "../lib/preflight";
import { localBootstrapUrl, serveBootstrap } from "../lib/bootstrap-server";
import { errorMessage } from "../lib/errors";
import {
  backupApolloConfig,
  ForeignApolloError,
  uninstallApollo,
} from "../steps/apollo-install";
import { getSecret } from "../lib/keychain";
import { forgetPassword, providePassword } from "../steps/smb-credentials";
import type { Step } from "../steps/types";

const BOOTSTRAP_DEADLINE_MS = 10 * 60_000;

type InstallFact = {
  id:
    | "title"
    | "check-mac"
    | "configure-mac"
    | "check-pc"
    | "bootstrap-pc"
    | "record-recovery"
    | "configure-pc"
    | "check"
    | "step"
    | "password"
    | "bootstrap-instructions"
    | "foreign-apollo"
    | "replace-apollo"
    | "backup"
    | "warning"
    | "success"
    | "cancelled"
    | "locked"
    | "mac-not-ready"
    | "bootstrap-failed"
    | "pc-timeout"
    | "pc-not-ready"
    | "convergence-failed"
    | "foreign-kept"
    | "unexpected";
  values?: Record<string, unknown>;
};

const fact = (id: InstallFact["id"], values?: Record<string, unknown>): InstallFact => ({
  id,
  ...(values ? { values } : {}),
});

export function renderInstallFact(value: InstallFact): string {
  const v = value.values ?? {};
  switch (value.id) {
    case "title": return "Install Hardline";
    case "check-mac": return "Check Mac";
    case "configure-mac": return "Configure Mac";
    case "check-pc": return "Check PC";
    case "bootstrap-pc": return "Bootstrap PC";
    case "record-recovery": return "Record Recovery State";
    case "configure-pc": return "Configure PC";
    case "check": return `${englishCheckName(String(v.name))}: ${v.detail}`;
    case "step": {
      const verbs = {
        conforming: "already conforming",
        applied: "applied",
        restored: "restored",
        yielded: "yielded",
        detached: "launched without confirmation",
        failed: "failed",
      } as const;
      return `${englishStepLabel(String(v.step))}: ${verbs[v.kind as keyof typeof verbs]}.`;
    }
    case "password": return `Windows account password for ${v.user}`;
    case "bootstrap-instructions": return `Run this command in an Administrator PowerShell on the PC:\n\n  irm ${v.url} | iex\n\nInstallation will resume when the PC responds.`;
    case "foreign-apollo": return `Foreign Apollo installation detected (version ${v.version}, ${v.clients} paired client(s)). ${v.backup}`;
    case "replace-apollo": return "Replace this Apollo installation with Hardline's managed installation?";
    case "backup": return `Foreign Apollo configuration backed up at ${v.path}.`;
    case "warning": return "Apollo cleanup could not complete one item. Inspect the PC before continuing.";
    case "success": return "Hardline is installed. Run 'hardline doctor' to verify the link.";
    case "cancelled": return "Installation cancelled. No unauthorized destructive action was taken.";
    case "locked": return `Installation could not start: ${v.error}`;
    case "mac-not-ready": return "Installation stopped: the Mac is not ready. Nothing was changed.";
    case "bootstrap-failed": return `PC bootstrap failed: ${v.error}. The Mac remains configured and its previous state is recorded. Run 'hardline uninstall' to restore it.`;
    case "pc-timeout": return "The PC did not respond. Run 'hardline install' again after bootstrap; the Mac's previous state remains recorded and 'hardline uninstall' restores it.";
    case "pc-not-ready": return `Installation stopped: the PC is not ready. ${v.recovery}`;
    case "convergence-failed": return `${v.area} failed. Previous state for every touched step is recorded. Fix the problem and run 'hardline install' to resume, or 'hardline uninstall' to restore it.`;
    case "foreign-kept": return "Installation stopped: the foreign Apollo installation was preserved. Non-interactive replacement requires explicit 'hardline install --yes' authorization.";
    case "unexpected": return "Installation failed safely. No unrecorded result is being reported.";
  }
}

const failed = (summary: InstallFact): CommandResult<InstallFact> => ({
  status: "failed",
  summary,
});

function reportChecks(run: CommandRun<InstallFact>, checks: CheckResult[]): void {
  for (const check of checks) {
    const value = fact("check", { name: check.name, detail: check.detail });
    if (check.ok) run.detail(value);
    else if (check.blocking) run.warning(value);
    else run.warning(value);
  }
}

const reportStep = (run: CommandRun<InstallFact>) => (step: OrchestratorFact): void => {
  const value = fact("step", step);
  if (step.kind === "failed" || step.kind === "detached") run.warning(value);
  else run.detail(value);
};

async function readPublicKey(config: Config): Promise<string> {
  let key = "";
  try {
    key = (await readFile(publicKeyPath(config), "utf8")).trim();
  } catch {}
  if (!key) throw new Error(missingPublicKeyMessage(config));
  return key;
}

async function bootstrapRemote(
  run: CommandRun<InstallFact>,
  config: Config,
): Promise<boolean> {
  const publicKey = await readPublicKey(config);
  const server = await serveBootstrap({
    port: config.bootstrapPort,
    publicKey,
    interfaceAlias: config.windows.interfaceAlias,
    windowsIp: config.windows.ip,
    prefixLength: config.windows.prefixLength,
  });
  try {
    run.report(
      fact("bootstrap-pc"),
      [fact("bootstrap-instructions", { url: localBootstrapUrl(server.port) })],
    );
    run.activity(fact("bootstrap-pc"));
    return await waitForRemote(config, BOOTSTRAP_DEADLINE_MS);
  } finally {
    server.stop();
  }
}

async function converge(
  run: CommandRun<InstallFact>,
  steps: Step<unknown>[],
  config: Config,
  manifestPath: string,
): Promise<Manifest> {
  return await applySteps(steps, config, manifestPath, reportStep(run));
}

async function replaceForeignApollo(
  run: CommandRun<InstallFact>,
  config: Config,
  manifestPath: string,
  yes: boolean,
  foreign: ForeignApolloError,
): Promise<CommandResult<InstallFact> | null> {
  run.report(fact("foreign-apollo", {
    version: foreign.state.version ?? "unknown",
    clients: foreign.state.pairedClients,
    backup: foreign.hasConfig
      ? "Its configuration will be backed up before replacement."
      : "There is no existing configuration to back up.",
  }), []);
  const answer = await run.confirm(fact("replace-apollo"), {
    assumeYes: yes,
    destructive: true,
  });
  if (answer !== "accepted") return failed(fact("foreign-kept"));

  const backupPath = await backupApolloConfig(config);
  if (backupPath) run.detail(fact("backup", { path: backupPath }));
  for (const warning of await uninstallApollo(config)) {
    run.warning(fact("warning", { message: warning }));
  }
  try {
    await run.phase(fact("configure-pc"), () =>
      converge(run, REMOTE_STEPS, config, manifestPath));
    return null;
  } catch (retryError) {
    return failed(fact("convergence-failed", { area: "PC configuration", error: errorMessage(retryError) }));
  }
}

export async function runInstall(
  run: CommandRun<InstallFact>,
  config: Config,
  options: { yes: boolean; manifestPath?: string },
): Promise<CommandResult<InstallFact>> {
  const manifestPath = options.manifestPath ?? defaultManifestPath();
  let lock;
  try {
    lock = await acquireManifestLock(manifestPath);
  } catch (error) {
    if (error instanceof ManifestLockedError) {
      return failed(fact("locked", { error: errorMessage(error) }));
    }
    throw error;
  }

  try {
    const local = await run.phase(fact("check-mac"), async () => {
      const checks = await runLocalPreflight(config);
      reportChecks(run, checks);
      return checks;
    });
    if (hasBlockingFailure(local)) return failed(fact("mac-not-ready"));

    const secret = await getSecret("windows-account");
    if (secret === null) {
      const answer = await run.secret(fact("password", { user: config.smb.user }));
      if (answer.status !== "provided") {
        return failed(fact("convergence-failed", {
          area: "Credential acquisition",
          error: "an interactive terminal is required to enter the Windows password",
        }));
      }
      providePassword(answer.value);
    }

    try {
      await run.phase(fact("configure-mac"), () =>
        converge(run, LOCAL_STEPS, config, manifestPath));
    } catch (error) {
      return failed(fact("convergence-failed", { area: "Mac configuration", error: errorMessage(error) }));
    }

    let remote = await run.phase(fact("check-pc"), async () => {
      const checks = await runRemotePreflight(config);
      reportChecks(run, checks);
      return checks;
    });
    const blocking = remote.filter((check) => !check.ok && check.blocking);
    if (blocking.length === 1 && blocking[0]?.name === SSH_CHECK) {
      try {
        const bootstrapped = await run.phase(fact("bootstrap-pc"), () =>
          bootstrapRemote(run, config));
        if (!bootstrapped) return failed(fact("pc-timeout"));
      } catch (error) {
        return failed(fact("bootstrap-failed", { error: errorMessage(error) }));
      }
      remote = await run.phase(fact("check-pc"), async () => {
        const checks = await runRemotePreflight(config);
        reportChecks(run, checks);
        return checks;
      });
    }

    const reachable = remote.some((check) => check.name === SSH_CHECK && check.ok);
    let recoveryRecorded = false;
    if (reachable) {
      try {
        const manifest = await run.phase(fact("record-recovery"), () =>
          converge(run, CAPTURE_STEPS, config, manifestPath));
        recoveryRecorded = BOOTSTRAP_STEP_NAME in manifest.steps;
      } catch (error) {
        return failed(fact("convergence-failed", { area: "Recovery capture", error: errorMessage(error) }));
      }
    }

    if (hasBlockingFailure(remote)) {
      const recovery = recoveryRecorded
        ? "The Mac is configured and PC bootstrap recovery is recorded. Run 'hardline install' to resume or 'hardline uninstall' to restore both machines."
        : reachable
          ? "The Mac's previous state is recorded, but the PC supplied no usable bootstrap recovery state. Bootstrap changes cannot be undone; 'hardline uninstall' can still restore the Mac."
          : "The Mac's previous state is recorded. Run 'hardline install' to resume or 'hardline uninstall' to restore the Mac.";
      return failed(fact("pc-not-ready", { recovery }));
    }

    try {
      await run.phase(fact("configure-pc"), () =>
        converge(run, REMOTE_STEPS, config, manifestPath));
      return { status: "succeeded", summary: fact("success") };
    } catch (error) {
      if (!(error instanceof ForeignApolloError)) {
        return failed(fact("convergence-failed", {
          area: "PC configuration",
          error: errorMessage(error),
        }));
      }
      const result = await replaceForeignApollo(
        run,
        config,
        manifestPath,
        options.yes,
        error,
      );
      return result ?? { status: "succeeded", summary: fact("success") };
    }
  } finally {
    forgetPassword();
    await lock.release();
  }
}

export function installCommand(options: {
  config: Config;
  output: CommandOutput;
  yes?: boolean;
  manifestPath?: string;
}): Promise<CommandResult<InstallFact>> {
  return runCommand({
    title: fact("title"),
    render: renderInstallFact,
    output: options.output,
    cancelled: fact("cancelled"),
    unexpected: (error) => fact("unexpected", { error: errorMessage(error) }),
    execute: (run) => runInstall(run, options.config, {
      yes: options.yes ?? false,
      ...(options.manifestPath ? { manifestPath: options.manifestPath } : {}),
    }),
  });
}
