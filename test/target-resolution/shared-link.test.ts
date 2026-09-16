import { describe, expect, test } from "bun:test";
import { commonSubnet, recoverSharedLink } from "../../src/target-resolution/shared-link";
import {
  DirectLinkUnavailableError,
  LinkIdentityMismatchError,
  type LinkRecoveryAdapters,
  type MacLinkObservation,
  type WindowsLinkObservation,
} from "../../src/target-resolution/link-recovery";
import type { TargetProfile } from "../../src/target-resolution/types";

const profile: TargetProfile = {
  version: 1,
  revision: 3,
  lifecycle: "installed",
  linkKind: "shared",
  mac: {
    machineId: "MAC-UUID",
    hostAliases: ["studio.local"],
    ethernet: {
      hardwareId: "ether:02:00:00:00:00:0a",
      macAddress: "02:00:00:00:00:0a",
      interfaceId: "en0",
      serviceName: "Wi-Fi",
    },
  },
  windows: {
    machineId: "WIN-UUID",
    hostAliases: ["GAMING-PC"],
    administrator: "GAMING-PC\\Arthur",
    smbUser: "GAMING-PC\\Arthur",
    ethernet: {
      hardwareId: "{wifi-guid}",
      macAddress: "02-00-00-00-00-0B",
      interfaceAlias: "Wi-Fi",
    },
  },
  directLink: {
    subnet: "192.168.1.0/24",
    macAddress: "192.168.1.20",
    windowsAddress: "192.168.1.30",
    prefixLength: 24,
  },
  hardlineIdentity: {
    privateKeyPath: "/state/id_ed25519",
    publicKeyPath: "/state/id_ed25519.pub",
  },
  sshHostKey: { algorithm: "ssh-ed25519", publicKey: "AAAAC3host" },
  installationCatalogVersion: "2026.08.24",
};

const macAt = (addresses: string[]): MacLinkObservation => ({
  machineId: profile.mac.machineId,
  hostAliases: profile.mac.hostAliases,
  selectedEthernet: {
    hardwareId: profile.mac.ethernet.hardwareId,
    macAddress: profile.mac.ethernet.macAddress,
    interfaceId: profile.mac.ethernet.interfaceId,
    serviceName: profile.mac.ethernet.serviceName,
    addresses,
  },
  occupiedCidrs: [],
});

const windowsAt = (addresses: string[]): WindowsLinkObservation => ({
  machineId: profile.windows.machineId,
  hostAliases: profile.windows.hostAliases,
  selectedEthernet: {
    hardwareId: profile.windows.ethernet.hardwareId,
    macAddress: profile.windows.ethernet.macAddress,
    interfaceAlias: profile.windows.ethernet.interfaceAlias,
    addresses,
  },
  occupiedCidrs: [],
});

const forbidden = (name: string) => () => {
  throw new Error("A shared link must never " + name + ".");
};

function adapters(options: {
  mac: MacLinkObservation;
  direct: (candidate: TargetProfile) => WindowsLinkObservation | null;
  recovery?: WindowsLinkObservation | null;
  written: TargetProfile[];
}): LinkRecoveryAdapters {
  return {
    macObservation: { observeMacLink: async () => options.mac },
    macAddressing: {
      addMacAddress: forbidden("add a Mac address"),
      removeMacAddress: forbidden("remove a Mac address"),
    },
    strictDirectProbe: {
      probeDirect: async (candidate) => {
        const windows = options.direct(candidate);
        return windows ? { kind: "reachable", windows } : { kind: "unavailable" };
      },
    },
    directLinkAddressing: {
      addWindowsAddressOverDirectLink: forbidden("address the PC"),
      addWindowsAddressOverObservedPhysicalLink: forbidden("address the PC"),
      removeWindowsAddressOverDirectLink: forbidden("remove a PC address"),
    },
    recoveryChannel: {
      observeRecovery: async () =>
        options.recovery
          ? { kind: "pc-alive", windows: options.recovery }
          : { kind: "pc-inaccessible" },
    },
    profilePersistence: {
      persistProfileAtomically: async (candidate) => {
        options.written.push(candidate);
      },
    },
  };
}

