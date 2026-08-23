#!/usr/bin/env bun
import { Command } from "commander";
import { installCommand } from "./commands/install";
import { upCommand } from "./commands/up";
import { uninstallCommand } from "./commands/uninstall";
import { doctorCommand } from "./commands/doctor";
import { CancelledError, ui } from "./lib/ui";
import { errorMessage } from "./lib/errors";

export const VERSION = "0.1.0";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("hardline")
    .description("Liaison Ethernet directe entre le Mac et le PC Windows")
    .version(VERSION);

  program
    .command("install")
    .description("Converge les deux machines vers l'état cible")
    .option("-y, --yes", "ne pas demander de confirmation", false)
    .action(installCommand);

  program
    .command("uninstall")
    .description("Restaure l'état antérieur à partir du manifeste")
    .option("-y, --yes", "ne pas demander de confirmation", false)
    .action(uninstallCommand);

  program
    .command("up")
    .description("Ouvre la session de travail sur le PC")
    .option("--fullscreen", "plein écran plutôt que fenêtré", false)
    .option("--resolution <WxH>", "impose une définition, ex. 1920x1080")
    .option("--fps <n>", "impose une fréquence en images par seconde")
    .action(upCommand);

  program
    .command("doctor")
    .description("Diagnostique la liaison et les services")
    .action(doctorCommand);

  return program;
}

if (import.meta.main) {
  try {
    await buildProgram().parseAsync(Bun.argv);
  } catch (error) {
    if (!(error instanceof CancelledError)) {
      ui.failed({ label: "hardline", detail: errorMessage(error) });
    }
    process.exitCode = 1;
  }
}
