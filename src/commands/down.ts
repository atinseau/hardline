import type { Config } from "../config";
import type { CommandOutput, CommandResult, CommandRun } from "../command-run";
import { runCommand } from "../command-run";
import { errorMessage } from "../lib/errors";
import { runRemoteChecked } from "../lib/ssh";
import type { TargetResolution } from "../target-resolution";

type DownFact = {
  id: "title" | "shutdown" | "success" | "failed";
  values?: Record<string, unknown>;
};

const fact = (id: DownFact["id"], values?: Record<string, unknown>): DownFact => ({
  id,
  ...(values ? { values } : {}),
});

export function renderDownFact(value: DownFact): string {
  switch (value.id) {
    case "title": return "Shut Down Hardline PC";
    case "shutdown": return "Shut Down PC";
    case "success": return "PC shutdown requested.";
    case "failed": return `Could not shut down the PC: ${value.values?.error}`;
  }
}

const SHUTDOWN = `
& "$env:SystemRoot\\System32\\shutdown.exe" /s /f /t 5 /d p:0:0 /c 'Hardline down'
if ($LASTEXITCODE -ne 0) { throw "shutdown.exe failed with exit code $LASTEXITCODE." }`;

export async function runDown(run: CommandRun<DownFact>, config: Config): Promise<void> {
  await run.phase(fact("shutdown"), () => runRemoteChecked(config.ssh, SHUTDOWN));
}

export function downCommand(options: {
  targetResolution: TargetResolution<Config>;
  output: CommandOutput;
}): Promise<CommandResult<DownFact>> {
  return runCommand({
    title: fact("title"),
    render: renderDownFact,
    output: options.output,
    unexpected: (error) => fact("failed", { error: errorMessage(error) }),
    execute: async (run) => {
      const outcome = await options.targetResolution.during("down", async (target) => {
        await runDown(run, target.config);
        return {
          lifecycle: "unchanged",
          result: { status: "succeeded", summary: fact("success") },
        } as const;
      });
      return outcome.result;
    },
  });
}
