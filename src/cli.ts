#!/usr/bin/env bun
import { Command } from "commander";

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
    .action(NOT_IMPLEMENTED("install"));

  program
    .command("uninstall")
    .description("Restaure l'état antérieur à partir du manifeste")
    .action(NOT_IMPLEMENTED("uninstall"));

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
  await buildProgram().parseAsync(Bun.argv);
}
