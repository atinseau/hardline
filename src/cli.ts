#!/usr/bin/env bun
import { Command } from "commander";
import { installCommand } from "./commands/install";
import { upCommand, type UpCliOptions } from "./commands/up";
import { downCommand } from "./commands/down";
import { uninstallCommand } from "./commands/uninstall";
import { doctorCommand } from "./commands/doctor";
import type { Config } from "./config";
import {
  createCommandOutput,
  exitCodeFor,
  type CommandOutput,
  type CommandResult,
} from "./command-run";
import { createTargetResolution, type TargetResolution } from "./target-resolution";

export const VERSION = "0.1.0";

type CliDependencies = {
  targetResolution: (output: CommandOutput) => TargetResolution<Config>;
  output: (verbose: boolean) => CommandOutput;
  setExitCode: (code: number) => void;
};

const defaults: CliDependencies = {
  targetResolution: (output) =>
    createTargetResolution({
      reportBootstrapCommand: (command) => {
        output.report("Bootstrap PC", [
          `Run this command in an Administrator PowerShell on the PC:\n\n  ${command}\n\nInstallation will resume when the PC responds.`,
        ]);
      },
      chooseEthernetCandidate: async (machine, candidates) => {
        const choices = candidates.map((candidate) => ({
          value: candidate.stableId,
          label: `${candidate.hardwareName} (${candidate.alias}, ${candidate.macAddress}, ${candidate.speedMbps ?? "unknown"} Mbit/s)`,
          hint: `link ${candidate.linkState}; no default gateway`,
        }));
        const first = choices[0];
        if (!first) throw new Error(`No eligible Ethernet adapter was found on ${machine}.`);
        const answer = await output.choice(
          `Which physical Ethernet adapter should Hardline use on ${machine}?`,
          choices,
          first.value,
        );
        if (answer.status !== "selected") {
          throw new Error("Ethernet adapter selection requires an interactive choice.");
        }
        return answer.value;
      },
    }),
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
    .action(async (options: { yes?: boolean }, command: Command) => {
      const output = outputFor(command);
      return execute(installCommand({
        targetResolution: dependencies.targetResolution(output),
        output,
        yes: options.yes,
      }));
    });

  program
    .command("uninstall")
    .description("Restore previous state from the manifest")
    .option("-y, --yes", "authorize prompts without interaction", false)
    .action(async (options: { yes?: boolean }, command: Command) => {
      const output = outputFor(command);
      return execute(uninstallCommand({
        targetResolution: dependencies.targetResolution(output),
        output,
        yes: options.yes,
      }));
    });

  program
    .command("up")
    .description("Open the PC work session")
    .option("--fullscreen", "use full screen instead of a window", false)
    .option("--resolution <WxH>", "override resolution, for example 1920x1080")
    .option("--fps <n>", "override frames per second")
    .option("--monitor", "show live stream performance statistics", false)
    .action(async (options: UpCliOptions, command: Command) => {
      const output = outputFor(command);
      return execute(upCommand({
        targetResolution: dependencies.targetResolution(output),
        output,
        cli: options,
      }));
    });

  program
    .command("down")
    .description("Force shut down the PC after 5 seconds")
    .action(async (_options: unknown, command: Command) => {
      const output = outputFor(command);
      return execute(downCommand({
        targetResolution: dependencies.targetResolution(output),
        output,
      }));
    });

  program
    .command("doctor")
    .description("Diagnose the link and services")
    .action(async (_options: unknown, command: Command) => {
      const output = outputFor(command);
      return execute(doctorCommand({
        targetResolution: dependencies.targetResolution(output),
        output,
      }));
    });

  return program;
}

if (import.meta.main) {
  await buildProgram().parseAsync(Bun.argv);
}
