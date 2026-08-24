import type { Config } from "../config";
import type { CommandOutput, CommandResult, CommandRun } from "../command-run";
import { runCommand } from "../command-run";
import { englishCheckName, englishStepLabel } from "../command-run/english";
import { ALL_STEPS } from "../steps";
import { pingFrom, type PingStats } from "../lib/shell";
import { runLocalPreflight, runRemotePreflight, type CheckResult } from "../lib/preflight";
import { errorMessage } from "../lib/errors";
import { measureThroughput, type ThroughputStats } from "../lib/throughput";
import type { TargetResolution } from "../target-resolution";

export type StepSummary = { name: string; conforming: boolean; detail: string };
export type Diagnostic = {
  checks: CheckResult[];
  steps: StepSummary[];
  ping: PingStats;
  throughput?: ThroughputStats;
};

type DoctorFact = {
  id:
    | "title"
    | "check-machines"
    | "inspect-configuration"
    | "measure-link"
    | "check"
    | "step"
    | "latency"
    | "loss"
    | "throughput"
    | "healthy"
    | "unhealthy"
    | "unexpected";
  values?: Record<string, unknown>;
};

const fact = (id: DoctorFact["id"], values?: Record<string, unknown>): DoctorFact => ({
  id,
  ...(values ? { values } : {}),
});

export function renderDoctorFact(value: DoctorFact): string {
  const v = value.values ?? {};
  switch (value.id) {
    case "title": return "Diagnose Hardline";
    case "check-machines": return "Check Machines";
    case "inspect-configuration": return "Inspect Configuration";
    case "measure-link": return "Measure Link";
    case "check": return `${v.ok ? "OK" : v.installOnly ? "NOTICE" : "FAILED"}: ${englishCheckName(String(v.name))}: ${v.detail}`;
    case "step": return `${v.conforming ? "OK" : "FAILED"}: ${englishStepLabel(String(v.name))}.`;
    case "latency": return v.reachable
      ? `Latency: ${v.average} ms average, ${v.jitter} ms jitter.`
      : `FAILED: Link unreachable after ${v.transmitted} packets.`;
    case "loss": return `${v.ok ? "OK" : "FAILED"}: Packet loss: ${v.percent}%.`;
    case "throughput": return v.unavailable
      ? "NOTICE: Throughput was not measured because iperf3 is unavailable."
      : v.error
        ? "FAILED: Throughput measurement failed."
        : `Throughput: ${v.speed} Mbit/s.`;
    case "healthy": return v.preconditions
      ? `The link is operational. Installation prerequisites not met: ${v.preconditions}.`
      : "The link is operational.";
    case "unhealthy": return "Problems were detected. Run 'hardline install' to reconcile the configuration.";
    case "unexpected": return "Diagnosis failed safely.";
  }
}

export function formatDiagnostic(diagnostic: Diagnostic): string[] {
  const lines = [
    ...diagnostic.checks.map((check) => renderDoctorFact(fact("check", check))),
    ...diagnostic.steps.map((step) => renderDoctorFact(fact("step", step))),
  ];
  if (diagnostic.ping.received === 0) {
    lines.push(renderDoctorFact(fact("latency", {
      reachable: false,
      transmitted: diagnostic.ping.transmitted,
    })));
    return lines;
  }
  lines.push(renderDoctorFact(fact("latency", {
    reachable: diagnostic.ping.avgMs !== null && diagnostic.ping.stddevMs !== null,
    transmitted: diagnostic.ping.transmitted,
    average: diagnostic.ping.avgMs?.toFixed(2),
    jitter: diagnostic.ping.stddevMs?.toFixed(2),
  })));
  lines.push(renderDoctorFact(fact("loss", {
    ok: diagnostic.ping.lossPercent === 0,
    percent: diagnostic.ping.lossPercent,
  })));
  if (diagnostic.throughput) {
    lines.push(renderDoctorFact(fact("throughput", {
      unavailable: diagnostic.throughput.unavailable,
      error: diagnostic.throughput.error,
      speed: diagnostic.throughput.mbitsPerSecond,
    })));
  }
  return lines;
}

