import type { Config } from "../config";
import type { RestoreOutcome, Step } from "../steps/types";
import { errorMessage } from "./errors";
import {
  forgetStep,
  type Manifest,
  readManifest,
  recordStep,
  stepsInReverseOrder,
  writeManifest,
} from "./manifest";

export type StepReporter = {
  skipped(r: { label: string; detail: string }): void;
  applied(r: { label: string; detail: string }): void;
  restored(r: { label: string; detail: string }): void;
  /** Une etape qui a cede sa place. Elle n'a rien restaure : le dire. */
  yielded(r: { label: string; detail: string }): void;
  failed(r: { label: string; detail: string }): void;
};

/**
 * Rend le manifeste tel qu'il est apres la convergence. L'appelant y lit ce
 * qui est REELLEMENT enregistre, plutot que de le deduire du fait qu'aucune
 * exception n'est remontee : une etape peut se declarer conforme sans avoir
 * rien a enregistrer, et annoncer un releve qu'on n'a pas serait mentir.
 */
export async function applySteps(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: Step<any>[],
  config: Config,
  manifestPath: string,
  reporter: StepReporter,
): Promise<Manifest> {
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

  return manifest;
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

  // L'ordre est fige avant la boucle : le manifeste est reecrit a chaque
  // restauration reussie, et chaque etape doit savoir qui passe APRES elle.
  const records = stepsInReverseOrder(manifest);

  for (const [index, record] of records.entries()) {
    const step = byName.get(record.step);
    const context = {
      // Filtre par le registre, et non par le seul manifeste. `pending` sert a
      // une etape a savoir qu'une restauration plus profonde passera apres
      // elle et fera le travail a sa place ; une etape que cette version ne
      // connait plus ne restaurera rien du tout. Lui ceder la queue, c'est la
      // ceder a personne : zero script emis, PC intact, et l'enregistrement de
      // l'etape qui a cede efface au passage.
      pending: records
        .slice(index + 1)
        .map((r) => r.step)
        .filter((name) => byName.has(name)),
    };

    if (!step) {
      reporter.failed({
        label: record.step,
        detail:
          "étape inconnue de cette version de hardline\u00a0: entrée conservée dans le manifeste",
      });
      unrestored.push(record.step);
      continue;
    }

    let outcome: RestoreOutcome;
    try {
      outcome = await step.restore(config, record.previous, context);
    } catch (error) {
      // Une machine qui refuse de revenir en arriere ne doit pas empecher
      // l'autre d'etre restauree : on signale, on garde, on continue.
      reporter.failed({ label: step.label, detail: errorMessage(error) });
      unrestored.push(record.step);
      continue;
    }

    // Une etape qui a cede n'a rien restaure. Son enregistrement part quand
    // meme (la restauration plus profonde le supplante) mais le rapport doit
    // dire ce qui s'est passe, pas ce qu'on esperait.
    if (outcome) reporter.yielded({ label: step.label, detail: outcome.yielded });
    else reporter.restored({ label: step.label, detail: "état antérieur restauré" });

    manifest = forgetStep(manifest, record.step);
    await writeManifest(manifestPath, manifest);
  }

  return unrestored;
}
