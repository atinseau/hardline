import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { CONFIG } from "../../src/config";
import type { StreamOptions } from "../../src/lib/moonlight";

/** Journal d'appels partage : c'est l'ORDRE qui porte les garanties de up. */
const order: string[] = [];

let reachable = true;
let arpMac: string | null = "e8:9c:25:2a:70:e1";
let displays: Array<{
  widthPx: number;
  heightPx: number;
  refreshHz: number;
  widthPt: number;
  heightPt: number;
  main: boolean;
}> = [];
let wakeSucceeds = true;
let apolloStatusRounds: Array<string | null> = ["Running"];
let apolloStatusCalls = 0;
let windowsPassword: string | null = "hunter2";
let mountThrowsOn: string | null = null;
let streamThrows: Error | null = null;
let streamExitCode = 0;

const runRemoteJson = mock(async (_target: unknown, script: string) => {
  order.push("runRemoteJson");
  if (script.includes("ok = $true")) {
    if (!reachable) throw new Error("PC injoignable");
    return [{ ok: true }];
  }
  const status =
    apolloStatusRounds[Math.min(apolloStatusCalls, apolloStatusRounds.length - 1)];
  apolloStatusCalls += 1;
  return [{ status }];
});
const runRemoteChecked = mock(async (..._args: unknown[]) => {
  order.push("runRemoteChecked");
  return { exitCode: 0, stdout: "", stderr: "" };
});
mock.module("../../src/lib/ssh", () => ({ runRemoteJson, runRemoteChecked }));

const lookupMac = mock(async (..._args: unknown[]) => arpMac);
const sendMagicPacket = mock(async (..._args: unknown[]) => {
  order.push("sendMagicPacket");
});
mock.module("../../src/lib/wol", () => ({ lookupMac, sendMagicPacket }));

const waitForRemote = mock(async (..._args: unknown[]) => {
  order.push("waitForRemote");
  return wakeSucceeds;
});
mock.module("../../src/lib/preflight", () => ({ waitForRemote }));

const listDisplays = mock(async () => displays);
mock.module("../../src/lib/display", () => ({
  listDisplays,
  mainDisplay: (ds: typeof displays) => ds.find((d) => d.main) ?? ds[0] ?? null,
}));

const getSecret = mock(async (..._args: unknown[]) => windowsPassword);
mock.module("../../src/lib/keychain", () => ({ getSecret }));

const mountShare = mock(async (share: { name: string }, ..._rest: unknown[]) => {
  order.push(`mount:${share.name}`);
  if (mountThrowsOn === share.name) {
    throw new Error(`montage refusé pour ${share.name}`);
  }
});
const unmountShare = mock(async (share: { name: string }) => {
  order.push(`unmount:${share.name}`);
});
mock.module("../../src/lib/smb", () => ({ mountShare, unmountShare }));

const runStream = mock(async (..._args: unknown[]) => {
  order.push("runStream");
  if (streamThrows) throw streamThrows;
  return streamExitCode;
});
const runQuit = mock(async (..._args: unknown[]) => {
  order.push("runQuit");
});
mock.module("../../src/lib/moonlight", () => ({ runStream, runQuit }));

/** Tout ce que l'interface a rendu visible, quelle que soit la voie. */
const finishes: string[] = [];
const failures: string[] = [];
const infos: string[] = [];
const warns: string[] = [];
mock.module("../../src/lib/ui", () => ({
  configureOutput: () => {},
  withSpinner: async <T>(
    _label: string,
    run: (progress: (m: string) => void) => Promise<T>,
  ) => run(() => {}),
  ui: {
    start: () => {},
    finish: (message: string) => finishes.push(message),
    skipped: () => {},
    applied: () => {},
    restored: () => {},
    yielded: () => {},
    detached: () => {},
    failed: ({ label, detail }: { label: string; detail: string }) =>
      failures.push(`${label} — ${detail}`),
    info: (message: string) => infos.push(message),
    warn: (message: string) => warns.push(message),
    report: () => {},
  },
}));

