import { test, expect } from "bun:test";
import { buildProgram, VERSION } from "../src/cli";

test("le programme expose les quatre sous-commandes attendues", () => {
  const names = buildProgram()
    .commands.map((c) => c.name())
    .sort();
  expect(names).toEqual(["doctor", "install", "uninstall", "up"]);
});

test("le programme porte un numero de version", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

test("la commande up expose --fullscreen, --resolution et --fps", () => {
  const up = buildProgram().commands.find((c) => c.name() === "up");
  const optionNames = up?.options.map((o) => o.long) ?? [];
  expect(optionNames).toEqual(
    expect.arrayContaining(["--fullscreen", "--resolution", "--fps"]),
  );
});

test("la commande install expose --yes", () => {
  const install = buildProgram().commands.find((c) => c.name() === "install");
  const optionNames = install?.options.map((o) => o.long) ?? [];
  expect(optionNames).toEqual(expect.arrayContaining(["--yes"]));
});
