import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { CONFIG } from "../../src/config";
import { exitCodeFor, type CommandOutput, type CommandRun } from "../../src/command-run";
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
  colorProfile?: string | null;
  colorProfileValid?: boolean;
}> = [];
let wakeSucceeds = true;
let apolloStatusRounds: Array<string | null> = ["Running"];
let apolloStatusCalls = 0;
let windowsPassword: string | null = "hunter2";
let mountThrowsOn: string | null = null;
let streamThrows: Error | null = null;
let streamExitCode = 0;
let selectedDisplay = "0";
let cancelDisplayChoice = false;

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
  colorProfileIssue: (display: (typeof displays)[number]) =>
    display.colorProfile && display.colorProfileValid
      ? null
      : "Profil couleur inadapté.",
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
const choicePrompts: Array<{
  message: string;
  choices: Array<{ value: string; label: string; hint?: string }>;
  initialValue: string;
}> = [];

class MockCancelledError extends Error {
  constructor() {
    super("Interrompu par l'utilisateur.");
    this.name = "CancelledError";
  }
}
/** Les libelles de spinner ouverts, dans l'ordre, et leurs etapes annoncees. */
const spinnerLabels: string[] = [];
const spinnerProgress: string[] = [];

const {
  runUp: executeRunUp,
  upCommand: executeUpCommand,
  renderUpFact,
  parseResolution,
  parseFps,
  buildStreamOptions,
  broadcastAddress,
} = await import("../../src/commands/up");

const NO_OPTIONS: StreamOptions = { fullscreen: false, resolution: null, fps: null };

type UpFact = Parameters<typeof renderUpFact>[0];
const run: CommandRun<UpFact> = {
  async phase(label, operation) {
    const text = renderUpFact(label);
    spinnerLabels.push(text);
    order.push(`spinner:start:${text}`);
    try {
      return await operation();
    } finally {
      order.push(`spinner:stop:${text}`);
    }
  },
  activity: (value) => spinnerProgress.push(renderUpFact(value)),
  detail: (value) => infos.push(renderUpFact(value)),
  warning: (value) => warns.push(renderUpFact(value)),
  report: () => {},
  confirm: async () => "accepted",
  choice: async (_question, _choices, initialValue) => ({ status: "selected", value: initialValue }),
  secret: async () => ({ status: "unavailable" }),
};

async function runUp(config = CONFIG, options = NO_OPTIONS): Promise<number> {
  const display = displays.find((value) => value.main) ?? displays[0] ?? null;
  return executeRunUp(run, config, options, display as never);
}

const output: CommandOutput = {
  interactive: true,
  start: () => {},
  phaseStart: (message) => {
    spinnerLabels.push(message);
    order.push(`spinner:start:${message}`);
  },
  phaseActivity: (message) => spinnerProgress.push(message),
  phaseDetail: (message) => infos.push(message),
  phaseEnd: (message) => order.push(`spinner:stop:${message}`),
  warning: (message) => warns.push(message),
  report: () => {},
  confirm: async () => "accepted",
  choice: async (message, choices, initialValue) => {
    choicePrompts.push({ message, choices: [...choices], initialValue });
    if (cancelDisplayChoice) return { status: "cancelled" };
    return { status: "selected", value: selectedDisplay as typeof initialValue };
  },
  secret: async () => ({ status: "unavailable" }),
  finish: (message, status) => {
    finishes.push(message);
    if (status === "failed") failures.push(message);
  },
};

async function upCommand(cli: Parameters<typeof executeUpCommand>[0]["cli"]): Promise<void> {
  const result = await executeUpCommand({ config: CONFIG, output, cli });
  if (result.status === "cancelled") throw new MockCancelledError();
  process.exitCode = exitCodeFor(result);
}

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
  selectedDisplay = "0";
  cancelDisplayChoice = false;
  finishes.length = 0;
  failures.length = 0;
  infos.length = 0;
  warns.length = 0;
  spinnerLabels.length = 0;
  spinnerProgress.length = 0;
  choicePrompts.length = 0;

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
    expect(() => parseResolution("3456-2234")).toThrow(/Invalid resolution/);
  });

  test("rejette une chaine vide", () => {
    expect(() => parseResolution("")).toThrow(/Invalid resolution/);
  });
});

describe("parseFps", () => {
  test("lit un entier positif", () => {
    expect(parseFps("120")).toBe(120);
  });

  test("rejette zero", () => {
    expect(() => parseFps("0")).toThrow(/Invalid frame rate/);
  });

  test("rejette une valeur non entiere", () => {
    expect(() => parseFps("59.94")).toThrow(/Invalid frame rate/);
  });

  test("rejette une valeur non numerique", () => {
    expect(() => parseFps("soixante")).toThrow(/Invalid frame rate/);
  });
});

