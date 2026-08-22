import type { Config } from "../config";
import type { Step } from "../steps/types";
import {
  forgetStep,
  readManifest,
  recordStep,
  stepsInReverseOrder,
  writeManifest,
} from "./manifest";

export type StepReporter = {
  skipped(r: { label: string; detail: string }): void;
  applied(r: { label: string; detail: string }): void;
  restored(r: { label: string; detail: string }): void;
  failed(r: { label: string; detail: string }): void;
};

export async function applySteps(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: Step<any>[],
  config: Config,
  manifestPath: string,
  reporter: StepReporter,
): Promise<void> {
  let manifest = await readManifest(manifestPath);

  for (const step of steps) {
    const state = await step.inspect(config);

    if (state.conforming) {
      reporter.skipped({ label: step.label, detail: state.detail });
      continue;
    }

    // Invariant de surete : le manifeste est ecrit AVANT la modification.
    // Une interruption pendant apply laisse alors une etape enregistree mais
    // non appliquee, que le passage suivant corrige de lui-meme.
    manifest = recordStep(
      manifest,
      step.name,
      state.current,
      new Date().toISOString(),
    );
    await writeManifest(manifestPath, manifest);

    await step.apply(config);
    reporter.applied({ label: step.label, detail: state.detail });
  }
}

/**
 * Restaure l'etat anterieur, du plus recent au plus ancien. Rend la liste des
 * etapes qui n'ont pas pu etre restaurees : leur enregistrement reste dans le
 * manifeste. Oublier un enregistrement qu'on n'a pas su restaurer est le seul
 * geste irreversible du programme, puisque son etat anterieur est la seule
 * chose qui sache remettre la machine dans son etat d'origine.
 */
export async function revertSteps(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: Step<any>[],
  config: Config,
  manifestPath: string,
  reporter: StepReporter,
): Promise<string[]> {
  let manifest = await readManifest(manifestPath);
  const byName = new Map(steps.map((s) => [s.name, s]));
  const unrestored: string[] = [];

  for (const record of stepsInReverseOrder(manifest)) {
    const step = byName.get(record.step);

    if (!step) {
      reporter.failed({
        label: record.step,
        detail:
          "étape inconnue de cette version de hardline\u00a0: entrée conservée dans le manifeste",
      });
      unrestored.push(record.step);
      continue;
    }

    try {
      await step.restore(config, record.previous);
    } catch (error) {
      // Une machine qui refuse de revenir en arriere ne doit pas empecher
      // l'autre d'etre restauree : on signale, on garde, on continue.
      reporter.failed({ label: step.label, detail: (error as Error).message });
      unrestored.push(record.step);
      continue;
    }

    reporter.restored({ label: step.label, detail: "état antérieur restauré" });

    manifest = forgetStep(manifest, record.step);
    await writeManifest(manifestPath, manifest);
  }

  return unrestored;
}
