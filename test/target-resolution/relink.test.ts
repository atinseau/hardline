import { describe, expect, test } from "bun:test";
import {
  parseRelinkObservation,
  relinkShared,
  RelinkImpossibleError,
  reviveDormantLink,
  RequestedLinkUnavailableError,
  selectLinkForRun,
  stampLinkOwnership,
  type RelinkDependencies,
  type RelinkWindowsObservation,
} from "../../src/target-resolution/relink";
import { LinkAdapterUnavailableError } from "../../src/target-resolution/link-recovery";
import type { MacBootstrapObservations } from "../../src/target-resolution/bootstrap-target";
import type { NetworkAdapterObservation } from "../../src/target-resolution/network";
import type { TargetProfile } from "../../src/target-resolution/types";
import type { Manifest } from "../../src/lib/manifest";

const adapter = (
  overrides: Partial<NetworkAdapterObservation> = {},
): NetworkAdapterObservation => ({
  stableId: "en0",
  alias: "Wi-Fi",
  hardwareName: "Wi-Fi",
  macAddress: "02:00:00:00:00:0a",
  speedMbps: null,
  physical: true,
  transport: "wifi",
  virtual: false,
  linkState: "up",
  inUse: true,
  hasDefaultRoute: true,
  ipv4Addresses: ["192.168.1.89/24"],
  ...overrides,
});

const profile: TargetProfile = {
  version: 1,
  revision: 16,
  lifecycle: "installed",
  mac: {
    machineId: "MAC-UUID",
    hostAliases: ["studio.local"],
    ethernet: {
      hardwareId: "ether:02:00:00:00:00:02",
      macAddress: "02:00:00:00:00:02",
      interfaceId: "en14",
      serviceName: "AX88179A",
    },
  },
  windows: {
    machineId: "WIN-UUID",
    hostAliases: ["GAMING-PC"],
    administrator: "GAMING-PC\\Arthur",
    smbUser: "GAMING-PC\\Arthur",
    ethernet: {
      hardwareId: "{cable-guid}",
      macAddress: "02-00-00-00-00-01",
      interfaceAlias: "Ethernet",
    },
  },
  directLink: { subnet: "10.0.0.0/30", macAddress: "10.0.0.2", windowsAddress: "10.0.0.1" },
  hardlineIdentity: {
    privateKeyPath: "/state/id_ed25519",
    publicKeyPath: "/state/id_ed25519.pub",
  },
  sshHostKey: { algorithm: "ssh-ed25519", publicKey: "AAAAC3host" },
  installationCatalogVersion: "2026.08.24",
};

const mac: MacBootstrapObservations = {
  machineId: "MAC-UUID",
  hostAliases: ["studio-renamed.local"],
  adapters: [adapter()],
  routes: [],
  addresses: [],
  activeIpv4Addresses: [],
};

const windows: RelinkWindowsObservation = {
  machineId: "WIN-UUID",
  computerName: "GAMING-PC",
  adapters: [
    adapter({
      stableId: "{wifi-guid}",
      alias: "Wi-Fi",
      macAddress: "C8-5E-A9-71-77-53",
      ipv4Addresses: ["192.168.1.48/24"],
    }),
  ],
};

function dependencies(overrides: Partial<RelinkDependencies> = {}): {
  deps: RelinkDependencies;
  persisted: TargetProfile[];
} {
  const persisted: TargetProfile[] = [];
  return {
    persisted,
    deps: {
      observeMac: async () => mac,
      observeWindows: async () => windows,
      probe: async () => true,
      recoveryTarget: (_profile, host) => ({
        host,
        user: "Arthur",
        identityFile: "/state/id_ed25519",
        knownHostsFile: "/state/known_hosts",
        hostKeyAlias: "[hardline-windows]:22",
      }),
      persist: async (candidate) => { persisted.push(candidate); },
      ask: () => { throw new Error("No question was expected."); },
      ...overrides,
    },
  };
}

