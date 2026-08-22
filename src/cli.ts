#!/usr/bin/env bun
import { Command } from "commander";
import { installCommand } from "./commands/install";
import { uninstallCommand } from "./commands/uninstall";
import { doctorCommand } from "./commands/doctor";
import { CancelledError, ui } from "./lib/ui";
import { errorMessage } from "./lib/errors";

export const VERSION = "0.1.0";

const NOT_IMPLEMENTED = (name: string) => async () => {
  console.error(`hardline ${name}\u00a0: pas encore implémenté`);
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
