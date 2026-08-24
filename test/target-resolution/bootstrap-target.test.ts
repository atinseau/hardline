import { describe, expect, test } from "bun:test";
import {
  BootstrapTargetSelectionError,
  prepareBootstrapTarget,
  type MacBootstrapObservations,
} from "../../src/target-resolution/bootstrap-target";
import type { BootstrapWindowsObservations } from "../../src/lib/bootstrap-server";

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

const identity = {
  privateKeyPath: "/state/id_ed25519",
  publicKeyPath: "/state/id_ed25519.pub",
  publicKey: "ssh-ed25519 AAAAC3Nza hardline",
};

describe("prepareBootstrapTarget", () => {
  test("selects the unique free pair, allocates a /30 and builds the persisted profile and plan", () => {
    const prepared = prepareBootstrapTarget({
      mac,
      windows,
      identity,
      installationCatalogVersion: "2026.08.24",
    });

    expect(prepared.profile).toMatchObject({
      version: 1,
      revision: 1,
      lifecycle: "bootstrap-incomplete",
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
        administratorPublicKey: identity.publicKey,
      },
    });
  });

  test("derives minimal OpenSSH mutations from observed state", () => {
    const prepared = prepareBootstrapTarget({
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
    });

    expect(prepared.plan.ssh).toMatchObject({
      installServer: false,
      startService: false,
      openFirewall: false,
    });
  });

  test.each(["mac", "windows"] as const)(
    "skips an otherwise free /30 observed in active use on %s",
    (machine) => {
      const prepared = prepareBootstrapTarget({
        mac: machine === "mac"
          ? { ...mac, activeIpv4Addresses: ["10.0.0.2/32"] }
          : mac,
        windows: machine === "windows"
          ? { ...windows, activeIpv4Addresses: ["10.0.0.1/32"] }
          : windows,
        identity,
        installationCatalogVersion: "2026.08.24",
      });

      expect(prepared.profile.directLink).toEqual({
        subnet: "10.0.0.4/30",
        windowsAddress: "10.0.0.5",
        macAddress: "10.0.0.6",
      });
    },
  );

  test("fails closed when active-use output is not an IPv4 host observation", () => {
    expect(() => prepareBootstrapTarget({
      mac: { ...mac, activeIpv4Addresses: ["not-an-address/32"] },
      windows,
      identity,
      installationCatalogVersion: "2026.08.24",
    })).toThrow("Invalid mac active-use observation");
  });

  test("returns machine-specific ambiguity rather than guessing", () => {
    expect(() =>
      prepareBootstrapTarget({
        mac: { ...mac, adapters: [...mac.adapters, { ...mac.adapters[0]!, stableId: "en9" }] },
        windows,
        identity,
        installationCatalogVersion: "2026.08.24",
      }),
    ).toThrow(BootstrapTargetSelectionError);

    try {
      prepareBootstrapTarget({
        mac: { ...mac, adapters: [...mac.adapters, { ...mac.adapters[0]!, stableId: "en9" }] },
        windows,
        identity,
        installationCatalogVersion: "2026.08.24",
      });
    } catch (error) {
      expect(error).toMatchObject({ machine: "mac", result: { kind: "ambiguous" } });
    }
  });

  test("uses an explicit operator choice only among genuinely ambiguous candidates", () => {
    const second = { ...mac.adapters[0]!, stableId: "en9", alias: "Second USB LAN" };
    const prepared = prepareBootstrapTarget({
      mac: { ...mac, adapters: [...mac.adapters, second] },
      windows,
      identity,
      installationCatalogVersion: "2026.08.24",
      selectedMacInterfaceId: "en9",
    });

    expect(prepared.profile.mac.ethernet).toMatchObject({
      hardwareId: "ether:02:00:00:00:00:02",
      interfaceId: "en9",
      serviceName: "Second USB LAN",
    });
  });
});