describe("buildStreamOptions", () => {
  test("active le suivi du flux a la demande", () => {
    expect(buildStreamOptions({ fullscreen: false, monitor: true })).toEqual({
      fullscreen: false,
      resolution: null,
      fps: null,
      monitor: true,
    });
  });

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
    expect(() => broadcastAddress("10.10.10", "255.255.255.0")).toThrow(/Invalid/);
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

  test("clot une session residuelle avant le flux pour forcer le nouveau mode video", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    const firstQuit = order.indexOf("runQuit");
    const stream = order.indexOf("runStream");
    expect(firstQuit).toBeGreaterThanOrEqual(0);
    expect(firstQuit).toBeLessThan(stream);
  });

  test("demonte les trois partages et clot la session a la fin d'une session reussie", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    expect(unmountShare).toHaveBeenCalledTimes(3);
    expect(runQuit).toHaveBeenCalledTimes(2);
  });

  test("le demontage et la fermeture surviennent APRES le flux", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    const streamIndex = order.indexOf("runStream");
    const firstUnmount = order.findIndex((e) => e.startsWith("unmount:"));
    expect(streamIndex).toBeGreaterThanOrEqual(0);
    expect(firstUnmount).toBeGreaterThan(streamIndex);
    expect(order.lastIndexOf("runQuit")).toBeGreaterThan(firstUnmount);
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
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow(/did not start/);
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
        colorProfile: "Color LCD",
        colorProfileValid: true,
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
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow(/hardware address/);
    expect(sendMagicPacket).not.toHaveBeenCalled();
  });

  test("echoue si le PC ne repond pas apres le reveil", async () => {
    wakeSucceeds = false;
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow(/did not respond/);
    expect(mountShare).not.toHaveBeenCalled();
  });

  test("poursuit normalement une fois le lien de retour", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    expect(runStream).toHaveBeenCalledTimes(1);
  });
});

describe("runUp, nettoyage garanti par le finally", () => {
  test("demonte tous les partages et clot la session MEME QUAND le flux echoue", async () => {
    streamThrows = new Error("moonlight a planté");
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toBeInstanceOf(Error);
    expect(unmountShare).toHaveBeenCalledTimes(3);
    expect(runQuit).toHaveBeenCalledTimes(2);
    // Ce qui est monte est demonte, nommement, et la fermeture vient apres.
    const demontes = order.filter((e) => e.startsWith("unmount:"));
    expect(demontes).toEqual(["unmount:arthur", "unmount:hardline-d", "unmount:hardline-e"]);
    expect(order.lastIndexOf("runQuit")).toBeGreaterThan(order.lastIndexOf("unmount:hardline-e"));
  });

  test("demonte et clot meme quand un montage echoue en cours de route", async () => {
    mountThrowsOn = "hardline-e";
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow(/hardline-e/);
    // Le flux n'a jamais demarre, mais le nettoyage porte quand meme sur les
    // trois partages : unmountShare ne leve jamais pour un partage jamais
    // monte, et l'appeler sur tous est donc sans risque.
    expect(runStream).not.toHaveBeenCalled();
    expect(unmountShare).toHaveBeenCalledTimes(3);
    expect(runQuit).toHaveBeenCalledTimes(2);
  });

  test("le demontage d'un partage qui echoue n'empeche pas les autres ni la fermeture", async () => {
    unmountShare.mockImplementationOnce(async () => {
      throw new Error("demontage refuse");
    });
    streamThrows = new Error("moonlight a planté");
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toBeInstanceOf(Error);
    expect(unmountShare).toHaveBeenCalledTimes(3);
    expect(runQuit).toHaveBeenCalledTimes(2);
  });

  test("une fermeture de session en echec ne masque pas l'erreur du flux", async () => {
    runQuit
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        throw new Error("quit refuse");
      });
    streamThrows = new Error("moonlight a planté");
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toBeInstanceOf(Error);
  });

  test("ne monte rien et ne nettoie rien si le PC ne se reveille jamais", async () => {
    reachable = false;
    wakeSucceeds = false;
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow(/did not respond/);
    expect(mountShare).not.toHaveBeenCalled();
    expect(unmountShare).not.toHaveBeenCalled();
    expect(runQuit).not.toHaveBeenCalled();
  });
});

