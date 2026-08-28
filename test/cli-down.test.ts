import { expect, mock, test } from "bun:test";
import type { CommandOutput } from "../src/command-run";

const downCommand = mock(async () => ({
  status: "succeeded" as const,
  summary: { id: "success" },
}));
mock.module("../src/commands/down", () => ({ downCommand }));

const { buildProgram } = await import("../src/cli");

test("the down CLI action delegates and propagates its exit code", async () => {
  const exitCodes: number[] = [];
  const output = { interactive: true } as CommandOutput;
  const targetResolution = { marker: "target" };
  const program = buildProgram({
    targetResolution: () => targetResolution as never,
    output: () => output,
    setExitCode: (code) => exitCodes.push(code),
  });

  await program.parseAsync(["bun", "hardline", "down"]);

  expect(downCommand).toHaveBeenCalledWith({ targetResolution, output });
  expect(exitCodes).toEqual([0]);
});
