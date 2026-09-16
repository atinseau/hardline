import { test, expect } from "bun:test";
import { buildProgram, parseRunLink, VERSION } from "../src/cli";

test("the program exposes all six commands", () => {
  const names = buildProgram()
    .commands.map((c) => c.name())
    .sort();
  expect(names).toEqual(["doctor", "down", "install", "uninstall", "up", "update"]);
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
  expect(help).toContain("Manage a reversible direct link");
  expect(help).toContain("show completed semantic details");
});

test("--link is global and accepted before or after a command", () => {
  for (const args of [["--link", "direct", "up"], ["up", "--link", "direct"]]) {
    const program = buildProgram();
    expect(program.parseOptions(args).unknown).toEqual([]);
    expect(program.opts().link).toBe("direct");
  }
});

test("without the flag every command runs on the best link that answers", () => {
  const program = buildProgram();
  program.parseOptions(["up"]);
  expect(parseRunLink(program.opts().link)).toBe("auto");
});

test("an unknown link is refused before anything is observed", () => {
  expect(() => parseRunLink("wifi")).toThrow("Invalid --link");
  expect(parseRunLink(undefined)).toBe("auto");
  for (const kind of ["auto", "direct", "shared"] as const) {
    expect(parseRunLink(kind)).toBe(kind);
  }
});