describe("relinkShared", () => {
  test("adopts the network both machines already share when the named adapter is gone", async () => {
    const { deps, persisted } = dependencies();
    const result = await relinkShared(profile, deps);

    expect(result.resolution).toBe("recovered");
    expect(result.profile.linkKind).toBe("shared");
    expect(result.profile.directLink).toEqual({
      subnet: "192.168.1.0/24",
      macAddress: "192.168.1.89",
      windowsAddress: "192.168.1.48",
      prefixLength: 24,
    });
    expect(result.profile.mac.ethernet).toEqual({
      hardwareId: "ether:02:00:00:00:00:0a",
      macAddress: "02:00:00:00:00:0a",
      interfaceId: "en0",
      serviceName: "Wi-Fi",
    });
    expect(result.profile.windows.ethernet.interfaceAlias).toBe("Wi-Fi");
    // Le reveil doit savoir qu'aucun paquet magique n'atteindra ce PC.
    expect(result.profile.windows.ethernet.wireless).toBe(true);
    expect(result.profile.revision).toBe(profile.revision + 1);
    expect(persisted).toEqual([result.profile]);
  });

  test("writes nothing until the adopted link has answered on its own adapter", async () => {
    const { deps, persisted } = dependencies({ probe: async () => false });
    await expect(relinkShared(profile, deps)).rejects.toThrow(RelinkImpossibleError);
    expect(persisted).toEqual([]);
  });

  test("refuses to build a dedicated link it would have to write through the Recovery Channel", async () => {
    // Les deux machines ne partagent aucun reseau : un lien direct demanderait
    // d'adresser le PC par un canal qui n'a pas le droit de le modifier.
    const { deps, persisted } = dependencies({
      observeWindows: async () => ({
        ...windows,
        adapters: [adapter({ stableId: "{other}", ipv4Addresses: ["10.99.0.30/24"] })],
      }),
    });
    await expect(relinkShared(profile, deps)).rejects.toMatchObject({
      reason: "no-shared-network",
    });
    expect(persisted).toEqual([]);
  });

  test("refuses a machine that answers under the right name but is not the paired PC", async () => {
    const { deps } = dependencies({
      observeWindows: async () => ({ ...windows, machineId: "SOMEONE-ELSE" }),
    });
    await expect(relinkShared(profile, deps)).rejects.toMatchObject({
      reason: "pc-inaccessible",
    });
  });

  test("refuses another Mac before reaching for the PC at all", async () => {
    let reached = false;
    const { deps } = dependencies({
      observeMac: async () => ({ ...mac, machineId: "OTHER-MAC" }),
      observeWindows: async () => { reached = true; return windows; },
    });
    await expect(relinkShared(profile, deps)).rejects.toMatchObject({
      reason: "identity-mismatch",
    });
    expect(reached).toBe(false);
  });

  test("asks which shared network to adopt when several would do", async () => {
    const asked: string[] = [];
    const { deps } = dependencies({
      observeMac: async () => ({
        ...mac,
        adapters: [adapter(), adapter({ stableId: "en5", alias: "Dock", transport: "ethernet", macAddress: "02:00:00:00:00:0c", ipv4Addresses: ["10.77.0.20/24"] })],
      }),
      observeWindows: async () => ({
        ...windows,
        adapters: [
          ...windows.adapters,
          adapter({ stableId: "{lan}", alias: "Ethernet", transport: "ethernet", macAddress: "02-00-00-00-00-0D", ipv4Addresses: ["10.77.0.30/24"] }),
        ],
      }),
      ask: (question) => { asked.push(question.kind); return 0; },
    });
    const result = await relinkShared(profile, deps);
    expect(asked).toEqual(["path"]);
    // Le cable passe devant la radio, comme a l'amorcage.
    expect(result.profile.directLink.subnet).toBe("10.77.0.0/24");
    expect(result.profile.windows.ethernet.wireless).toBe(false);
  });
});

