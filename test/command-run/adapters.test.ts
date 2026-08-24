import { describe, expect, test } from "bun:test";
import {
  ClackOutput,
  TextOutput,
  createCommandOutput,
  runCommand,
  type ClackPrimitives,
} from "../../src/command-run";

type Fact = { text: string };
const render = (fact: Fact) => fact.text;

async function scenario(output: TextOutput | ClackOutput): Promise<void> {
  await runCommand({
    title: { text: "Install Hardline" },
    render,
    output,
    execute: async (run) => {
      await run.phase({ text: "Check Mac" }, async () => {
        run.activity({ text: "Inspect network" });
        run.detail({ text: "Network is ready" });
      });
      run.warning({ text: "Reconnect the cable." });
      await run.confirm({ text: "Continue?" }, { assumeYes: false });
      return { status: "succeeded", summary: { text: "Hardline is installed." } };
    },
  });
}

function fakeClack(lines: string[]): ClackPrimitives {
  return {
    intro: (text) => lines.push(`title:${text}`),
    outro: (text) => lines.push(`final:${text}`),
    cancel: (text) => lines.push(`cancel:${text}`),
    note: (text, title) => lines.push(`report:${title}:${text}`),
    warn: (text) => lines.push(`warning:${text}`),
    info: (text) => lines.push(`detail:${text}`),
    confirm: async (text) => {
      lines.push(`question:${text}`);
      return true;
    },
    select: async (_text, _choices, initialValue) => initialValue,
    password: async () => "never-render-this-secret",
    isCancel: () => false,
    spinner: () => ({
      start: (text) => lines.push(`phase:${text}`),
      message: (text) => lines.push(`activity:${text}`),
      stop: (text) => lines.push(`complete:${text}`),
      error: (text) => lines.push(`failed:${text}`),
    }),
  };
}

describe("shared output adapter contract", () => {
  test("selects Clack only for an interactive terminal", () => {
    expect(createCommandOutput({ verbose: false, interactive: true })).toBeInstanceOf(ClackOutput);
    expect(createCommandOutput({ verbose: false, interactive: false })).toBeInstanceOf(TextOutput);
  });
  test("Clack and text preserve the same command-specific English meaning", async () => {
    const textLines: string[] = [];
    const clackLines: string[] = [];
    await scenario(new TextOutput({ write: (line) => textLines.push(line), verbose: true }));
    await scenario(new ClackOutput(fakeClack(clackLines), { verbose: true }));

    for (const phrase of [
      "Install Hardline",
      "Check Mac",
      "Network is ready",
      "Reconnect the cable.",
      "Continue?",
      "Hardline is installed.",
    ]) {
      expect(textLines.join("\n")).toContain(phrase);
      expect(clackLines.join("\n")).toContain(phrase);
    }
  });

  test("normal mode suppresses details while verbose mode preserves them", async () => {
    const concise: string[] = [];
    const verbose: string[] = [];
    await scenario(new TextOutput({ write: (line) => concise.push(line), verbose: false }));
    await scenario(new TextOutput({ write: (line) => verbose.push(line), verbose: true }));
    expect(concise.join("\n")).not.toContain("Network is ready");
    expect(verbose.join("\n")).toContain("Network is ready");
  });

  test("text output is deterministic and contains no terminal control sequences", async () => {
    const lines: string[] = [];
    await scenario(new TextOutput({ write: (line) => lines.push(line), verbose: false }));
    expect(lines).toEqual([
      "Install Hardline",
      "Check Mac...",
      "Check Mac complete.",
      "Warning: Reconnect the cable.",
      "Question unavailable; using the safe default for: Continue?",
      "Hardline is installed.",
    ]);
    expect(lines.join("\n")).not.toMatch(/\x1b|\r/);
  });

  test("never renders a provided secret", async () => {
    const lines: string[] = [];
    const output = new ClackOutput(fakeClack(lines), { verbose: true });
    const secret = await output.secret("Windows password");
    expect(secret.status).toBe("provided");
    expect(lines.join("\n")).not.toContain("never-render-this-secret");
  });

  test("settles the spinner when a phase fails", async () => {
    const lines: string[] = [];
    const output = new ClackOutput(fakeClack(lines), { verbose: false });

    await runCommand({
      title: { text: "Install Hardline" },
      render,
      output,
      unexpected: () => ({ text: "Installation failed safely." }),
      execute: (run) => run.phase({ text: "Configure PC" }, async () => {
        throw new Error("native failure");
      }),
    });

    expect(lines).toContain("failed:Configure PC failed");
    expect(lines.at(-1)).toBe("final:Installation failed safely.");
  });
});
