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
