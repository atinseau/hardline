import { test, expect } from "bun:test";
import {
  bootstrapKeyAction,
  buildProgram,
  copyOnKeypress,
  parseRunLink,
  VERSION,
  type KeypressInput,
} from "../src/cli";

/** Un terminal de laboratoire : il retient ce qu'on lui fait. */
function fakeTerminal(isTTY = true) {
  const listeners = new Set<(chunk: Buffer) => void>();
  const rawModes: boolean[] = [];
  const input: KeypressInput & { press: (key: string) => void } = {
    isTTY,
    isRaw: false,
    setRawMode: (raw) => rawModes.push(raw),
    resume: () => {},
    pause: () => {},
    on: (_event, listener) => listeners.add(listener),
    off: (_event, listener) => listeners.delete(listener),
    press: (key) => {
      for (const listener of listeners) listener(Buffer.from(key));
    },
  };
  return { input, listeners, rawModes };
}

test("'c' recopie la commande tant que l'attente dure, et plus apres", async () => {
  const { input, listeners, rawModes } = fakeTerminal();
  const copies: string[] = [];
  const stop = copyOnKeypress(
    "la-commande",
    input,
    async (text) => {
      copies.push(text);
      return true;
    },
  );

  input.press("c");
  input.press("a");
  expect(copies).toEqual(["la-commande"]);

  stop();
  input.press("c");
  expect(copies).toEqual(["la-commande"]);
  // Le terminal est rendu tel qu'il etait : sans cela, les questions posees
  // ensuite ne recevraient plus rien.
  expect(rawModes).toEqual([true, false]);
  expect(listeners.size).toBe(0);
});

test("hors terminal, rien n'est mis en mode brut", () => {
  const { input, listeners, rawModes } = fakeTerminal(false);
  copyOnKeypress("la-commande", input, async () => true)();
  expect(rawModes).toEqual([]);
  expect(listeners.size).toBe(0);
});

test("the program exposes all six commands", () => {
  const names = buildProgram()
    .commands.map((c) => c.name())
    .sort();
  expect(names).toEqual(["doctor", "down", "install", "uninstall", "up", "update"]);
});

test("the program has a semantic version", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

test("pendant l'attente du PC, seule 'c' recopie et Ctrl+C reste une interruption", () => {
  expect(bootstrapKeyAction("c")).toBe("copy");
  expect(bootstrapKeyAction("C")).toBe("copy");
  // Le mode brut prive le terminal de SIGINT : sans ce cas, l'attente ne se
  // quitte plus.
  expect(bootstrapKeyAction("\u0003")).toBe("interrupt");
  for (const key of ["a", "\r", "\u001b[A", ""]) {
    expect(bootstrapKeyAction(key)).toBeNull();
  }
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
