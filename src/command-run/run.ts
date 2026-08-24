import type {
  CommandOutput,
  CommandResult,
  CommandRun,
  CommandStatus,
} from "./types";

class PromptCancelled extends Error {}

export type CommandDefinition<Fact> = {
  title: Fact;
  render: (fact: Fact) => string;
  output: CommandOutput;
  execute: (run: CommandRun<Fact>) => Promise<CommandResult<Fact>>;
  cancelled?: Fact;
  unexpected?: (error: unknown) => Fact;
};

export async function runCommand<Fact>(
  definition: CommandDefinition<Fact>,
): Promise<CommandResult<Fact>> {
  const { output, render } = definition;
  let activePhase: string | null = null;
  output.start(render(definition.title));

  const run: CommandRun<Fact> = {
    async phase(label, operation) {
      if (activePhase !== null) throw new Error("Command Run phases cannot be nested");
      const text = render(label);
      activePhase = text;
      output.phaseStart(text);
      try {
        const value = await operation();
        output.phaseEnd(text, "succeeded");
        return value;
      } catch (error) {
        output.phaseEnd(text, "failed");
        throw error;
      } finally {
        activePhase = null;
      }
    },
    activity: (fact) => output.phaseActivity(render(fact)),
    detail: (fact) => output.phaseDetail(render(fact)),
    warning: (fact) => output.warning(render(fact)),
    report: (title, lines) => output.report(render(title), lines.map(render)),
    async confirm(question, options) {
      if (options.assumeYes) return "accepted";
      const answer = await output.confirm(render(question), options.destructive);
      if (answer === "cancelled") throw new PromptCancelled();
      return answer;
    },
    async choice(question, choices, initialValue) {
      const answer = await output.choice(
        render(question),
        choices.map((choice) => ({
          value: choice.value,
          label: render(choice.label),
          ...(choice.hint ? { hint: render(choice.hint) } : {}),
        })),
        initialValue,
      );
      if (answer.status === "cancelled") throw new PromptCancelled();
      return answer;
    },
    async secret(question) {
      const answer = await output.secret(render(question));
      if (answer.status === "cancelled") throw new PromptCancelled();
      return answer;
    },
  };

  let result: CommandResult<Fact>;
  try {
    result = await definition.execute(run);
  } catch (error) {
    if (error instanceof PromptCancelled && definition.cancelled !== undefined) {
      result = { status: "cancelled", summary: definition.cancelled };
    } else if (definition.unexpected) {
      result = { status: "failed", summary: definition.unexpected(error) };
    } else {
      throw error;
    }
  }

  output.finish(render(result.summary), result.status);
  return result;
}

export function exitCodeFor(result: { status: CommandStatus }): number {
  return result.status === "succeeded" ? 0 : 1;
}
