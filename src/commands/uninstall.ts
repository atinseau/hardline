import { CONFIG } from "../config";
import { ALL_STEPS, LOCAL_STEPS, REMOTE_STEPS } from "../steps";
import { revertSteps } from "../lib/orchestrator";
import { defaultManifestPath, readManifest } from "../lib/manifest";
import { askConfirmation, configureOutput, ui } from "../lib/ui";

/**
 * Ce que la question doit nommer, deduit du manifeste et non affirme : un
 * arret en phase distante n'enregistre que le Mac, et demander a l'utilisateur
 * de tout restaurer sur les deux machines lui promettrait ce qui n'aura pas lieu.
 */
export function scopeLabel(recorded: string[]): string {
  const touches = (steps: { name: string }[]) =>
    recorded.some((name) => steps.some((s) => s.name === name));
  const mac = touches(LOCAL_STEPS);
  const pc = touches(REMOTE_STEPS);

  if (mac && pc) return "des deux machines";
  if (mac) return "du Mac";
  if (pc) return "du PC";
  // Une etape enregistree par une version ulterieure de hardline : on ne sait
  // pas de quelle machine elle vient, on ne le pretend pas.
  return "des machines concernées";
}

/** Le libelle lisible d'une etape enregistree, ou son nom brut si inconnue. */
export function recordedLabels(recorded: string[]): string[] {
  return recorded.map(
    (name) => ALL_STEPS.find((s) => s.name === name)?.label ?? name,
  );
}

export async function uninstallCommand(options: { yes: boolean }): Promise<void> {
  configureOutput();
  ui.start("hardline — désinstallation");

  const manifestPath = defaultManifestPath();
  const manifest = await readManifest(manifestPath);
  const recorded = manifest.order;

  if (recorded.length === 0) {
    ui.finish("Aucune étape enregistrée\u00a0: rien à restaurer.");
    return;
  }

  ui.report("État antérieur enregistré", recordedLabels(recorded));

  const confirmed = await askConfirmation(
    `Restaurer la configuration réseau antérieure ${scopeLabel(recorded)}\u00a0?`,
    { assumeYes: options.yes },
  );
  if (!confirmed) {
    ui.finish("Rien n'a été modifié.");
    return;
  }

  const unrestored = await revertSteps(ALL_STEPS, CONFIG, manifestPath, ui);

  if (unrestored.length > 0) {
    // Leur etat anterieur reste sur disque : une version ulterieure de
    // hardline, ou un nouvel essai, pourra encore s'en servir.
    ui.warn(
      `Étapes non restaurées, conservées dans le manifeste\u00a0: ${unrestored.join(", ")}`,
    );
    ui.finish("Restauration incomplète.");
    process.exitCode = 1;
    return;
  }

  ui.finish("État antérieur restauré.");
}
