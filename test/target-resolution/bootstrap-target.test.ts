import { describe, expect, test } from "bun:test";
import {
  NoLinkFoundError,
  prepareBootstrapTarget,
  type AskLink,
  type LinkQuestion,
  type MacBootstrapObservations,
} from "../../src/target-resolution/bootstrap-target";
import type { BootstrapWindowsObservations } from "../../src/lib/bootstrap-server";

const refuse: AskLink = () => {
  throw new Error("No question was expected.");
};

const mac: MacBootstrapObservations = {
  machineId: "mac-platform-uuid",
  hostAliases: ["studio.local"],
  adapters: [
    {
      stableId: "en8",
      alias: "USB LAN",
      hardwareName: "USB 10/100/1000 LAN",
      macAddress: "02:00:00:00:00:02",
      speedMbps: 1000,
      physical: true,
      transport: "ethernet",
      virtual: false,
      linkState: "up",
      inUse: false,
      hasDefaultRoute: false,
      ipv4Addresses: [],
    },
  ],
  routes: ["192.168.1.0/24"],
  addresses: ["192.168.1.20/24"],
  activeIpv4Addresses: [],
};

const windows: BootstrapWindowsObservations = {
  computerName: "GAMING-PC",
  machineId: "windows-product-uuid",
  capturedAt: "2026-08-24T12:00:00.000Z",
  administrator: "GAMING-PC\\Arthur",
  activeIpv4Addresses: [],
  networkAdapters: [
    {
      alias: "Ethernet 2",
      interfaceIndex: 7,
      hardwareId: "{adapter-guid}",
      hardwareName: "USB GbE",
      macAddress: "02-00-00-00-00-01",
      speedMbps: 1000,
      physical: true,
      transport: "ethernet",
      virtual: false,
      linkState: "up",
      ipv4Addresses: ["169.254.10.4/16"],
    },
  ],
  routes: [
    { interfaceIndex: 3, destinationPrefix: "0.0.0.0/0", nextHop: "192.168.1.1" },
    { interfaceIndex: 3, destinationPrefix: "192.168.1.0/24", nextHop: "0.0.0.0" },
  ],
  openSsh: {
    capabilityState: "NotPresent",
    serviceStartType: null,
    serviceStatus: null,
    firewallRulePresent: false,
    administratorsAuthorizedKeysPresent: false,
  },
};

/** Le Mac et le PC sur le meme reseau : une carte Wi-Fi occupee de chaque cote. */
const macOnWifi: MacBootstrapObservations = {
  ...mac,
  adapters: [
    {
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
      ipv4Addresses: ["192.168.1.20/24"],
    },
  ],
};

const windowsOnWifi: BootstrapWindowsObservations = {
  ...windows,
  networkAdapters: [
    {
      alias: "Wi-Fi",
      interfaceIndex: 3,
      hardwareId: "{wifi-guid}",
      hardwareName: "Intel AX210",
      macAddress: "02-00-00-00-00-0B",
      speedMbps: 866,
      physical: true,
      transport: "wifi",
      virtual: false,
      linkState: "up",
      ipv4Addresses: ["192.168.1.30/24"],
    },
  ],
};

const identity = {
  privateKeyPath: "/state/id_ed25519",
  publicKeyPath: "/state/id_ed25519.pub",
  publicKey: "ssh-ed25519 AAAAC3Nza hardline",
};

