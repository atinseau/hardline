import type { Config } from "../config";
import type { CommandOutput, CommandResult, CommandRun } from "../command-run";
import { runCommand } from "../command-run";
import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import { sendMagicPacket } from "../lib/wol";
import { waitForRemote } from "../lib/preflight";
import { colorProfileIssue, listDisplays, type Display } from "../lib/display";
import { getSecret } from "../lib/keychain";
import { mountShare, unmountShare } from "../lib/smb";
import { runStream, runQuit, type StreamOptions } from "../lib/moonlight";
import { errorMessage } from "../lib/errors";
import type { TargetResolution } from "../target-resolution";

const WAKE_DEADLINE_MS = 3 * 60_000;

export type ResolutionOption = { width: number; height: number };
export type UpCliOptions = {
  fullscreen: boolean;
  resolution?: string | null;
  fps?: string | null;
  monitor?: boolean;
};

type UpFact = {
  id: "title" | "prepare" | "activity" | "choose-display" | "display-choice" |
    "color-warning" | "color-ok" | "success" | "stream-failed" | "invalid-options" | "preparation-failed" | "failed" | "cancelled";
  values?: Record<string, unknown>;
};

const fact = (id: UpFact["id"], values?: Record<string, unknown>): UpFact => ({
  id,
  ...(values ? { values } : {}),
});

export function renderUpFact(value: UpFact): string {
  const v = value.values ?? {};
  switch (value.id) {
    case "title": return "Open Hardline Session";
    case "prepare": return "Prepare Session";
    case "activity": return String(v.message);
    case "choose-display": return "Which display should open the video stream?";
    case "display-choice": return String(v.label);
    case "color-warning": return String(v.message);
    case "color-ok": return `Color profile validated: ${v.profile}.`;
    case "success": return "Session ended.";
    case "stream-failed": return `Session ended with Moonlight exit code ${v.code}.`;
    case "invalid-options": return `Invalid options: ${v.error}`;
    case "preparation-failed": return `Could not prepare the session: ${v.error}`;
    case "failed": return "Could not open the session. No native command output was included.";
    case "cancelled": return "Session opening cancelled.";
  }
}

export function parseResolution(value: string): ResolutionOption {
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) throw new Error(`Invalid resolution: expected WIDTHxHEIGHT (${value})`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function parseFps(value: string): number {
  const fps = Number(value);
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new Error(`Invalid frame rate: expected a positive integer (${value})`);
  }
  return fps;
}

export function buildStreamOptions(cli: UpCliOptions): StreamOptions {
  return {
    fullscreen: cli.fullscreen,
    resolution: cli.resolution ? parseResolution(cli.resolution) : null,
    fps: cli.fps ? parseFps(cli.fps) : null,
    ...(cli.monitor ? { monitor: true } : {}),
  };
}

export function displayChoiceLabel(display: Display, index: number): string {
  const refresh = display.refreshHz > 0 ? ` at ${display.refreshHz} Hz` : "";
  const scaleX = display.widthPt > 0 ? display.widthPx / display.widthPt : 1;
  const scaleY = display.heightPt > 0 ? display.heightPx / display.heightPt : 1;
  const scale = Math.abs(scaleX - scaleY) < 0.01 ? scaleX : Math.min(scaleX, scaleY);
  const roundedScale = Math.round(scale * 100) / 100;
  const scaleLabel = roundedScale > 1 ? `Retina ${roundedScale}x` : `scale ${roundedScale}x`;
  const profile = display.colorProfile ? `, profile ${display.colorProfile}` : ", unknown profile";
  return `Display ${index + 1}: ${display.widthPx}x${display.heightPx} px${refresh}, ${scaleLabel}${profile}${display.main ? ", main" : ""}`;
}

export async function chooseDisplay(
  run: CommandRun<UpFact>,
  displays: readonly Display[],
): Promise<Display | null> {
  if (displays.length === 0) return null;
  if (displays.length === 1) return displays[0]!;
  const mainIndex = Math.max(0, displays.findIndex((display) => display.main));
  const selected = await run.choice(
    fact("choose-display"),
    displays.map((display, index) => ({
      value: String(index),
      label: fact("display-choice", { label: displayChoiceLabel(display, index) }),
    })),
    String(mainIndex),
  );
  if (selected.status !== "selected") return displays[mainIndex]!;
  return displays[Number(selected.value)] ?? displays[mainIndex]!;
}

export function broadcastAddress(ip: string, subnetMask: string): string {
  const ipParts = ip.split(".").map(Number);
  const maskParts = subnetMask.split(".").map(Number);
  const valid = ipParts.length === 4 && maskParts.length === 4 &&
    ipParts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    maskParts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  if (!valid) throw new Error(`Invalid IPv4 address or subnet mask: ${ip}/${subnetMask}`);
  return ipParts.map((octet, index) =>
    (octet | (~maskParts[index]! & 0xff)) & 0xff).join(".");
}

