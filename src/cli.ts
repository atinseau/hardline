#!/usr/bin/env bun
import { Command } from "commander";
import { installCommand } from "./commands/install";
import { uninstallCommand } from "./commands/uninstall";
import { CancelledError, ui } from "./lib/ui";

export const VERSION = "0.1.0";

const NOT_IMPLEMENTED = (name: string) => async () => {
  console.error(`hardline ${name} : pas encore implémenté`);
  process.exitCode = 1;
};

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("hardline")
    .description("Liaison Ethernet directe entre le Mac et le PC Windows")
    .version(VERSION);

  program
    .command("install")
    .description("Converge les deux machines vers l'état cible")
    .action(installCommand);

  program
    .command("uninstall")
    .description("Restaure l'état antérieur à partir du manifeste")
    .option("-y, --yes", "ne pas demander de confirmation", false)
    .action(uninstallCommand);

  program
    .command("up")
    .description("Ouvre la session de travail sur le PC")
    .action(NOT_IMPLEMENTED("up"));

  program
    .command("doctor")
    .description("Diagnostique la liaison et les services")
    .action(NOT_IMPLEMENTED("doctor"));

  return program;
}

if (import.meta.main) {
  try {
    await buildProgram().parseAsync(Bun.argv);
  } catch (error) {
    if (!(error instanceof CancelledError)) {
      // Une valeur levee qui n'est pas une Error n'a pas de .message :
      // l'afficher tel quel vaut mieux qu'annoncer « undefined ».
      const detail =
        error instanceof Error && error.message ? error.message : String(error);
      ui.failed({ label: "hardline", detail });
    }
    process.exitCode = 1;
  }
}