describe("prepareBootstrapTarget", () => {
  test("selects the unique free pair, allocates a /30 and builds the persisted profile and plan", async () => {
    const prepared = await prepareBootstrapTarget({
      mac,
      windows,
      identity,
      installationCatalogVersion: "2026.08.24",
      ask: refuse,
    });

    expect(prepared.profile).toMatchObject({
      version: 1,
      revision: 1,
      lifecycle: "bootstrap-incomplete",
      linkKind: "direct",
      mac: {
        machineId: "mac-platform-uuid",
        hostAliases: ["studio.local"],
        ethernet: {
          hardwareId: "ether:02:00:00:00:00:02",
          macAddress: "02:00:00:00:00:02",
          interfaceId: "en8",
          serviceName: "USB LAN",
        },
      },
      windows: {
        machineId: "windows-product-uuid",
        hostAliases: ["GAMING-PC"],
        administrator: "GAMING-PC\\Arthur",
        smbUser: "GAMING-PC\\Arthur",
        ethernet: {
          hardwareId: "{adapter-guid}",
          macAddress: "02-00-00-00-00-01",
          interfaceAlias: "Ethernet 2",
        },
      },
      directLink: {
        subnet: "10.0.0.0/30",
        windowsAddress: "10.0.0.1",
        macAddress: "10.0.0.2",
      },
      hardlineIdentity: {
        privateKeyPath: "/state/id_ed25519",
        publicKeyPath: "/state/id_ed25519.pub",
      },
      sshHostKey: null,
      installationCatalogVersion: "2026.08.24",
    });
    expect(prepared.profile.directLink.prefixLength).toBeUndefined();
    expect(prepared.plan).toEqual({
      directLink: {
        interfaceAlias: "Ethernet 2",
        address: "10.0.0.1",
        prefixLength: 30,
        networkCategory: "Private",
      },
      ssh: {
        installServer: true,
        startService: true,
        openFirewall: true,
        firewallRemoteAddress: null,
        administratorPublicKey: identity.publicKey,
      },
    });
  });

  test("derives minimal OpenSSH mutations from observed state", async () => {
    const prepared = await prepareBootstrapTarget({
      mac,
      windows: {
        ...windows,
        openSsh: {
          capabilityState: "Installed",
          serviceStartType: "Automatic",
          serviceStatus: "Running",
          firewallRulePresent: true,
          administratorsAuthorizedKeysPresent: true,
        },
      },
      identity,
      installationCatalogVersion: "2026.08.24",
      ask: refuse,
    });

    expect(prepared.plan.ssh).toMatchObject({
      installServer: false,
      startService: false,
      openFirewall: false,
    });
  });

  test.each(["mac", "windows"] as const)(
    "skips an otherwise free /30 observed in active use on %s",
    async (machine) => {
      const prepared = await prepareBootstrapTarget({
        mac: machine === "mac"
          ? { ...mac, activeIpv4Addresses: ["10.0.0.2/32"] }
          : mac,
        windows: machine === "windows"
          ? { ...windows, activeIpv4Addresses: ["10.0.0.1/32"] }
          : windows,
        identity,
        installationCatalogVersion: "2026.08.24",
        ask: refuse,
      });

      expect(prepared.profile.directLink).toEqual({
        subnet: "10.0.0.4/30",
        windowsAddress: "10.0.0.5",
        macAddress: "10.0.0.6",
      });
    },
  );

  test("fails closed when active-use output is not an IPv4 host observation", async () => {
    await expect(prepareBootstrapTarget({
      mac: { ...mac, activeIpv4Addresses: ["not-an-address/32"] },
      windows,
      identity,
      installationCatalogVersion: "2026.08.24",
      ask: refuse,
    })).rejects.toThrow("Invalid mac active-use observation");
  });

  test("asks which adapter to dedicate rather than guessing between free ones", async () => {
    const second = { ...mac.adapters[0]!, stableId: "en9", alias: "Second USB LAN" };
    const questions: LinkQuestion[] = [];
    const prepared = await prepareBootstrapTarget({
      mac: { ...mac, adapters: [...mac.adapters, second] },
      windows,
      identity,
      installationCatalogVersion: "2026.08.24",
      ask: (question) => {
        questions.push(question);
        return 1;
      },
    });

    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ kind: "adapter", machine: "mac" });
    expect(prepared.profile.mac.ethernet).toMatchObject({
      interfaceId: "en9",
      serviceName: "Second USB LAN",
    });
  });

  test("falls back to the network both machines already share, and mutates no addressing there", async () => {
    const prepared = await prepareBootstrapTarget({
      mac: macOnWifi,
      windows: windowsOnWifi,
      identity,
      installationCatalogVersion: "2026.08.24",
      ask: refuse,
    });

    expect(prepared.profile.linkKind).toBe("shared");
    expect(prepared.profile.directLink).toEqual({
      subnet: "192.168.1.0/24",
      macAddress: "192.168.1.20",
      windowsAddress: "192.168.1.30",
      prefixLength: 24,
    });
    expect(prepared.profile.mac.ethernet).toMatchObject({
      interfaceId: "en0",
      serviceName: "Wi-Fi",
    });
    expect(prepared.plan.directLink).toEqual({
      interfaceAlias: "Wi-Fi",
      address: null,
      prefixLength: 24,
      networkCategory: null,
    });
    // La regle de pare-feu ne peut pas s'appuyer sur un profil Private que
    // hardline n'a pas le droit d'imposer : elle est bornee au sous-reseau.
    expect(prepared.plan.ssh.firewallRemoteAddress).toBe("192.168.1.0/24");
  });

  test("prefers a free cable over a network the machines already share", async () => {
    const prepared = await prepareBootstrapTarget({
      mac: { ...mac, adapters: [...macOnWifi.adapters, ...mac.adapters] },
      windows: {
        ...windows,
        networkAdapters: [...windowsOnWifi.networkAdapters, ...windows.networkAdapters],
      },
      identity,
      installationCatalogVersion: "2026.08.24",
      ask: refuse,
    });

    expect(prepared.profile.linkKind).toBe("direct");
    expect(prepared.profile.mac.ethernet.interfaceId).toBe("en8");
  });

  test("asks which shared network to use when several would do", async () => {
    const questions: LinkQuestion[] = [];
    const prepared = await prepareBootstrapTarget({
      mac: {
        ...macOnWifi,
        adapters: [
          ...macOnWifi.adapters,
          {
            ...macOnWifi.adapters[0]!,
            stableId: "en5",
            alias: "Dock LAN",
            macAddress: "02:00:00:00:00:0c",
            transport: "ethernet",
            hasDefaultRoute: false,
            ipv4Addresses: ["10.77.0.20/24"],
          },
        ],
      },
      windows: {
        ...windowsOnWifi,
        networkAdapters: [
          ...windowsOnWifi.networkAdapters,
          {
            ...windowsOnWifi.networkAdapters[0]!,
            alias: "Ethernet",
            interfaceIndex: 9,
            hardwareId: "{lan-guid}",
            macAddress: "02-00-00-00-00-0D",
            transport: "ethernet",
            ipv4Addresses: ["10.77.0.30/24"],
          },
        ],
      },
      identity,
      installationCatalogVersion: "2026.08.24",
      ask: (question) => {
        questions.push(question);
        return 0;
      },
    });

    expect(questions).toHaveLength(1);
    expect(questions[0]?.kind).toBe("path");
    // Le cable passe devant la radio quand les deux chemins sont reels.
    expect(prepared.profile.directLink.subnet).toBe("10.77.0.0/24");
  });

  test("refuses to invent a link when the machines share no network and no adapter is free", async () => {
    await expect(prepareBootstrapTarget({
      mac: macOnWifi,
      windows: {
        ...windowsOnWifi,
        networkAdapters: [
          { ...windowsOnWifi.networkAdapters[0]!, ipv4Addresses: ["10.99.0.30/24"] },
        ],
      },
      identity,
      installationCatalogVersion: "2026.08.24",
      ask: refuse,
    })).rejects.toThrow(NoLinkFoundError);
  });
});
