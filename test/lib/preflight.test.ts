import { test, expect, describe, mock } from "bun:test";
import { CONFIG } from "../../src/config";

let services: unknown[];
let remoteRows: unknown[];
let remoteThrows: Error | null = null;

// Horloge simulee : chaque sonde SSH et chaque pause avancent le temps, comme
// sur la vraie machine ou une sonde qui echoue coute le delai de connexion.
let clockMs = 0;
let probeCostMs = 0;

// Compteurs d'appels : ce qui distingue les deux phases n'est pas seulement ce
// qu'elles rendent, c'est ce qu'elles touchent. La phase locale ne doit jamais
// sonder le PC, faute de quoi le defaut d'origine revient.
let shellCalls = 0;
let sshCalls = 0;

// La cle publique est un fichier de la vraie machine : le test decide de sa
// presence et de son contenu, jamais le disque.
let publicKey: string | null = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 test\n";
const realFs = await import("node:fs/promises");

mock.module("node:fs/promises", () => ({
  ...realFs,
  readFile: async () => {
    if (publicKey === null) throw new Error("ENOENT");
    return publicKey;
  },
}));

mock.module("../../src/lib/shell", () => ({
  listNetworkServices: async () => {
    shellCalls += 1;
    return services;
  },
}));

mock.module("../../src/lib/ssh", () => ({
  runRemoteJson: async () => {
    sshCalls += 1;
    clockMs += probeCostMs;
    if (remoteThrows) throw remoteThrows;
    return remoteRows;
  },
}));

const {
  runLocalPreflight,
  runRemotePreflight,
  hasBlockingFailure,
  waitForRemote,
} = await import("../../src/lib/preflight");

const PROBE_INTERVAL = 5_000;

const HEALTHY_REMOTE = {
  caption: "Microsoft Windows 11 Professionnel",
  build: 26200,
  gpus: ["NVIDIA GeForce RTX 4090"],
  adapterPresent: true,
  adapterStatus: "Up",
};

const HEALTHY_SERVICES = [
  { order: 1, name: "AX88179A", hardwarePort: "AX88179A", device: "en14", enabled: true },
  { order: 2, name: "Wi-Fi", hardwarePort: "Wi-Fi", device: "en0", enabled: true },
];

function setup(remote: Partial<typeof HEALTHY_REMOTE> = {}, svc = HEALTHY_SERVICES) {
  remoteThrows = null;
  services = svc;
  remoteRows = [{ ...HEALTHY_REMOTE, ...remote }];
  clockMs = 0;
  probeCostMs = 0;
  shellCalls = 0;
  sshCalls = 0;
  publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 test\n";
}

describe("runLocalPreflight", () => {
  test("passe sur le materiel de reference", async () => {
    setup();
    const results = await runLocalPreflight(CONFIG);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(hasBlockingFailure(results)).toBe(false);
  });

  test("ne sonde jamais le PC", async () => {
    setup();
    // Le coeur du correctif : avant que le Mac ait son adresse, aucune route ne
    // mene a 10.10.10.1. Une sonde SSH ici expirerait quel que soit l'etat du PC.
    remoteThrows = new Error("aucune route vers l'hote");
    const results = await runLocalPreflight(CONFIG);
    expect(sshCalls).toBe(0);
    expect(results.map((r) => r.name)).toEqual(["service-mac", "cle-publique"]);
  });

  test("bloque si la cle publique est absente", async () => {
    setup();
    publicKey = null;
    const results = await runLocalPreflight(CONFIG);
    const check = results.find((r) => r.name === "cle-publique");
    // Sans elle, l'amorcage echouerait APRES la convergence du Mac : c'est
    // exactement le genre d'arret que la phase locale existe pour eviter.
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(true);
    expect(check?.detail).toContain("ssh-keygen -t ed25519");
    expect(check?.detail).toContain(`${CONFIG.ssh.identityFile}.pub`);
    expect(hasBlockingFailure(results)).toBe(true);
  });

  test("bloque si la cle publique est vide", async () => {
    setup();
    publicKey = "   \n";
    const check = (await runLocalPreflight(CONFIG)).find(
      (r) => r.name === "cle-publique",
    );
    expect(check?.ok).toBe(false);
  });

  test("la cle publique est la SEULE precondition d'installation pure", async () => {
    // Elle bloque install et ne dit rien de la sante de la liaison : une fois
    // deposee sur le PC, le lien tient sans elle. Toutes les autres decrivent
    // bien l'etat du lien, et doctor doit les compter.
    setup();
    const locales = await runLocalPreflight(CONFIG);
    const distantes = await runRemotePreflight(CONFIG);

    const marquees = [...locales, ...distantes]
      .filter((r) => r.installOnly)
      .map((r) => r.name);
    expect(marquees).toEqual(["cle-publique"]);
    // Et elle reste bloquante : install s'arrete dessus avant toute
    // modification, c'est toute sa raison d'etre en phase locale.
    expect(locales.find((r) => r.name === "cle-publique")?.blocking).toBe(true);
  });

  test("bloque si le service reseau du Mac est absent", async () => {
    setup({}, [
      { order: 1, name: "Wi-Fi", hardwarePort: "Wi-Fi", device: "en0", enabled: true },
    ]);
    const results = await runLocalPreflight(CONFIG);
    const check = results.find((r) => r.name === "service-mac");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(true);
    expect(check?.detail).toContain("AX88179A");
  });

  test("distingue un service desactive d'un service absent", async () => {
    setup({}, [
      { order: 1, name: "AX88179A", hardwarePort: "AX88179A", device: "en14", enabled: false },
      { order: 2, name: "Wi-Fi", hardwarePort: "Wi-Fi", device: "en0", enabled: true },
    ]);
    const check = (await runLocalPreflight(CONFIG)).find((r) => r.name === "service-mac");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(true);
    expect(check?.detail).toContain("disabled");
  });

});

