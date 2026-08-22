import { CONFIG } from "../config";
import { ALL_STEPS } from "../steps";
import { revertSteps } from "../lib/orchestrator";
import { defaultManifestPath } from "../lib/manifest";
import { askConfirmation, configureOutput, ui } from "../lib/ui";

export async function uninstallCommand(options: { yes: boolean }): Promise<void> {
  configureOutput();
  ui.start("hardline — désinstallation");

  const confirmed = await askConfirmation(
    "Restaurer la configuration réseau antérieure des deux machines ?",
    { assumeYes: options.yes },
  );
  if (!confirmed) {
    ui.finish("Rien n'a été modifié.");
    return;
  }

  const unrestored = await revertSteps(
    ALL_STEPS,
    CONFIG,
    defaultManifestPath(),
    ui,
  );

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