describe("parseRelinkObservation", () => {
  test("reads every physical adapter with its addresses and gateway", () => {
    const observation = parseRelinkObservation(
      [
        "machine\tWIN-UUID\tGAMING-PC",
        "adapter\tEthernet\t{cable}\tIntel I225-V\tE8-9C-25-2A-70-E1\tethernet\tdown\tno\tFalse\t169.254.253.132/16,10.0.0.1/30",
        "adapter\tWi-Fi\t{wifi}\tIntel AX211\tC8-5E-A9-71-77-53\twifi\tup\tyes\tFalse\t192.168.1.48/24",
      ].join("\n"),
    );

    expect(observation.machineId).toBe("WIN-UUID");
    expect(observation.computerName).toBe("GAMING-PC");
    expect(observation.adapters).toHaveLength(2);
    expect(observation.adapters[0]).toMatchObject({
      alias: "Ethernet",
      transport: "ethernet",
      linkState: "down",
      hasDefaultRoute: false,
      ipv4Addresses: ["169.254.253.132/16", "10.0.0.1/30"],
    });
    expect(observation.adapters[1]).toMatchObject({
      transport: "wifi",
      linkState: "up",
      hasDefaultRoute: true,
      inUse: true,
    });
  });

  test("fails closed on a malformed record rather than guessing", () => {
    expect(() => parseRelinkObservation("adapter\tonly\ttwo")).toThrow();
    expect(() => parseRelinkObservation("adapter\tWi-Fi\t{w}\td\tm\twifi\tup\tno\tFalse\t")).toThrow(
      "machine observation is missing",
    );
  });
});

describe("stampLinkOwnership", () => {
  const manifest = (previous: Record<string, unknown>): Manifest => ({
    version: 1,
    createdAt: "2026-08-22T21:09:24.070Z",
    updatedAt: "2026-08-22T21:09:24.070Z",
    order: ["network-mac"],
    steps: { "network-mac": { step: "network-mac", appliedAt: "2026-08-22T21:09:24.070Z", previous } },
  });

  test("names the interface an addressing record belonged to", () => {
    const stamped = stampLinkOwnership(manifest({ mode: "dhcp" }), {
      serviceName: "AX88179A",
      interfaceAlias: "Ethernet",
    });
    expect(stamped.steps["network-mac"]!.previous).toEqual({
      mode: "dhcp",
      serviceName: "AX88179A",
    });
  });

  test("never overwrites a record that already names its own interface", () => {
    const original = manifest({ mode: "dhcp", serviceName: "Dock LAN" });
    expect(stampLinkOwnership(original, { serviceName: "AX88179A", interfaceAlias: "Ethernet" })).toBe(
      original,
    );
  });
});

describe("le cable ne s'oublie pas", () => {
  test("quitter un lien dedie le met en sommeil plutot que de l'effacer", async () => {
    const { deps } = dependencies();
    const result = await relinkShared(profile, deps);

    expect(result.profile.dormantLink).toEqual({
      mac: profile.mac.ethernet,
      windows: profile.windows.ethernet,
      directLink: profile.directLink,
    });
  });

  test("quitter un lien deja partage laisse dormir ce qui dormait", async () => {
    const sleeping = {
      mac: profile.mac.ethernet,
      windows: profile.windows.ethernet,
      directLink: profile.directLink,
    };
    const { deps } = dependencies();
    const result = await relinkShared(
      {
        ...profile,
        linkKind: "shared",
        dormantLink: sleeping,
        directLink: {
          subnet: "10.9.0.0/24",
          macAddress: "10.9.0.5",
          windowsAddress: "10.9.0.6",
          prefixLength: 24,
        },
        mac: { ...profile.mac, ethernet: { ...profile.mac.ethernet, interfaceId: "en3" } },
      },
      deps,
    );

    expect(result.profile.dormantLink).toEqual(sleeping);
  });
});