describe("shared link recovery", () => {
  test("validates without writing when the PC answers at the recorded address", async () => {
    const written: TargetProfile[] = [];
    const result = await recoverSharedLink(
      profile,
      adapters({
        mac: macAt(["192.168.1.20/24"]),
        direct: () => windowsAt(["192.168.1.30/24"]),
        written,
      }),
    );

    expect(result).toEqual({ profile, resolution: "validated" });
    expect(written).toEqual([]);
  });

  test("follows both machines to their new leases and rewrites the profile", async () => {
    const written: TargetProfile[] = [];
    const result = await recoverSharedLink(
      profile,
      adapters({
        mac: macAt(["192.168.1.40/24"]),
        // L'ancienne adresse ne repond plus ; la nouvelle, si.
        direct: (candidate) =>
          candidate.directLink.windowsAddress === "192.168.1.55"
            ? windowsAt(["192.168.1.55/24"])
            : null,
        recovery: windowsAt(["192.168.1.55/24"]),
        written,
      }),
    );

    expect(result.resolution).toBe("recovered");
    expect(result.profile.directLink).toEqual({
      subnet: "192.168.1.0/24",
      macAddress: "192.168.1.40",
      windowsAddress: "192.168.1.55",
      prefixLength: 24,
    });
    expect(result.profile.revision).toBe(profile.revision + 1);
    expect(written).toEqual([result.profile]);
  });

  test("writes nothing when the relearned link cannot be proven from the Mac", async () => {
    const written: TargetProfile[] = [];
    await expect(recoverSharedLink(
      profile,
      adapters({
        mac: macAt(["192.168.1.40/24"]),
        direct: () => null,
        recovery: windowsAt(["192.168.1.55/24"]),
        written,
      }),
    )).rejects.toThrow(DirectLinkUnavailableError);
    expect(written).toEqual([]);
  });

  test("reports an inaccessible PC rather than guessing an address", async () => {
    const written: TargetProfile[] = [];
    await expect(recoverSharedLink(
      profile,
      adapters({
        mac: macAt(["192.168.1.20/24"]),
        direct: () => null,
        written,
      }),
    )).rejects.toThrow(DirectLinkUnavailableError);
  });

  test("refuses a machine that is not the paired one", async () => {
    const written: TargetProfile[] = [];
    await expect(recoverSharedLink(
      profile,
      adapters({
        mac: { ...macAt(["192.168.1.20/24"]), machineId: "OTHER-MAC" },
        direct: () => windowsAt(["192.168.1.30/24"]),
        written,
      }),
    )).rejects.toThrow(LinkIdentityMismatchError);
  });
});

describe("commonSubnet", () => {
  test("pairs two addresses of the same network", () => {
    expect(commonSubnet(["10.4.0.9/16"], ["10.4.7.2/16"])).toEqual({
      subnet: "10.4.0.0/16",
      macAddress: "10.4.0.9",
      windowsAddress: "10.4.7.2",
      prefixLength: 16,
    });
  });

  test("ignores link-local, loopback, mismatched prefixes and foreign networks", () => {
    expect(commonSubnet(["169.254.1.2/16"], ["169.254.3.4/16"])).toBeNull();
    expect(commonSubnet(["127.0.0.1/8"], ["127.0.0.2/8"])).toBeNull();
    expect(commonSubnet(["192.168.1.20/24"], ["192.168.1.30/16"])).toBeNull();
    expect(commonSubnet(["192.168.1.20/24"], ["10.0.0.30/24"])).toBeNull();
    expect(commonSubnet(["192.168.1.20/24"], ["192.168.1.20/24"])).toBeNull();
  });
});
