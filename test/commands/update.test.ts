import { beforeEach, describe, expect, test } from "bun:test";
import { exitCodeFor, type CommandOutput } from "../../src/command-run";
import { updateCommand, type UpdateEnvironment } from "../../src/commands/update";

const phases: string[] = [];
const finishes: Array<{ message: string; status: string }> = [];
const output: CommandOutput = {
  interactive: true,
  start: () => {},
  phaseStart: (message) => phases.push(message),
  phaseActivity: () => {},
  phaseDetail: () => {},
  phaseEnd: () => {},
  warning: () => {},
  report: () => {},
  confirm: async () => "accepted",
  choice: async (_message, _choices, initialValue) => ({ status: "selected", value: initialValue }),
  secret: async () => ({ status: "unavailable" }),
  finish: (message, status) => finishes.push({ message, status }),
};

const replaced: Array<{ source: string; destination: string }> = [];
const downloaded: string[] = [];

function environment(overrides: Partial<UpdateEnvironment> = {}): UpdateEnvironment {
  return {
    installedPath: () => "/usr/local/bin/hardline",
    latestTag: async () => "v0.2.0",
    download: async (destination) => {
      downloaded.push(destination);
    },
    versionOf: async () => "0.2.0",
    writable: async () => true,
    replace: async (source, destination) => {
      replaced.push({ source, destination });
    },
    ...overrides,
  };
}

beforeEach(() => {
  phases.length = 0;
  finishes.length = 0;
  replaced.length = 0;
  downloaded.length = 0;
});

describe("updateCommand", () => {
  test("remplace l'executable installe par la derniere publication", async () => {
    const result = await updateCommand({
      output,
      environment: environment(),
      currentVersion: "0.1.0",
    });

    expect(exitCodeFor(result)).toBe(0);
    expect(replaced).toEqual([
      { source: downloaded[0]!, destination: "/usr/local/bin/hardline" },
    ]);
    expect(phases).toEqual([
      "Look Up the Latest Release",
      "Download the Release Binary",
      "Replace the Installed Binary",
    ]);
    expect(finishes[0]?.message).toBe("Hardline updated from 0.1.0 to 0.2.0.");
  });

  test("ne telecharge rien quand la version installee est deja la derniere", async () => {
    const result = await updateCommand({
      output,
      environment: environment({ latestTag: async () => "v0.1.0" }),
      currentVersion: "0.1.0",
    });

    expect(exitCodeFor(result)).toBe(0);
    expect(downloaded).toEqual([]);
    expect(replaced).toEqual([]);
    expect(finishes[0]?.message).toContain("already at the latest release (0.1.0)");
  });

  test("laisse l'executable intact quand le binaire telecharge annonce une autre version", async () => {
    const result = await updateCommand({
      output,
      environment: environment({ versionOf: async () => "0.1.0" }),
      currentVersion: "0.1.0",
    });

    expect(exitCodeFor(result)).toBe(1);
    expect(replaced).toEqual([]);
    expect(finishes[0]?.message).toContain("nothing was replaced");
  });

  test("refuse d'ecrire dans un repertoire qui demande l'administrateur, et dit quoi faire", async () => {
    const result = await updateCommand({
      output,
      environment: environment({ writable: async () => false }),
      currentVersion: "0.1.0",
    });

    expect(exitCodeFor(result)).toBe(1);
    expect(downloaded).toEqual([]);
    expect(finishes[0]?.message).toContain("sudo hardline update");
  });

  test("refuse de s'executer hors binaire compile, ou execPath est bun", async () => {
    const result = await updateCommand({
      output,
      environment: environment({ installedPath: () => null }),
      currentVersion: "0.1.0",
    });

    expect(exitCodeFor(result)).toBe(1);
    expect(downloaded).toEqual([]);
    expect(finishes[0]?.message).toContain("running from source");
  });
});