const {
  runUp,
  upCommand,
  parseResolution,
  parseFps,
  buildStreamOptions,
  broadcastAddress,
} = await import("../../src/commands/up");

const NO_OPTIONS: StreamOptions = { fullscreen: false, resolution: null, fps: null };

beforeEach(() => {
  order.length = 0;
  reachable = true;
  arpMac = "e8:9c:25:2a:70:e1";
  wakeSucceeds = true;
  displays = [
    {
      widthPx: 3456,
      heightPx: 2234,
      refreshHz: 120,
      widthPt: 1728,
      heightPt: 1117,
      main: true,
    },
  ];
  apolloStatusRounds = ["Running"];
  apolloStatusCalls = 0;
  windowsPassword = "hunter2";
  mountThrowsOn = null;
  streamThrows = null;
  streamExitCode = 0;
  finishes.length = 0;
  failures.length = 0;
  infos.length = 0;
  warns.length = 0;

  runRemoteJson.mockClear();
  runRemoteChecked.mockClear();
  lookupMac.mockClear();
  sendMagicPacket.mockClear();
  waitForRemote.mockClear();
  listDisplays.mockClear();
  getSecret.mockClear();
  mountShare.mockClear();
  unmountShare.mockClear();
  runStream.mockClear();
  runQuit.mockClear();
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe("parseResolution", () => {
  test("lit une resolution valide", () => {
    expect(parseResolution("3456x2234")).toEqual({ width: 3456, height: 2234 });
  });

  test("accepte un X majuscule", () => {
    expect(parseResolution("1920X1080")).toEqual({ width: 1920, height: 1080 });
  });

  test("rejette un format invalide", () => {
    expect(() => parseResolution("3456-2234")).toThrow(/Résolution invalide/);
  });

  test("rejette une chaine vide", () => {
    expect(() => parseResolution("")).toThrow(/Résolution invalide/);
  });
});

describe("parseFps", () => {
  test("lit un entier positif", () => {
    expect(parseFps("120")).toBe(120);
  });

  test("rejette zero", () => {
    expect(() => parseFps("0")).toThrow(/Fréquence invalide/);
  });

  test("rejette une valeur non entiere", () => {
    expect(() => parseFps("59.94")).toThrow(/Fréquence invalide/);
  });

  test("rejette une valeur non numerique", () => {
    expect(() => parseFps("soixante")).toThrow(/Fréquence invalide/);
  });
});

describe("buildStreamOptions", () => {
  test("rend des options par defaut sans aucun drapeau", () => {
    expect(
      buildStreamOptions({ fullscreen: false, resolution: null, fps: null }),
    ).toEqual({ fullscreen: false, resolution: null, fps: null });
  });

  test("compose la resolution et la frequence imposees", () => {
    expect(
      buildStreamOptions({ fullscreen: true, resolution: "2560x1440", fps: "144" }),
    ).toEqual({
      fullscreen: true,
      resolution: { width: 2560, height: 1440 },
      fps: 144,
    });
  });
});

describe("broadcastAddress", () => {
  test("calcule la diffusion d'un reseau en /24", () => {
    expect(broadcastAddress("10.10.10.2", "255.255.255.0")).toBe("10.10.10.255");
  });

  test("calcule la diffusion d'un reseau en /16", () => {
    expect(broadcastAddress("192.168.0.5", "255.255.0.0")).toBe("192.168.255.255");
  });

  test("rejette une adresse malformee", () => {
    expect(() => broadcastAddress("10.10.10", "255.255.255.0")).toThrow(/invalide/);
  });
});

describe("runUp, PC deja joignable", () => {
  test("ne reveille pas le PC quand il repond deja", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    expect(sendMagicPacket).not.toHaveBeenCalled();
    expect(waitForRemote).not.toHaveBeenCalled();
  });

  test("monte les trois partages, dans l'ordre de la configuration, puis lance le flux", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    expect(mountShare).toHaveBeenCalledTimes(3);
    const names = mountShare.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toEqual(["arthur", "hardline-d", "hardline-e"]);
    expect(runStream).toHaveBeenCalledTimes(1);
  });

  test("demonte les trois partages et clot la session a la fin d'une session reussie", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    expect(unmountShare).toHaveBeenCalledTimes(3);
    expect(runQuit).toHaveBeenCalledTimes(1);
  });

  test("le demontage et la fermeture surviennent APRES le flux", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    const streamIndex = order.indexOf("runStream");
    const firstUnmount = order.findIndex((e) => e.startsWith("unmount:"));
    expect(streamIndex).toBeGreaterThanOrEqual(0);
    expect(firstUnmount).toBeGreaterThan(streamIndex);
    expect(order.indexOf("runQuit")).toBeGreaterThan(firstUnmount);
  });

  test("rend le code de sortie du flux", async () => {
    streamExitCode = 7;
    expect(await runUp(CONFIG, NO_OPTIONS)).toBe(7);
  });

  test("rejette explicitement si aucun mot de passe Windows n'est au trousseau", async () => {
    windowsPassword = null;
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow(/hardline install/);
    expect(mountShare).not.toHaveBeenCalled();
  });

  test("demarre le service Apollo s'il n'est pas deja en cours", async () => {
    apolloStatusRounds = ["Stopped", "Running"];
    await runUp(CONFIG, NO_OPTIONS);
    expect(runRemoteChecked).toHaveBeenCalledTimes(1);
    expect(String((runRemoteChecked.mock.calls[0] as unknown[])[1])).toContain(
      "Start-Service",
    );
  });

  test("ne redemarre rien si Apollo tourne deja", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    expect(runRemoteChecked).not.toHaveBeenCalled();
  });

  test("echoue si Apollo refuse de demarrer", async () => {
    apolloStatusRounds = ["Stopped", "Stopped"];
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow(/n'a pas démarré/);
  });

  test("transmet l'ecran principal au flux, pas le premier venu", async () => {
    displays = [
      {
        widthPx: 1920,
        heightPx: 1080,
        refreshHz: 60,
        widthPt: 1920,
        heightPt: 1080,
        main: false,
      },
      {
        widthPx: 3456,
        heightPx: 2234,
        refreshHz: 120,
        widthPt: 1728,
        heightPt: 1117,
        main: true,
      },
    ];
    await runUp(CONFIG, NO_OPTIONS);
    const passedDisplay = (runStream.mock.calls[0] as unknown[])[1] as {
      widthPx: number;
    };
    expect(passedDisplay.widthPx).toBe(3456);
  });
});

describe("runUp, PC injoignable au depart", () => {
  beforeEach(() => {
    reachable = false;
  });

  test("lit l'adresse materielle dans la table ARP avant d'emettre le paquet magique", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    expect(lookupMac).toHaveBeenCalledWith("10.10.10.1");
    expect(sendMagicPacket).toHaveBeenCalledWith("e8:9c:25:2a:70:e1", "10.10.10.255");
  });

  test("attend le lien apres avoir envoye le paquet magique", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    const sent = order.indexOf("sendMagicPacket");
    const waited = order.indexOf("waitForRemote");
    expect(sent).toBeGreaterThanOrEqual(0);
    expect(waited).toBeGreaterThan(sent);
  });

  test("echoue explicitement si aucune adresse materielle n'est connue", async () => {
    arpMac = null;
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow(/table ARP/);
    expect(sendMagicPacket).not.toHaveBeenCalled();
  });

  test("echoue si le PC ne repond pas apres le reveil", async () => {
    wakeSucceeds = false;
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow(/n'a pas répondu/);
    expect(mountShare).not.toHaveBeenCalled();
  });

  test("poursuit normalement une fois le lien de retour", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    expect(runStream).toHaveBeenCalledTimes(1);
  });
});
