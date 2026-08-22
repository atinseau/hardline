import type { Config } from "../config";
import type { RestoreOutcome, Step } from "../steps/types";
import { errorMessage } from "./errors";
import {
  forgetStep,
  type Manifest,
  markLaunched,
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
  /** Une etape lancee sur le PC, dont la fin n'est pas observable d'ici. */
  detached(r: { label: string; detail: string }): void;
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
 * Ce qu'une desinstallation n'a pas mene a son terme, et pourquoi.
 *
 * La distinction est la substance de ce type. Un echec est une chose que le
 * programme a VUE echouer ; un lancement non confirme est une chose qu'il n'a
 * pas pu voir du tout. Les confondre reviendrait a inventer une panne, ou pire,
 * a annoncer une reussite. Dans les deux cas l'enregistrement du manifeste est
 * conserve.
 */
export type RevertReport = {
  unrestored: string[];
  unconfirmed: string[];
};

/**
 * Restaure l'etat anterieur, du plus recent au plus ancien.
 *
 * Oublier un enregistrement est le seul geste irreversible du programme,
 * puisque l'etat anterieur qu'il contient est la seule chose qui sache remettre
 * la machine dans son etat d'origine. Il n'a donc lieu que pour une
 * restauration OBSERVEE : ni une restauration en echec, ni une restauration
 * confiee a un processus detache dont personne ne verra jamais la fin.
 */
export async function revertSteps(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: Step<any>[],
  config: Config,
  manifestPath: string,
  reporter: StepReporter,
): Promise<RevertReport> {
  let manifest = await readManifest(manifestPath);
  const byName = new Map(steps.map((s) => [s.name, s]));
  const unrestored: string[] = [];
  const unconfirmed: string[] = [];

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
      // Une etape deja lancee lors d'une desinstallation precedente ne peut pas
      // echouer a neuf : la queue detachee a rendu le PC injoignable par
      // construction, et c'est le resultat attendu d'une reussite. Rapporter
      // une panne ici ferait conclure a une restauration incomplete sur un etat
      // final correct. Le doute est le meme qu'avant, ni plus ni moins.
      if (typeof record.launchedAt === "string") {
        reporter.detached({
          label: step.label,
          detail: `déjà lancée le ${record.launchedAt}, et toujours pas confirmable\u00a0: ${errorMessage(error)}`,
        });
        unconfirmed.push(record.step);
        continue;
      }

      // Une machine qui refuse de revenir en arriere ne doit pas empecher
      // l'autre d'etre restauree : on signale, on garde, on continue.
      reporter.failed({ label: step.label, detail: errorMessage(error) });
      unrestored.push(record.step);
      continue;
    }

    // Lancee, pas achevee. L'enregistrement RESTE : c'est la seule description
    // de l'etat d'origine, et on ne l'echange pas contre l'espoir qu'une charge
    // detachee a abouti sur une machine devenue injoignable.
    if (outcome && "detached" in outcome) {
      reporter.detached({ label: step.label, detail: outcome.detached });
      unconfirmed.push(record.step);
      // Le lancement est date dans le manifeste. L'enregistrement lui-meme ne
      // bouge pas : une desinstallation ulterieure saura seulement que le geste
      // a deja eu lieu, et ne rapportera pas comme un echec neuf ce qui n'est
      // que le meme doute.
      manifest = markLaunched(manifest, record.step, new Date().toISOString());
      await writeManifest(manifestPath, manifest);
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

  return { unrestored, unconfirmed };
}
