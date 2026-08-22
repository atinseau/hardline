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

  await revertSteps(ALL_STEPS, CONFIG, defaultManifestPath(), ui);
  ui.finish("État antérieur restauré.");
}
