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
import type { RunLink } from "./target-resolution/relink";

export const VERSION = "0.1.0";

type CliDependencies = {
  targetResolution: (output: CommandOutput, link: RunLink) => TargetResolution<Config>;
  output: (verbose: boolean) => CommandOutput;
  setExitCode: (code: number) => void;
};

const defaults: CliDependencies = {
  targetResolution: (output, link) =>
    createTargetResolution({
      link,
      reportBootstrapCommand: (command) => {
        output.report("Bootstrap PC", [
          `Run this command in an Administrator PowerShell on the PC:\n\n  ${command}\n\nInstallation will resume when the PC responds.`,
        ]);
      },
      ask: async (question) => {
        const choices = question.kind === "adapter"
          ? question.candidates.map((candidate, index) => ({
              value: String(index),
              label: `${candidate.hardwareName} (${candidate.alias}, ${candidate.macAddress}, ${candidate.speedMbps ?? "unknown"} Mbit/s)`,
              hint: `${candidate.transport}; link ${candidate.linkState}; free for a dedicated link`,
            }))
          : question.candidates.map((candidate, index) => ({
              value: String(index),
              label: `${candidate.subnet} via ${candidate.mac.alias} (Mac ${candidate.macAddress}) and ${candidate.windows.alias} (PC ${candidate.windowsAddress})`,
              hint: `${candidate.mac.transport} to ${candidate.windows.transport}; existing network, left untouched`,
            }));
        const first = choices[0];
        if (!first) throw new Error("Hardline found no usable link between the two machines.");
        const prompt = question.kind === "adapter"
          ? `Which adapter should Hardline dedicate on the ${question.machine === "mac" ? "Mac" : "PC"}?`
          : "Both machines already share several networks. Which one should Hardline use?";
        const answer = await output.choice(prompt, choices, first.value);
        if (answer.status !== "selected") {
          throw new Error("Choosing the link requires an interactive terminal.");
        }
        return Number(answer.value);
      },
    }),
  output: (verbose) => createCommandOutput({ verbose }),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

const RUN_LINKS = ["auto", "direct", "shared"] as const;

/**
 * Le drapeau est lu ici et nulle part ailleurs : une valeur inconnue doit
 * echouer avant qu'une seule machine ne soit observee.
 */
export function parseRunLink(value: unknown): RunLink {
  if (value === undefined) return "auto";
  if (typeof value !== "string" || !(RUN_LINKS as readonly string[]).includes(value)) {
    throw new Error(`Invalid --link: expected one of ${RUN_LINKS.join(", ")}.`);
  }
  return value as RunLink;
}

export function buildProgram(dependencies: CliDependencies = defaults): Command {
  const program = new Command();
  const execute = async (run: Promise<CommandResult<unknown>>): Promise<void> => {
    dependencies.setExitCode(exitCodeFor(await run));
  };
  const outputFor = (command: Command) =>
    dependencies.output(Boolean(command.optsWithGlobals().verbose));
  const linkFor = (command: Command) => parseRunLink(command.optsWithGlobals().link);
  const resolutionFor = (command: Command, output: CommandOutput) =>
    dependencies.targetResolution(output, linkFor(command));

  program
    .name("hardline")
    .description("Manage a reversible direct link between a Mac and Windows PC")
    .version(VERSION)
    .option("--verbose", "show completed semantic details", false)
    .option(
      "--link <kind>",
      "require a link for this run: auto, direct, or shared",
      "auto",
    );

  program
    .command("install")
    .description("Converge both machines to the target state")
    .option("-y, --yes", "authorize prompts without interaction", false)
    .action(async (options: { yes?: boolean }, command: Command) => {
      const output = outputFor(command);
      return execute(installCommand({
        targetResolution: resolutionFor(command, output),
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
        targetResolution: resolutionFor(command, output),
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
    .option("--bitrate <kbps>", "override the stream bitrate, in kbit/s")
    .option("--monitor", "show live stream performance statistics", false)
    .action(async (options: UpCliOptions, command: Command) => {
      const output = outputFor(command);
      return execute(upCommand({
        targetResolution: resolutionFor(command, output),
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
        targetResolution: resolutionFor(command, output),
        output,
      }));
    });

  program
    .command("doctor")
    .description("Diagnose the link and services")
    .action(async (_options: unknown, command: Command) => {
      const output = outputFor(command);
      return execute(doctorCommand({
        targetResolution: resolutionFor(command, output),
        output,
      }));
    });

  return program;
}

if (import.meta.main) {
  await buildProgram().parseAsync(Bun.argv);
}
