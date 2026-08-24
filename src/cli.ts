#!/usr/bin/env bun
import { Command } from "commander";
import { installCommand } from "./commands/install";
import { upCommand, type UpCliOptions } from "./commands/up";
import { uninstallCommand } from "./commands/uninstall";
import { doctorCommand } from "./commands/doctor";
import { CONFIG, type Config } from "./config";
import {
  createCommandOutput,
  exitCodeFor,
  type CommandOutput,
  type CommandResult,
} from "./command-run";

export const VERSION = "0.1.0";

type CliDependencies = {
  config: Config;
  output: (verbose: boolean) => CommandOutput;
  setExitCode: (code: number) => void;
};

const defaults: CliDependencies = {
  config: CONFIG,
  output: (verbose) => createCommandOutput({ verbose }),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export function buildProgram(dependencies: CliDependencies = defaults): Command {
  const program = new Command();
  const execute = async (run: Promise<CommandResult<unknown>>): Promise<void> => {
    dependencies.setExitCode(exitCodeFor(await run));
  };
  const outputFor = (command: Command) =>
    dependencies.output(Boolean(command.optsWithGlobals().verbose));

  program
    .name("hardline")
    .description("Manage a reversible direct Ethernet link between a Mac and Windows PC")
    .version(VERSION)
    .option("--verbose", "show completed semantic details", false);

  program
    .command("install")
    .description("Converge both machines to the target state")
    .option("-y, --yes", "authorize prompts without interaction", false)
    .action(async (options: { yes?: boolean }, command: Command) =>
      execute(installCommand({
        config: dependencies.config,
        output: outputFor(command),
        yes: options.yes,
      })));

  program
    .command("uninstall")
    .description("Restore previous state from the manifest")
    .option("-y, --yes", "authorize prompts without interaction", false)
    .action(async (options: { yes?: boolean }, command: Command) =>
      execute(uninstallCommand({
        config: dependencies.config,
        output: outputFor(command),
        yes: options.yes,
      })));

  program
    .command("up")
    .description("Open the PC work session")
    .option("--fullscreen", "use full screen instead of a window", false)
    .option("--resolution <WxH>", "override resolution, for example 1920x1080")
    .option("--fps <n>", "override frames per second")
    .option("--monitor", "show live stream performance statistics", false)
    .action(async (options: UpCliOptions, command: Command) =>
      execute(upCommand({
        config: dependencies.config,
        output: outputFor(command),
        cli: options,
      })));

  program
    .command("doctor")
    .description("Diagnose the link and services")
    .action(async (_options: unknown, command: Command) =>
      execute(doctorCommand({
        config: dependencies.config,
        output: outputFor(command),
      })));

  return program;
}

if (import.meta.main) {
  await buildProgram().parseAsync(Bun.argv);
}
