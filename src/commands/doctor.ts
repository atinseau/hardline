import { CONFIG } from "../config";
import { ALL_STEPS } from "../steps";
import { pingFrom, type PingStats } from "../lib/shell";
import { runPreflight, type CheckResult } from "../lib/preflight";
import { configureOutput, ui, withSpinner } from "../lib/ui";
import { errorMessage } from "../lib/errors";

export type StepSummary = {
  label: string;
  conforming: boolean;
  detail: string;
};

export type Diagnostic = {
  checks: CheckResult[];
  steps: StepSummary[];
  ping: PingStats;
};

function pad(label: string): string {
  return `${label} :`.padEnd(22);
}

export function formatDiagnostic(diagnostic: Diagnostic): string[] {
  const lines: string[] = [];

  for (const check of diagnostic.checks) {
    lines.push(`${check.ok ? "OK  " : "KO  "}${pad(check.name)}${check.detail}`);
  }

  lines.push("");

  for (const step of diagnostic.steps) {
    lines.push(
      `${step.conforming ? "OK  " : "KO  "}${pad(step.label)}${step.detail}`,
    );
  }

  lines.push("");

  const { ping } = diagnostic;
  if (ping.received === 0) {
    lines.push(
      `KO  ${pad("Liaison")}injoignable (${ping.transmitted} paquets envoyés)`,
    );
    return lines;
  }

  lines.push(`OK  ${pad("Latence moyenne")}${ping.avgMs?.toFixed(2)} ms`);
  lines.push(`    ${pad("Gigue")}${ping.stddevMs?.toFixed(2)} ms`);
  lines.push(
    `${ping.lossPercent === 0 ? "OK  " : "KO  "}${pad("Perte de paquets")}${ping.lossPercent} %`,
  );

  return lines;
}

export async function doctorCommand(): Promise<void> {
  configureOutput();
  ui.start("hardline — diagnostic");

  const checks = await withSpinner("Vérification des machines", async () =>
    runPreflight(CONFIG),
  );

  const steps: StepSummary[] = [];
  for (const step of ALL_STEPS) {
    try {
      const state = await step.inspect(CONFIG);
      steps.push({
        label: step.label,
        conforming: state.conforming,
        detail: state.detail,
      });
    } catch (error) {
      steps.push({
        label: step.label,
        conforming: false,
        detail: errorMessage(error),
      });
    }
  }

  const ping = await withSpinner("Mesure de la latence", async () =>
    pingFrom(CONFIG.mac.ip, CONFIG.windows.ip, 20),
  );

  ui.report("Diagnostic", formatDiagnostic({ checks, steps, ping }));

  const healthy =
    checks.every((c) => c.ok || !c.blocking) &&
    steps.every((s) => s.conforming) &&
    ping.received > 0;

  if (healthy) {
    ui.finish("Liaison opérationnelle.");
  } else {
    ui.finish("Anomalies détectées. Relancer «\u00a0hardline install\u00a0».");
    process.exitCode = 1;
  }
}
