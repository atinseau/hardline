import { test, expect, describe, mock } from "bun:test";
import { CONFIG } from "../../src/config";

let services: unknown[];
let remoteRows: unknown[];
let remoteThrows: Error | null = null;

mock.module("../../src/lib/shell", () => ({
  listNetworkServices: async () => services,
}));

mock.module("../../src/lib/ssh", () => ({
  runRemoteJson: async () => {
    if (remoteThrows) throw remoteThrows;
    return remoteRows;
  },
}));

const { runPreflight, hasBlockingFailure } = await import(
  "../../src/lib/preflight"
);

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
}

describe("runPreflight", () => {
  test("toutes les verifications passent sur le materiel de reference", async () => {
    setup();
    const results = await runPreflight(CONFIG);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(hasBlockingFailure(results)).toBe(false);
  });

  test("bloque si le service reseau du Mac est absent", async () => {
    setup({}, [
      { order: 1, name: "Wi-Fi", hardwarePort: "Wi-Fi", device: "en0", enabled: true },
    ]);
    const results = await runPreflight(CONFIG);
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
    const check = (await runPreflight(CONFIG)).find((r) => r.name === "service-mac");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(true);
    expect(check?.detail).toContain("désactivé");
  });

  test("bloque si le PC ne repond pas en SSH", async () => {
    setup();
    remoteThrows = new Error("connexion refusee");
    const results = await runPreflight(CONFIG);
    expect(hasBlockingFailure(results)).toBe(true);
    expect(results.find((r) => r.name === "ssh")?.ok).toBe(false);
  });

  test("n'execute aucune verification distante si SSH est tombe", async () => {
    setup();
    remoteThrows = new Error("connexion refusee");
    const results = await runPreflight(CONFIG);
    // Une seule verification distante, celle qui a echoue : inutile d'en tenter
    // d'autres, elles echoueraient toutes pour la meme raison.
    expect(results.filter((r) => r.name === "windows-version")).toHaveLength(0);
  });

  test("bloque si aucun GPU NVIDIA n'est present", async () => {
    setup({ gpus: ["Intel UHD Graphics 770"] });
    const results = await runPreflight(CONFIG);
    const check = results.find((r) => r.name === "gpu");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(true);
  });

  test("ignore les ecrans virtuels dans la detection du GPU", async () => {
    setup({ gpus: ["SudoMaker Virtual Display Adapter", "NVIDIA GeForce RTX 4090"] });
    expect((await runPreflight(CONFIG)).find((r) => r.name === "gpu")?.ok).toBe(true);
  });

  test("avertit sans bloquer si la version de Windows differe", async () => {
    setup({ build: 22631 });
    const check = (await runPreflight(CONFIG)).find((r) => r.name === "windows-version");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(false);
  });

  test("bloque si l'interface Ethernet du PC est debranchee", async () => {
    setup({ adapterStatus: "Disconnected" });
    const check = (await runPreflight(CONFIG)).find((r) => r.name === "lien-windows");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(true);
    expect(check?.detail).toContain("câble");
  });
});

describe("hasBlockingFailure", () => {
  test("un echec non bloquant ne suffit pas a arreter l'installation", () => {
    expect(
      hasBlockingFailure([
        { name: "a", ok: false, blocking: false, detail: "" },
        { name: "b", ok: true, blocking: true, detail: "" },
      ]),
    ).toBe(false);
  });
});
