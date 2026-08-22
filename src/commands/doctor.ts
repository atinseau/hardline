import { CONFIG } from "../config";
import { ALL_STEPS } from "../steps";
import { pingFrom, type PingStats } from "../lib/shell";
import {
  runLocalPreflight,
  runRemotePreflight,
  type CheckResult,
} from "../lib/preflight";
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

// Libelles fixes utilises par les lignes de latence, quelle que soit la
// branche empruntee : inclus dans le calcul de largeur pour que la colonne
// reste alignee d'une execution a l'autre, meme si le rapport rendu ne
// contient qu'une seule de ces lignes.
const FIXED_LABELS = ["Liaison", "Latence", "Latence moyenne", "Gigue", "Perte de paquets"];

function columnWidth(labels: string[]): number {
  const longest = labels.reduce((max, label) => Math.max(max, label.length), 0);
  return Math.max(22, longest + 3);
}

function pad(label: string, width: number): string {
  return `${label} :`.padEnd(width);
}

/**
 * Trois etats, pas deux. "!!" est un echec qui ne dit rien de la sante de la
 * liaison : une precondition d'installation. Il doit se voir (le taire serait
 * cacher a l'utilisateur pourquoi sa prochaine installation echouera) sans
 * pour autant compter comme une anomalie du lien.
 */
function marker(check: CheckResult): string {
  if (check.ok) return "OK  ";
  return check.installOnly ? "!!  " : "KO  ";
}

export function formatDiagnostic(diagnostic: Diagnostic): string[] {
  const lines: string[] = [];
  const width = columnWidth([
    ...diagnostic.checks.map((c) => c.name),
    ...diagnostic.steps.map((s) => s.label),
    ...FIXED_LABELS,
  ]);

  for (const check of diagnostic.checks) {
    lines.push(`${marker(check)}${pad(check.name, width)}${check.detail}`);
  }

  lines.push("");

  for (const step of diagnostic.steps) {
    lines.push(
      `${step.conforming ? "OK  " : "KO  "}${pad(step.label, width)}${step.detail}`,
    );
  }

  lines.push("");

  const { ping } = diagnostic;
  if (ping.received === 0) {
    lines.push(
      `KO  ${pad("Liaison", width)}injoignable (${ping.transmitted} paquets envoyés)`,
    );
    return lines;
  }

  if (ping.avgMs === null || ping.stddevMs === null) {
    lines.push(
      `KO  ${pad("Latence", width)}${ping.received}/${ping.transmitted} paquets reçus, statistiques indisponibles`,
    );
    return lines;
  }

  lines.push(`OK  ${pad("Latence moyenne", width)}${ping.avgMs.toFixed(2)} ms`);
  lines.push(`    ${pad("Gigue", width)}${ping.stddevMs.toFixed(2)} ms`);
  lines.push(
    `${ping.lossPercent === 0 ? "OK  " : "KO  "}${pad("Perte de paquets", width)}${ping.lossPercent} %`,
  );

  return lines;
}

export async function doctorCommand(): Promise<void> {
  configureOutput();
  ui.start("hardline — diagnostic");

  // Les deux phases, toujours. Le diagnostic doit rester lisible quand le PC
  // ne repond pas : c'est precisement le cas qu'on vient regarder. La phase
  // distante rend alors une ligne d'echec, pas une exception.
  const checks = await withSpinner("Vérification des machines", async () => [
    ...(await runLocalPreflight(CONFIG)),
    ...(await runRemotePreflight(CONFIG)),
  ]);

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

  // Le code de sortie de doctor est fait pour etre scripte : il doit dire
  // "la liaison va bien" ou "elle ne va pas", et rien d'autre. Une
  // precondition d'installation non satisfaite ne rend pas le lien malade,
  // elle rend la prochaine installation impossible. Elle se rapporte, elle ne
  // se compte pas.
  const preconditions = checks.filter((c) => !c.ok && c.installOnly);
  const healthy =
    checks.every((c) => c.ok || !c.blocking || c.installOnly) &&
    steps.every((s) => s.conforming) &&
    ping.received > 0 &&
    ping.avgMs !== null &&
    ping.stddevMs !== null;

  if (healthy) {
    ui.finish(
      preconditions.length === 0
        ? "Liaison opérationnelle."
        : `Liaison opérationnelle. ${
            preconditions.length > 1
              ? "Préconditions d'installation non satisfaites"
              : "Précondition d'installation non satisfaite"
          }\u00a0: ${preconditions.map((c) => c.name).join(", ")}.`,
    );
  } else {
    ui.finish("Anomalies détectées. Relancer «\u00a0hardline install\u00a0».");
    process.exitCode = 1;
  }
}