function publishDiagnostic(run: CommandRun<DoctorFact>, diagnostic: Diagnostic): void {
  for (const check of diagnostic.checks) {
    const value = fact("check", check);
    if (check.ok) run.detail(value);
    else run.warning(value);
  }
  for (const step of diagnostic.steps) {
    const value = fact("step", step);
    if (step.conforming) run.detail(value);
    else run.warning(value);
  }
  const ping = diagnostic.ping;
  const latency = fact("latency", {
    reachable: ping.received > 0 && ping.avgMs !== null && ping.stddevMs !== null,
    transmitted: ping.transmitted,
    average: ping.avgMs?.toFixed(2),
    jitter: ping.stddevMs?.toFixed(2),
  });
  if (ping.received > 0 && ping.avgMs !== null && ping.stddevMs !== null) run.detail(latency);
  else run.warning(latency);
  const loss = fact("loss", { ok: ping.lossPercent === 0, percent: ping.lossPercent });
  if (ping.lossPercent === 0) run.detail(loss);
  else run.warning(loss);
  if (diagnostic.throughput) {
    const throughput = fact("throughput", {
      unavailable: diagnostic.throughput.unavailable,
      error: diagnostic.throughput.error,
      speed: diagnostic.throughput.mbitsPerSecond,
    });
    if (diagnostic.throughput.error && !diagnostic.throughput.unavailable) run.warning(throughput);
    else if (diagnostic.throughput.unavailable) run.warning(throughput);
    else run.detail(throughput);
  }
}

export async function runDoctor(
  run: CommandRun<DoctorFact>,
  config: Config,
): Promise<CommandResult<DoctorFact>> {
  const checks = await run.phase(fact("check-machines"), async () => {
    const checks = [
      ...(await runLocalPreflight(config)),
      ...(await runRemotePreflight(config)),
    ];
    for (const check of checks) {
      const value = fact("check", check);
      if (check.ok) run.detail(value);
      else run.warning(value);
    }
    return checks;
  });
  const steps = await run.phase(fact("inspect-configuration"), async () => {
    const summaries: StepSummary[] = [];
    for (const step of ALL_STEPS) {
      try {
        const state = await step.inspect(config);
        summaries.push({ name: step.name, conforming: state.conforming, detail: state.detail });
      } catch (error) {
        summaries.push({ name: step.name, conforming: false, detail: errorMessage(error) });
      }
    }
    for (const step of summaries) {
      const value = fact("step", step);
      if (step.conforming) run.detail(value);
      else run.warning(value);
    }
    return summaries;
  });
  const { ping, throughput } = await run.phase(fact("measure-link"), async () => {
    const ping = await pingFrom(config.mac.ip, config.windows.ip, 20);
    const throughput = ping.received > 0 ? await measureThroughput(config) : undefined;
    publishDiagnostic(run, { checks: [], steps: [], ping, ...(throughput ? { throughput } : {}) });
    return { ping, throughput };
  });
  const throughputFailed = throughput !== undefined && !throughput.unavailable && throughput.error !== null;
  const healthy =
    checks.every((check) => check.ok || !check.blocking || check.installOnly) &&
    steps.every((step) => step.conforming) &&
    ping.received > 0 && ping.avgMs !== null && ping.stddevMs !== null &&
    !throughputFailed;
  if (!healthy) return { status: "failed", summary: fact("unhealthy") };
  const preconditions = checks.filter((check) => !check.ok && check.installOnly);
  return {
    status: "succeeded",
    summary: fact("healthy", {
      preconditions: preconditions.map((check) => englishCheckName(check.name)).join(", ") || null,
    }),
  };
}

export function doctorCommand(options: {
  targetResolution: TargetResolution<Config>;
  output: CommandOutput;
}): Promise<CommandResult<DoctorFact>> {
  return runCommand({
    title: fact("title"),
    render: renderDoctorFact,
    output: options.output,
    unexpected: (error) => fact("unexpected", { error: errorMessage(error) }),
    execute: async (run) => {
      const outcome = await options.targetResolution.during("doctor", async (target) => ({
        lifecycle: "unchanged",
        result: await runDoctor(run, target.config),
      }));
      return outcome.result;
    },
  });
}