describe("upCommand", () => {
  test("propose tous les ecrans et transmet celui qui est choisi", async () => {
    displays = [
      {
        widthPx: 3456,
        heightPx: 2234,
        refreshHz: 120,
        widthPt: 1728,
        heightPt: 1117,
        main: true,
        colorProfile: "Color LCD",
        colorProfileValid: true,
      },
      {
        widthPx: 2560,
        heightPx: 1440,
        refreshHz: 144,
        widthPt: 2560,
        heightPt: 1440,
        main: false,
        colorProfile: "ASUS PG329",
        colorProfileValid: true,
      },
    ];
    selectedDisplay = "1";

    await upCommand({ fullscreen: true });

    expect(choicePrompts).toHaveLength(1);
    expect(choicePrompts[0]?.initialValue).toBe("0");
    expect(choicePrompts[0]?.choices.map((choice) => choice.label)).toEqual([
      "Display 1: 3456x2234 px at 120 Hz, Retina 2x, profile Color LCD, main",
      "Display 2: 2560x1440 px at 144 Hz, scale 1x, profile ASUS PG329",
    ]);
    expect((runStream.mock.calls[0] as unknown[])[1]).toEqual(displays[1]);
    expect(listDisplays).toHaveBeenCalledTimes(1);
    expect(infos).toContain("Color profile validated: ASUS PG329.");
  });

  test("une annulation du choix ne demarre aucune action distante", async () => {
    displays.push({ ...displays[0]!, widthPx: 2560, heightPx: 1440, main: false });
    cancelDisplayChoice = true;

    await expect(upCommand({ fullscreen: true })).rejects.toBeInstanceOf(MockCancelledError);

    expect(runRemoteJson).not.toHaveBeenCalled();
    expect(mountShare).not.toHaveBeenCalled();
    expect(runStream).not.toHaveBeenCalled();
  });

  test("rapporte la fin de session au succes", async () => {
    streamExitCode = 0;
    await upCommand({ fullscreen: false, resolution: null, fps: null });
    expect(finishes.join("\n")).toContain("Session ended.");
    expect(process.exitCode).toBe(0);
  });

  test("rejette des options invalides avant toute action sur les machines", async () => {
    await upCommand({ fullscreen: false, resolution: "pas-une-resolution", fps: null });
    expect(mountShare).not.toHaveBeenCalled();
    expect(runRemoteJson).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(failures.join("\n")).toContain("Invalid resolution");
  });

  test("rapporte l'echec et sort en 1 quand runUp leve", async () => {
    streamThrows = new Error("moonlight a planté");
    await upCommand({ fullscreen: false, resolution: null, fps: null });
    expect(process.exitCode).toBe(1);
    expect(failures.join("\n")).toContain("Could not open the session");
    expect(finishes.join("\n")).toContain("Could not open the session");
  });

  test("dit le code de sortie quand le flux ne sort pas en zero", async () => {
    streamExitCode = 7;
    await upCommand({ fullscreen: false, resolution: null, fps: null });
    expect(finishes.join("\n")).toContain("code 7");
  });

  test("sort en 1 quand Moonlight lui-meme sort en erreur", async () => {
    // Le code de sortie rapporte ce qui a ete observe, ici un flux vu echouer.
    // Un script qui enchaine sur « hardline up » n'a que ce code a lire.
    streamExitCode = 7;
    await upCommand({ fullscreen: false, resolution: null, fps: null });
    expect(process.exitCode).toBe(1);
  });

  test("transmet le plein ecran et les options imposees jusqu'a runStream", async () => {
    await upCommand({ fullscreen: true, resolution: "2560x1440", fps: "144" });
    const passedOptions = (runStream.mock.calls[0] as unknown[])[2];
    expect(passedOptions).toEqual({
      fullscreen: true,
      resolution: { width: 2560, height: 1440 },
      fps: 144,
    });
  });
});

