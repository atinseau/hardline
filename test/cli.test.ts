import { test, expect } from "bun:test";
import { buildProgram, VERSION } from "../src/cli";

test("the program exposes all five commands", () => {
  const names = buildProgram()
    .commands.map((c) => c.name())
    .sort();
  expect(names).toEqual(["doctor", "down", "install", "uninstall", "up"]);
});

test("the program has a semantic version", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

test("up exposes its stream options", () => {
  const up = buildProgram().commands.find((c) => c.name() === "up");
  const optionNames = up?.options.map((o) => o.long) ?? [];
  expect(optionNames).toEqual(
    expect.arrayContaining(["--fullscreen", "--resolution", "--fps"]),
  );
});

test("install exposes explicit authorization", () => {
  const install = buildProgram().commands.find((c) => c.name() === "install");
  const optionNames = install?.options.map((o) => o.long) ?? [];
  expect(optionNames).toEqual(expect.arrayContaining(["--yes"]));
});

test("down discloses that shutdown is forced", () => {
  const down = buildProgram().commands.find((c) => c.name() === "down");
  expect(down?.description()).toContain("Force shut down");
});

test("verbose is global and accepted before or after a command", () => {
  for (const args of [["--verbose", "install"], ["install", "--verbose"]]) {
    const program = buildProgram();
    expect(program.parseOptions(args).unknown).toEqual([]);
    expect(program.opts().verbose).toBe(true);
  }
});

test("all executable help is English", () => {
  const help = buildProgram().helpInformation();
  expect(help).toContain("Manage a reversible direct Ethernet link");
  expect(help).toContain("show completed semantic details");
});