describe("reviveDormantLink", () => {
  const dormant = {
    mac: profile.mac.ethernet,
    windows: profile.windows.ethernet,
    directLink: profile.directLink,
  };
  const onShared: TargetProfile = {
    ...profile,
    linkKind: "shared",
    dormantLink: dormant,
    directLink: {
      subnet: "192.168.1.0/24",
      macAddress: "192.168.1.89",
      windowsAddress: "192.168.1.48",
      prefixLength: 24,
    },
    mac: {
      ...profile.mac,
      ethernet: {
        hardwareId: "ether:02:00:00:00:00:0a",
        macAddress: "02:00:00:00:00:0a",
        interfaceId: "en0",
        serviceName: "Wi-Fi",
      },
    },
  };
  const cable = adapter({
    stableId: "en14",
    alias: "AX88179A",
    macAddress: "02:00:00:00:00:02",
    transport: "ethernet",
    ipv4Addresses: ["10.0.0.2/30"],
  });

  test("reprend le lien dedie des que son adaptateur repond", async () => {
    const persisted: TargetProfile[] = [];
    const result = await reviveDormantLink(onShared, {
      observeMac: async () => ({ ...mac, adapters: [adapter(), cable] }),
      probe: async () => true,
      persist: async (candidate) => { persisted.push(candidate); },
    });

    if (result.kind !== "revived") throw new Error("le cable aurait du etre repris");
    expect(result.result.resolution).toBe("recovered");
    expect(result.result.profile.linkKind).toBe("direct");
    expect(result.result.profile.directLink).toEqual(profile.directLink);
    expect(result.result.profile.mac.ethernet.interfaceId).toBe("en14");
    expect(result.result.profile.dormantLink).toBeUndefined();
    expect(persisted).toEqual([result.result.profile]);
  });

  test("ne demande rien au reseau tant que l'adaptateur n'est pas la", async () => {
    let probed = false;
    const result = await reviveDormantLink(onShared, {
      observeMac: async () => mac,
      probe: async () => { probed = true; return true; },
      persist: async () => { throw new Error("rien a ecrire"); },
    });

    expect(result.kind).toBe("adapter-absent");
    expect(probed).toBe(false);
  });

  test("un adaptateur branche mais muet laisse le lien partage en place", async () => {
    const persisted: TargetProfile[] = [];
    const result = await reviveDormantLink(onShared, {
      observeMac: async () => ({ ...mac, adapters: [adapter(), cable] }),
      probe: async () => false,
      persist: async (candidate) => { persisted.push(candidate); },
    });

    expect(result.kind).toBe("unreachable");
    expect(persisted).toEqual([]);
  });

  test("un adaptateur debranche puis remplace par un autre ne passe pas pour lui", async () => {
    const result = await reviveDormantLink(onShared, {
      observeMac: async () => ({
        ...mac,
        adapters: [adapter(), { ...cable, macAddress: "02:00:00:00:00:ff" }],
      }),
      probe: async () => true,
      persist: async () => { throw new Error("rien a ecrire"); },
    });

    expect(result.kind).toBe("adapter-absent");
  });

  test("sans rien en sommeil, il n'y a rien a reprendre et rien a observer", async () => {
    let observed = false;
    const result = await reviveDormantLink(profile, {
      observeMac: async () => { observed = true; return mac; },
      probe: async () => true,
      persist: async () => { throw new Error("rien a ecrire"); },
    });

    expect(result.kind).toBe("unknown");
    expect(observed).toBe(false);
  });
});

test("le dongle revenu sous un autre nom BSD reste le meme dongle", async () => {
  // macOS renumerote ses interfaces : en14 peut revenir en en15. L'adresse
  // materielle est ce qui ne bouge pas, le nom se relit.
  const persisted: TargetProfile[] = [];
  const result = await reviveDormantLink(
    {
      ...profile,
      linkKind: "shared",
      dormantLink: {
        mac: profile.mac.ethernet,
        windows: profile.windows.ethernet,
        directLink: profile.directLink,
      },
      directLink: {
        subnet: "192.168.1.0/24",
        macAddress: "192.168.1.89",
        windowsAddress: "192.168.1.48",
        prefixLength: 24,
      },
    },
    {
      observeMac: async () => ({
        ...mac,
        adapters: [
          adapter({
            stableId: "en15",
            alias: "AX88179A",
            macAddress: "02:00:00:00:00:02",
            transport: "ethernet",
            ipv4Addresses: ["10.0.0.2/30"],
          }),
        ],
      }),
      probe: async () => true,
      persist: async (candidate) => { persisted.push(candidate); },
    },
  );

  if (result.kind !== "revived") throw new Error("le dongle aurait du etre reconnu");
  expect(result.result.profile.mac.ethernet).toEqual({
    hardwareId: "ether:02:00:00:00:00:02",
    macAddress: "02:00:00:00:00:02",
    interfaceId: "en15",
    serviceName: "AX88179A",
  });
  expect(persisted).toHaveLength(1);
});

