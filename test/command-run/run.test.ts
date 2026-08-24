import { describe, expect, test } from "bun:test";
import {
  exitCodeFor,
  runCommand,
  type CommandOutput,
  type CommandResult,
  type PromptAnswer,
} from "../../src/command-run";

type Fact =
  | { kind: "title" }
  | { kind: "phase"; name: string }
  | { kind: "detail"; name: string }
  | { kind: "warning" }
  | { kind: "question" }
  | { kind: "final"; status: string };

const render = (fact: Fact): string =>
  fact.kind === "title"
    ? "Test command"
    : fact.kind === "warning"
      ? "Action is required."
      : fact.kind === "question"
        ? "Continue?"
        : fact.kind === "final"
          ? `Finished: ${fact.status}.`
          : fact.name;

function recordingOutput(trace: string[]): CommandOutput {
  return {
    interactive: true,
    start: (text) => trace.push(`start:${text}`),
    phaseStart: (text) => trace.push(`phase-start:${text}`),
    phaseActivity: (text) => trace.push(`activity:${text}`),
    phaseDetail: (text) => trace.push(`detail:${text}`),
    phaseEnd: (text, state) => trace.push(`phase-end:${text}:${state}`),
    warning: (text) => trace.push(`warning:${text}`),
    report: (title, lines) => trace.push(`report:${title}:${lines.join("|")}`),
    confirm: async () => "accepted",
    choice: async (_text, _choices, initialValue) => ({
      status: "selected",
      value: initialValue,
    }),
    secret: async () => ({ status: "provided", value: "secret" }),
    finish: (text, status) => trace.push(`finish:${text}:${status}`),
  };
}

describe("runCommand", () => {
  test("owns one start, sequential phases, progressive details, cleanup, and final output", async () => {
    const trace: string[] = [];
    const result = await runCommand<Fact>({
      title: { kind: "title" },
      render,
      output: recordingOutput(trace),
      execute: async (run) => {
        await run.phase({ kind: "phase", name: "Check" }, async () => {
          run.detail({ kind: "detail", name: "First" });
          run.activity({ kind: "detail", name: "Second" });
        });
        trace.push("cleanup");
        return { status: "succeeded", summary: { kind: "final", status: "ok" } };
      },
    });

    expect(result.status).toBe("succeeded");
    expect(trace).toEqual([
      "start:Test command",
      "phase-start:Check",
      "detail:First",
      "activity:Second",
      "phase-end:Check:succeeded",
      "cleanup",
      "finish:Finished: ok.:succeeded",
    ]);
  });

  test("normalizes prompt cancellation", async () => {
    const trace: string[] = [];
    const output = recordingOutput(trace);
    output.confirm = async (): Promise<PromptAnswer> => "cancelled";

    const result = await runCommand<Fact>({
      title: { kind: "title" },
      render,
      output,
      cancelled: { kind: "final", status: "cancelled" },
      execute: async (run) => {
        await run.confirm({ kind: "question" }, { assumeYes: false });
        throw new Error("unreachable");
      },
    });

    expect(result.status).toBe("cancelled");
    expect(trace.at(-1)).toBe("finish:Finished: cancelled.:cancelled");
  });

  test("normalizes unexpected errors without exposing stacks", async () => {
    const trace: string[] = [];
    const result = await runCommand<Fact>({
      title: { kind: "title" },
      render,
      output: recordingOutput(trace),
      unexpected: () => ({ kind: "final", status: "failed safely" }),
      execute: async () => {
        throw new Error("native stderr\nsecret-token");
      },
    });

    expect(result.status).toBe("failed");
    expect(trace.join("\n")).not.toContain("secret-token");
    expect(trace.at(-1)).toBe("finish:Finished: failed safely.:failed");
  });

  test("rejects nested phases", async () => {
    const result = await runCommand<Fact>({
      title: { kind: "title" },
      render,
      output: recordingOutput([]),
      unexpected: () => ({ kind: "final", status: "invalid lifecycle" }),
      execute: (run) =>
        run.phase({ kind: "phase", name: "Outer" }, () =>
          run.phase({ kind: "phase", name: "Inner" }, async () => ({
            status: "succeeded",
            summary: { kind: "final", status: "ok" },
          })),
        ),
    });
    expect(result.status).toBe("failed");
  });
});

test("centrally maps every result status to an exit code", () => {
  const result = (status: CommandResult<Fact>["status"]): CommandResult<Fact> => ({
    status,
    summary: { kind: "final", status },
  });
  expect(exitCodeFor(result("succeeded"))).toBe(0);
  expect(exitCodeFor(result("failed"))).toBe(1);
  expect(exitCodeFor(result("cancelled"))).toBe(1);
  expect(exitCodeFor(result("incomplete"))).toBe(1);
});