async function pcReachable(config: Config): Promise<boolean> {
  try {
    await runRemoteJson(config.ssh, "[pscustomobject]@{ ok = $true }");
    return true;
  } catch {
    return false;
  }
}

async function wakePC(config: Config): Promise<void> {
  const broadcast = broadcastAddress(config.mac.ip, config.mac.subnetMask);
  const wake = () => sendMagicPacket(config.windows.macAddress, broadcast);
  await wake();
  // Re-emit before every probe: a freshly plugged adapter may not have been
  // configured yet when the first burst left, so it went out the default route.
  if (!(await waitForRemote(config, WAKE_DEADLINE_MS, Bun.sleep, Date.now, wake))) {
    throw new Error(`The PC did not respond within ${WAKE_DEADLINE_MS / 60_000} minutes after wake.`);
  }
}

const APOLLO_STATUS = (name: string) => `
$svc = Get-Service -Name '${name}' -ErrorAction SilentlyContinue
[pscustomobject]@{ status = if ($svc) { [string]$svc.Status } else { $null } }`;

async function ensureApolloRunning(config: Config): Promise<void> {
  const rows = await runRemoteJson<{ status: string | null }>(
    config.ssh,
    APOLLO_STATUS(config.apollo.serviceName),
  );
  if (rows[0]?.status === "Running") return;
  await runRemoteChecked(config.ssh, `Start-Service -Name '${config.apollo.serviceName}'`);
  const recheck = await runRemoteJson<{ status: string | null }>(
    config.ssh,
    APOLLO_STATUS(config.apollo.serviceName),
  );
  if (recheck[0]?.status !== "Running") {
    throw new Error(`Service '${config.apollo.serviceName}' did not start (status: ${recheck[0]?.status ?? "unknown"}).`);
  }
}

export async function runUp(
  run: CommandRun<UpFact>,
  config: Config,
  options: StreamOptions,
  selectedDisplay: Display | null,
): Promise<number> {
  let mounted = false;
  try {
    await run.phase(fact("prepare"), async () => {
      if (!(await pcReachable(config))) {
        run.activity(fact("activity", { message: "Wake PC" }));
        await wakePC(config);
      }
      run.activity(fact("activity", { message: "Start Apollo service" }));
      await ensureApolloRunning(config);
      run.activity(fact("activity", { message: "Reset video mode" }));
      await runQuit(config);
      if (config.smb.shares.length > 0) {
        const password = await getSecret("windows-account");
        if (password === null) {
          throw new Error("No Windows password is stored in the keychain. Run 'hardline install' first.");
        }
        run.activity(fact("activity", { message: "Mount shares" }));
        mounted = true;
        for (const share of config.smb.shares) await mountShare(share, config, password);
      }
    });
    // No Command Run phase is active while Moonlight owns the terminal.
    try {
      return await runStream(config, selectedDisplay, options);
    } catch {
      throw new StreamLaunchError();
    }
  } finally {
    if (mounted) await releaseSession(config);
  }
}

class StreamLaunchError extends Error {}

async function releaseSession(config: Config): Promise<void> {
  for (const share of config.smb.shares) {
    try {
      await unmountShare(share);
    } catch {}
  }
  try {
    await runQuit(config);
  } catch {}
}

export async function runUpCommand(
  run: CommandRun<UpFact>,
  config: Config,
  cliOptions: UpCliOptions,
): Promise<CommandResult<UpFact>> {
  let options: StreamOptions;
  try {
    options = buildStreamOptions(cliOptions);
  } catch (error) {
    return { status: "failed", summary: fact("invalid-options", { error: errorMessage(error) }) };
  }
  const display = await chooseDisplay(run, await listDisplays());
  if (display) {
    const issue = colorProfileIssue(display);
    if (issue) run.warning(fact("color-warning", { message: issue }));
    else run.detail(fact("color-ok", { profile: display.colorProfile }));
  }
  try {
    const exitCode = await runUp(run, config, options, display);
    return exitCode === 0
      ? { status: "succeeded", summary: fact("success") }
      : { status: "failed", summary: fact("stream-failed", { code: exitCode }) };
  } catch (error) {
    return error instanceof StreamLaunchError
      ? { status: "failed", summary: fact("failed") }
      : { status: "failed", summary: fact("preparation-failed", { error: errorMessage(error) }) };
  }
}

export function upCommand(options: {
  targetResolution: TargetResolution<Config>;
  output: CommandOutput;
  cli: UpCliOptions;
}): Promise<CommandResult<UpFact>> {
  return runCommand({
    title: fact("title"),
    render: renderUpFact,
    output: options.output,
    cancelled: fact("cancelled"),
    unexpected: (error) => fact("failed", { error: errorMessage(error) }),
    execute: async (run) => {
      const outcome = await options.targetResolution.during("up", async (target) => ({
        lifecycle: "unchanged",
        result: await runUpCommand(run, target.config, options.cli),
      }));
      return outcome.result;
    },
  });
}
