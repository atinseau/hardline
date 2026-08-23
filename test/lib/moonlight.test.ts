import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { Config } from "../../src/config";
import type { Display } from "../../src/lib/display";
import {
  pairArgs,
  streamArgs,
  quitArgs,
  spawnPair,
  runStream,
  runQuit,
} from "../../src/lib/moonlight";

const CONFIG: Config = {
  mac: { serviceName: "AX88179A", ip: "10.10.10.2", subnetMask: "255.255.255.0" },
  windows: { interfaceAlias: "Ethernet", ip: "10.10.10.1", prefixLength: 24 },
  ssh: { host: "10.10.10.1", user: "arthur", identityFile: "/dev/null", connectTimeoutSec: 8 },
  bootstrapPort: 8080,
  apollo: {
    version: "0.4.6",
    installerUrl: "https://example.invalid/Apollo-0.4.6.exe",
    installerSha256: "42b2aefaacb3474511517a56b96ee9f0517f30ac38b5dd2fda9fd5b478f5021a",
    installDir: "C:\\Program Files\\Apollo",
    serviceName: "ApolloService",
    apiPort: 47990,
    webUser: "hardline",
  },
  moonlight: {
    cask: "moonlight",
    binary: "/opt/homebrew/bin/moonlight",
    clientName: "hardline-mac",
    app: "Desktop",
  },
  smb: {
    user: "arthur",
    shares: [
      { name: "arthur", path: null, mountPoint: "/Volumes/pc-arthur" },
      { name: "hardline-d", path: "D:\\", mountPoint: "/Volumes/pc-d" },
      { name: "hardline-e", path: "E:\\", mountPoint: "/Volumes/pc-e" },
    ],
  },
};

const MAIN_DISPLAY: Display = {
  widthPx: 3456,
  heightPx: 2234,
  refreshHz: 120,
  widthPt: 1728,
  heightPt: 1117,
  main: true,
};

describe("pairArgs", () => {
  test("compose moonlight pair <hote> --pin <code>", () => {
    expect(pairArgs(CONFIG, "4821")).toEqual(["pair", "10.10.10.1", "--pin", "4821"]);
  });
});

describe("quitArgs", () => {
  test("compose moonlight quit <hote>", () => {
    expect(quitArgs(CONFIG)).toEqual(["quit", "10.10.10.1"]);
  });
});

describe("streamArgs", () => {
  test("les options gagnent sur l'ecran detecte quand elles sont fournies", () => {
    const args = streamArgs(CONFIG, MAIN_DISPLAY, {
      fullscreen: true,
      resolution: { width: 3840, height: 2160 },
      fps: 60,
    });

    expect(args).toEqual([
      "stream",
      "10.10.10.1",
      "Desktop",
      "--display-mode",
      "fullscreen",
      "--absolute-mouse",
      "--resolution",
      "3840x2160",
      "--fps",
      "60",
    ]);
  });

  test("l'ecran detecte sert de defaut quand aucune option n'impose de definition", () => {
    const args = streamArgs(CONFIG, MAIN_DISPLAY, {
      fullscreen: false,
      resolution: null,
      fps: null,
    });

    expect(args).toEqual([
      "stream",
      "10.10.10.1",
      "Desktop",
      "--display-mode",
      "windowed",
      "--absolute-mouse",
      "--resolution",
      "3456x2234",
      "--fps",
      "120",
    ]);
  });

  test("aucune option de definition n'est passee quand aucun ecran n'est detecte", () => {
    const args = streamArgs(CONFIG, null, {
      fullscreen: false,
      resolution: null,
      fps: null,
    });

    expect(args).toEqual(["stream", "10.10.10.1", "Desktop", "--display-mode", "windowed", "--absolute-mouse"]);
    expect(args).not.toContain("--resolution");
    expect(args).not.toContain("--fps");
  });

  test("ecran avec refreshHz: 0 ne passe pas de --fps, mais la resolution oui", () => {
    const displayWithZeroRefresh: Display = {
      widthPx: 3456,
      heightPx: 2234,
      refreshHz: 0,
      widthPt: 1728,
      heightPt: 1117,
      main: true,
    };

    const args = streamArgs(CONFIG, displayWithZeroRefresh, {
      fullscreen: false,
      resolution: null,
      fps: null,
    });

    expect(args).toEqual([
      "stream",
      "10.10.10.1",
      "Desktop",
      "--display-mode",
      "windowed",
      "--absolute-mouse",
      "--resolution",
      "3456x2234",
    ]);
    expect(args).not.toContain("--fps");
  });
});

describe("frontiere systeme", () => {
  type SpawnCall = { cmd: string[] };

  let spawnCalls: SpawnCall[];
  let exitCode: number;
  let killCalls: number;
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    spawnCalls = [];
    exitCode = 0;
    killCalls = 0;
    originalSpawn = Bun.spawn;
    Bun.spawn = ((cmd: string[]) => {
      spawnCalls.push({ cmd });
      return {
        exited: Promise.resolve(exitCode),
        kill: () => {
          killCalls += 1;
        },
      };
    }) as unknown as typeof Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  test("spawnPair lance moonlight pair sans attendre et sait tuer le processus", () => {
    const handle = spawnPair(CONFIG, "4821");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.cmd).toEqual([
      "/opt/homebrew/bin/moonlight",
      "pair",
      "10.10.10.1",
      "--pin",
      "4821",
    ]);

    handle.kill();
    expect(killCalls).toBe(1);
  });

  test("runStream rend le code de sortie du processus moonlight", async () => {
    exitCode = 7;

    const code = await runStream(CONFIG, MAIN_DISPLAY, {
      fullscreen: false,
      resolution: null,
      fps: null,
    });

    expect(code).toBe(7);
    expect(spawnCalls[0]!.cmd).toEqual([
      "/opt/homebrew/bin/moonlight",
      "stream",
      "10.10.10.1",
      "Desktop",
      "--display-mode",
      "windowed",
      "--absolute-mouse",
      "--resolution",
      "3456x2234",
      "--fps",
      "120",
    ]);
  });

  test("runQuit attend la fin du processus moonlight quit", async () => {
    await runQuit(CONFIG);

    expect(spawnCalls[0]!.cmd).toEqual(["/opt/homebrew/bin/moonlight", "quit", "10.10.10.1"]);
  });
});

/**
 * Sans ce drapeau, la fenetre de streaming capture le curseur du Mac, et il
 * faut connaitre Ctrl+Alt+Shift+Z pour le recuperer.
 */
test("streamArgs demande la souris absolue, pour ne pas capturer le curseur du Mac", () => {
  const args = streamArgs(CONFIG, null, { fullscreen: true, resolution: null, fps: null });
  expect(args).toContain("--absolute-mouse");
  expect(args).not.toContain("--no-absolute-mouse");
});