describe("upCommand, le secret ne s'affiche jamais", () => {
  /**
   * Sous Bun, console.log ne passe PAS par process.stdout.write : intercepter
   * le seul flux laisserait passer tout ce que console ecrit. Les deux voies
   * sont donc capturees.
   */
  async function captureSortie(run: () => Promise<void>): Promise<string> {
    const capture: string[] = [];
    const methodes = ["log", "info", "warn", "error", "debug", "trace"] as const;
    const consoleOriginal = new Map<string, unknown>();
    for (const nom of methodes) {
      consoleOriginal.set(nom, console[nom]);
      console[nom] = (...args: unknown[]) => capture.push(args.map(String).join(" "));
    }
    const stdoutOriginal = process.stdout.write.bind(process.stdout);
    const stderrOriginal = process.stderr.write.bind(process.stderr);
    const intercepte = (chunk: unknown): boolean => {
      capture.push(String(chunk));
      return true;
    };
    process.stdout.write = intercepte as typeof process.stdout.write;
    process.stderr.write = intercepte as typeof process.stderr.write;

    try {
      await run();
    } finally {
      for (const nom of methodes) {
        (console as unknown as Record<string, unknown>)[nom] = consoleOriginal.get(nom);
      }
      process.stdout.write = stdoutOriginal;
      process.stderr.write = stderrOriginal;
    }

    return [...capture, ...finishes, ...failures, ...infos, ...warns].join("\n");
  }

  test("aucune trace ne porte le mot de passe, session reussie", async () => {
    windowsPassword = "correct-horse-battery-staple";
    const sortie = await captureSortie(() =>
      upCommand({ fullscreen: false, resolution: null, fps: null }),
    );
    expect(sortie).not.toContain("correct-horse-battery-staple");
  });

  test("aucune trace ne porte le mot de passe quand un montage echoue", async () => {
    windowsPassword = "correct-horse-battery-staple";
    mountThrowsOn = "hardline-d";
    const sortie = await captureSortie(() =>
      upCommand({ fullscreen: false, resolution: null, fps: null }),
    );
    expect(failures.join("\n")).toContain("hardline-d");
    expect(sortie).not.toContain("correct-horse-battery-staple");
  });

  test("le mot de passe n'est jamais un argument de commande visible", async () => {
    windowsPassword = "correct-horse-battery-staple";
    await runUp(CONFIG, NO_OPTIONS);
    // Tout ce qui part vers le PC ou vers Moonlight, mis a plat.
    const argumentsVisibles = [
      ...runRemoteJson.mock.calls,
      ...runRemoteChecked.mock.calls,
      ...runStream.mock.calls,
      ...runQuit.mock.calls,
    ]
      .flat()
      .map((a) => JSON.stringify(a))
      .join("\n");
    expect(argumentsVisibles).not.toContain("correct-horse-battery-staple");
    // Il n'est passe qu'a mountShare, qui compose l'URL SMB lui-meme.
    expect(mountShare.mock.calls.every((c) => c[2] === "correct-horse-battery-staple")).toBe(
      true,
    );
  });
});

describe("upCommand, drapeaux tels que commander les rend", () => {
  test("une option non passee vaut undefined et non null", async () => {
    // commander ne pose jamais null : sans ce cas, le type mentirait sur ce
    // que la ligne de commande transmet reellement.
    await upCommand({ fullscreen: false });
    expect((runStream.mock.calls[0] as unknown[])[2]).toEqual({
      fullscreen: false,
      resolution: null,
      fps: null,
    });
  });
});

describe("upCommand, le spinner ne tourne jamais par-dessus le flux", () => {
  test("runStream part APRES la fermeture du spinner", async () => {
    // runStream lance Moonlight avec les flux du terminal herites : un spinner
    // qui tourne par-dessus entrelace son rendu et reste fige sur son libelle
    // toute la duree de la session. Le contrat de withSpinner l'interdit.
    await upCommand({ fullscreen: false });

    const arret = order.lastIndexOf("spinner:stop:Prepare Session");
    const flux = order.indexOf("runStream");
    expect(arret).toBeGreaterThanOrEqual(0);
    expect(flux).toBeGreaterThan(arret);
  });

  test("la preparation, elle, tourne bien dans le spinner", async () => {
    // Le controle du test precedent : sans lui, un up qui n'ouvrirait aucun
    // spinner le satisferait aussi.
    reachable = false;
    await upCommand({ fullscreen: false });

    const debut = order.indexOf("spinner:start:Prepare Session");
    const arret = order.indexOf("spinner:stop:Prepare Session");
    expect(debut).toBeGreaterThanOrEqual(0);
    for (const evenement of ["sendMagicPacket", "waitForRemote", "mount:arthur"]) {
      const index = order.indexOf(evenement);
      expect(index).toBeGreaterThan(debut);
      expect(index).toBeLessThan(arret);
    }
  });

  test("aucun spinner n'est ouvert autour du flux, ni apres", async () => {
    await upCommand({ fullscreen: false });
    expect(spinnerLabels).toEqual(["Prepare Session"]);
  });

  test("le demontage et la fermeture surviennent hors du spinner, apres le flux", async () => {
    streamThrows = new Error("moonlight a planté");
    await upCommand({ fullscreen: false });

    const arret = order.lastIndexOf("spinner:stop:Prepare Session");
    expect(order.indexOf("unmount:arthur")).toBeGreaterThan(arret);
    expect(order.lastIndexOf("runQuit")).toBeGreaterThan(arret);
    expect(unmountShare).toHaveBeenCalledTimes(3);
    expect(runQuit).toHaveBeenCalledTimes(2);
  });

  test("the phase is complete before the stream starts", async () => {
    await upCommand({ fullscreen: false });
    expect(order.indexOf("runStream")).toBeGreaterThan(order.indexOf("spinner:stop:Prepare Session"));
  });

  test("le spinner annonce les etapes de la preparation", async () => {
    reachable = false;
    apolloStatusRounds = ["Stopped", "Running"];
    await upCommand({ fullscreen: false });
    expect(spinnerProgress).toContain("Wake PC");
    expect(spinnerProgress).toContain("Start Apollo service");
    expect(spinnerProgress).toContain("Mount shares");
  });
});