describe("selectLinkForRun", () => {
  const sleeping = {
    mac: profile.mac.ethernet,
    windows: profile.windows.ethernet,
    directLink: profile.directLink,
  };
  const onShared: TargetProfile = {
    ...profile,
    linkKind: "shared",
    dormantLink: sleeping,
    directLink: {
      subnet: "192.168.1.0/24",
      macAddress: "192.168.1.89",
      windowsAddress: "192.168.1.48",
      prefixLength: 24,
    },
  };
  const revived = { profile, resolution: "recovered" as const };
  const validated = { profile: onShared, resolution: "validated" as const };

  const deps = (overrides: Partial<Parameters<typeof selectLinkForRun>[2]> = {}) => ({
    revive: async () => ({ kind: "revived" as const, result: revived }),
    relink: async () => ({ profile: onShared, resolution: "recovered" as const }),
    recoverCurrent: async () => validated,
    ...overrides,
  });

  test("auto reprend le cable des qu'il repond", async () => {
    expect(await selectLinkForRun(onShared, "auto", deps())).toEqual(revived);
  });

  test("auto reste sur le reseau partage quand le cable ne repond pas", async () => {
    const result = await selectLinkForRun(
      onShared,
      "auto",
      deps({ revive: async () => ({ kind: "adapter-absent" }) }),
    );
    expect(result).toEqual(validated);
  });

  test("auto adopte un reseau partage quand l'adaptateur du profil a disparu", async () => {
    const result = await selectLinkForRun(
      profile,
      "auto",
      deps({
        revive: async () => ({ kind: "unknown" }),
        recoverCurrent: async () => { throw new LinkAdapterUnavailableError("mac"); },
      }),
    );
    expect(result.profile.linkKind).toBe("shared");
  });

  test("--link direct echoue en nommant l'adaptateur a brancher", async () => {
    const failing = selectLinkForRun(
      onShared,
      "direct",
      deps({ revive: async () => ({ kind: "adapter-absent" }) }),
    );
    await expect(failing).rejects.toThrow(RequestedLinkUnavailableError);
    await expect(failing).rejects.toThrow("AX88179A, which is not connected");
  });

  test("--link direct distingue un adaptateur branche mais muet", async () => {
    await expect(
      selectLinkForRun(onShared, "direct", deps({ revive: async () => ({ kind: "unreachable" }) })),
    ).rejects.toThrow("does not answer at 10.0.0.1");
  });

  test("--link direct le dit quand aucun lien dedie n'a jamais existe", async () => {
    const { dormantLink: _, ...never } = onShared;
    await expect(
      selectLinkForRun(never, "direct", deps({ revive: async () => ({ kind: "unknown" }) })),
    ).rejects.toThrow("No dedicated link is known");
  });

  test("--link direct ne retombe JAMAIS sur le reseau partage", async () => {
    let relinked = false;
    await expect(
      selectLinkForRun(
        profile,
        "direct",
        deps({
          recoverCurrent: async () => { throw new LinkAdapterUnavailableError("mac"); },
          relink: async () => { relinked = true; return validated; },
        }),
      ),
    ).rejects.toThrow(RequestedLinkUnavailableError);
    expect(relinked).toBe(false);
  });

  test("--link shared quitte un cable qui marche, deliberement", async () => {
    let relinked = false;
    const result = await selectLinkForRun(
      profile,
      "shared",
      deps({
        relink: async () => { relinked = true; return { profile: onShared, resolution: "recovered" }; },
        revive: async () => { throw new Error("aucun reveil de cable attendu"); },
      }),
    );
    expect(relinked).toBe(true);
    expect(result.profile.linkKind).toBe("shared");
  });

  test("--link shared ne va pas rechercher le cable", async () => {
    let revivedCalled = false;
    await selectLinkForRun(
      onShared,
      "shared",
      deps({ revive: async () => { revivedCalled = true; return { kind: "unknown" }; } }),
    );
    expect(revivedCalled).toBe(false);
  });
});