describe("runRemotePreflight", () => {
  test("passe sur le materiel de reference", async () => {
    setup();
    const results = await runRemotePreflight(CONFIG);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(hasBlockingFailure(results)).toBe(false);
  });

  test("n'inspecte aucun service reseau du Mac", async () => {
    setup();
    const results = await runRemotePreflight(CONFIG);
    expect(shellCalls).toBe(0);
    expect(results.find((r) => r.name === "service-mac")).toBeUndefined();
  });

  test("bloque si le PC ne repond pas en SSH", async () => {
    setup();
    remoteThrows = new Error("connexion refusee");
    const results = await runRemotePreflight(CONFIG);
    expect(hasBlockingFailure(results)).toBe(true);
    expect(results.find((r) => r.name === "ssh")?.ok).toBe(false);
  });

  test("n'execute aucune verification distante si SSH est tombe", async () => {
    setup();
    remoteThrows = new Error("connexion refusee");
    const results = await runRemotePreflight(CONFIG);
    // Une seule verification distante, celle qui a echoue : inutile d'en tenter
    // d'autres, elles echoueraient toutes pour la meme raison.
    expect(results.filter((r) => r.name === "windows-version")).toHaveLength(0);
  });

  test("bloque si aucun GPU NVIDIA n'est present", async () => {
    setup({ gpus: ["Intel UHD Graphics 770"] });
    const results = await runRemotePreflight(CONFIG);
    const check = results.find((r) => r.name === "gpu");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(true);
  });

  test("ignore les ecrans virtuels dans la detection du GPU", async () => {
    setup({ gpus: ["SudoMaker Virtual Display Adapter", "NVIDIA GeForce RTX 4090"] });
    expect((await runRemotePreflight(CONFIG)).find((r) => r.name === "gpu")?.ok).toBe(true);
  });

  test("avertit sans bloquer si la version de Windows differe", async () => {
    setup({ build: 22631 });
    const check = (await runRemotePreflight(CONFIG)).find((r) => r.name === "windows-version");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(false);
  });

  test("bloque si l'interface Ethernet du PC est debranchee", async () => {
    setup({ adapterStatus: "Disconnected" });
    const check = (await runRemotePreflight(CONFIG)).find((r) => r.name === "lien-windows");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(true);
    expect(check?.detail).toContain("cable");
  });
});

describe("hasBlockingFailure", () => {
  test("un echec non bloquant ne suffit pas a arreter l'installation", () => {
    expect(
      hasBlockingFailure([
        { name: "a", ok: false, blocking: false, installOnly: false, detail: "" },
        { name: "b", ok: true, blocking: true, installOnly: false, detail: "" },
      ]),
    ).toBe(false);
  });
});

describe("waitForRemote", () => {
  // Une sonde SSH qui echoue coute le delai de connexion, ici huit secondes.
  const SSH_TIMEOUT_MS = 8_000;

  function fakeClock() {
    const slept: number[] = [];
    return {
      slept,
      now: () => clockMs,
      sleep: async (ms: number) => {
        slept.push(ms);
        clockMs += ms;
      },
    };
  }

  test("rend la main des que le PC repond", async () => {
    setup();
    probeCostMs = SSH_TIMEOUT_MS;
    remoteThrows = new Error("injoignable");
    const clock = fakeClock();
    const reachable = await waitForRemote(
      CONFIG,
      40_000,
      async (ms) => {
        await clock.sleep(ms);
        if (clock.slept.length === 2) remoteThrows = null;
      },
      clock.now,
    );
    expect(reachable).toBe(true);
    expect(clock.slept).toEqual([5_000, 5_000]);
    // Deux sondes en echec, deux pauses, une sonde qui aboutit.
    expect(clockMs).toBe(3 * SSH_TIMEOUT_MS + 2 * PROBE_INTERVAL);
    expect(clockMs).toBeLessThanOrEqual(40_000);
  });

  test("abandonne sans depasser le budget d'attente en temps reel", async () => {
    setup();
    probeCostMs = SSH_TIMEOUT_MS;
    remoteThrows = new Error("injoignable");
    const clock = fakeClock();
    const reachable = await waitForRemote(CONFIG, 60_000, clock.sleep, clock.now);
    expect(reachable).toBe(false);
    // Le point qui compte : le temps ecoule reel, sondes comprises, tient dans
    // l'echeance annoncee. Une implementation qui ne compterait que les pauses
    // sortirait ici a 164 s pour un budget de 60 s.
    expect(clockMs).toBeLessThanOrEqual(60_000);
    expect(clock.slept).toEqual([5_000, 5_000, 5_000, 5_000]);
  });
});
