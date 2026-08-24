import { describe, expect, test } from "bun:test";
import {
  DirectLinkUnavailableError,
  LinkIdentityMismatchError,
  LinkRecovery,
  type LinkRecoveryAdapters,
  type MacLinkObservation,
  type RecoveryChannelObservation,
  type WindowsLinkObservation,
} from "../../src/target-resolution/link-recovery";
import type { TargetProfile } from "../../src/target-resolution/types";

const profile: TargetProfile = {
  version: 1,
  revision: 4,
  lifecycle: "installed",
  mac: {
    machineId: "mac-uuid",
    hostAliases: ["studio.local"],
    ethernet: {
      hardwareId: "ether:02:00:00:00:00:02",
      macAddress: "02:00:00:00:00:02",
      interfaceId: "en8",
      serviceName: "USB LAN",
    },
  },
  windows: {
    machineId: "windows-uuid",
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
  sshHostKey: { algorithm: "ssh-ed25519", publicKey: "AAAAC3Nza-host" },
  installationCatalogVersion: "2026.08.24",
};

const macObservation: MacLinkObservation = {
  machineId: "mac-uuid",
  hostAliases: ["studio.local"],
  selectedEthernet: {
    hardwareId: "ether:02:00:00:00:00:02",
    macAddress: "02:00:00:00:00:02",
    interfaceId: "en8",
    serviceName: "USB LAN",
    addresses: ["10.0.0.2/30"],
  },
  occupiedCidrs: [],
};

const windowsObservation: WindowsLinkObservation = {
  machineId: "windows-uuid",
  hostAliases: ["GAMING-PC"],
  selectedEthernet: {
    interfaceAlias: "Ethernet 2",
    hardwareId: "{adapter-guid}",
    macAddress: "02-00-00-00-00-01",
    addresses: ["10.0.0.1/30"],
  },
  occupiedCidrs: [],
};

function harness(overrides: Partial<LinkRecoveryAdapters> = {}) {
  const events: string[] = [];
  const adapters: LinkRecoveryAdapters = {
    macObservation: {
      observeMacLink: async () => {
        events.push("observe-mac");
        return macObservation;
      },
    },
    macAddressing: {
      addMacAddress: async (_hardwareId, address) => {
        events.push(`add-mac:${address}`);
      },
      removeMacAddress: async (_hardwareId, address) => {
        events.push(`remove-mac:${address}`);
      },
    },
    strictDirectProbe: {
      probeDirect: async (candidate) => {
        events.push(`probe:${candidate.directLink.windowsAddress}`);
        return { kind: "reachable", windows: windowsObservation };
      },
    },
    directLinkAddressing: {
      addWindowsAddressOverDirectLink: async (_current, candidate) => {
        events.push(`add-windows:${candidate.directLink.windowsAddress}`);
      },
      removeWindowsAddressOverDirectLink: async (_current, address) => {
        events.push(`remove-windows:${address}`);
      },
      addWindowsAddressOverObservedPhysicalLink: async (_current, _proposed, physicalPath) => {
        events.push(
          `repair-physical:${physicalPath.macAddress}->${physicalPath.windowsAddress}`,
        );
      },
    },
    recoveryChannel: {
      observeRecovery: async () => {
        events.push("observe-recovery");
        return { kind: "pc-inaccessible" };
      },
    },
    profilePersistence: {
      persistProfileAtomically: async (candidate) => {
        events.push(`persist:${candidate.revision}`);
      },
    },
    ...overrides,
  };
  return { events, adapters, recovery: new LinkRecovery(adapters) };
}

describe("LinkRecovery", () => {
  test("a healthy Direct Link is validated without writes", async () => {
    const { events, recovery } = harness();

    await expect(recovery.recover(profile)).resolves.toEqual({ profile, resolution: "validated" });
    expect(events).toEqual(["observe-mac", "probe:10.0.0.1"]);
  });

  test("default routes do not trigger a pointless migration", async () => {
    const defaultRoute = {
      cidr: "0.0.0.0/0",
      source: "route" as const,
      ownership: "other" as const,
    };
    const { events, recovery } = harness({
      macObservation: {
        observeMacLink: async () => ({
          ...macObservation,
          occupiedCidrs: [defaultRoute],
        }),
      },
      strictDirectProbe: {
        probeDirect: async () => ({
          kind: "reachable",
          windows: { ...windowsObservation, occupiedCidrs: [defaultRoute] },
        }),
      },
    });

    await expect(recovery.recover(profile)).resolves.toMatchObject({
      resolution: "validated",
    });
    expect(events).not.toContain("persist:5");
  });

  test("the Recovery Channel observation contract exposes no mutation capability", () => {
    type Keys = keyof RecoveryChannelObservation;
    const onlyCapability: Keys = "observeRecovery";
    expect(onlyCapability).toBe("observeRecovery");
  });

  test("a Mac stable-identity mismatch stops before probing or mutation", async () => {
    const { events, recovery } = harness({
      macObservation: {
        observeMacLink: async () => {
          events.push("observe-mac");
          return { ...macObservation, machineId: "different-mac" };
        },
      },
    });

    await expect(recovery.recover(profile)).rejects.toMatchObject({
      name: "LinkIdentityMismatchError",
      machine: "mac",
      identity: "machine-id",
      expected: "mac-uuid",
      observed: "different-mac",
    } satisfies Partial<LinkIdentityMismatchError>);
    expect(events).toEqual(["observe-mac"]);
  });

  test("selected Mac hardware identity and MAC are identity, not the adapter alias", async () => {
    for (const selectedEthernet of [
      {
        ...macObservation.selectedEthernet,
        hardwareId: "ether:02:00:00:00:00:99",
      },
      { ...macObservation.selectedEthernet, macAddress: "02:00:00:00:00:99" },
    ]) {
      const { events, recovery } = harness({
        macObservation: {
          observeMacLink: async () => {
            events.push("observe-mac");
            return { ...macObservation, selectedEthernet };
          },
        },
      });

      await expect(recovery.recover(profile)).rejects.toBeInstanceOf(LinkIdentityMismatchError);
      expect(events).toEqual(["observe-mac"]);
    }
  });

  test("re-resolves a re-enumerated Mac adapter without changing its stable hardware identity", async () => {
    let persisted: TargetProfile | undefined;
    const { recovery } = harness({
      macObservation: {
        observeMacLink: async () => ({
          ...macObservation,
          selectedEthernet: { ...macObservation.selectedEthernet, interfaceId: "en9" },
        }),
      },
      profilePersistence: {
        persistProfileAtomically: async (candidate) => {
          persisted = candidate;
        },
      },
    });

    await expect(recovery.recover(profile)).resolves.toMatchObject({
      resolution: "recovered",
      profile: {
        mac: {
          ethernet: {
            hardwareId: "ether:02:00:00:00:00:02",
            interfaceId: "en9",
          },
        },
      },
    });
    expect(persisted?.mac.ethernet).toMatchObject({
      hardwareId: "ether:02:00:00:00:00:02",
      interfaceId: "en9",
    });
  });

  test("adds a missing expected Mac address before the strict Direct Link probe", async () => {
    const { events, recovery } = harness({
      macObservation: {
        observeMacLink: async () => {
          events.push("observe-mac");
          return {
            ...macObservation,
            selectedEthernet: { ...macObservation.selectedEthernet, addresses: [] },
          };
        },
      },
    });

    await expect(recovery.recover(profile)).resolves.toMatchObject({ resolution: "recovered" });
    expect(events).toEqual([
      "observe-mac",
      "probe:10.0.0.1",
      "persist:5",
      "add-mac:10.0.0.2",
      "probe:10.0.0.1",
      "persist:6",
    ]);
  });

  test("clean post-bootstrap cable setup journals and adds Mac before its first strict probe", async () => {
    const bootstrapProfile: TargetProfile = {
      ...profile,
      lifecycle: "installation-incomplete",
    };
    const { events, recovery } = harness({
      macObservation: {
        observeMacLink: async () => {
          events.push("observe-mac");
          return {
            ...macObservation,
            selectedEthernet: { ...macObservation.selectedEthernet, addresses: [] },
          };
        },
      },
    });

    await expect(recovery.recover(bootstrapProfile)).resolves.toMatchObject({
      resolution: "recovered",
      profile: { revision: 6, lifecycle: "installation-incomplete" },
    });
    expect(events).toEqual([
      "observe-mac",
      "persist:5",
      "add-mac:10.0.0.2",
      "probe:10.0.0.1",
      "persist:6",
    ]);
    expect(events).not.toContain("observe-recovery");
    expect(events.some((event) => event.startsWith("add-windows:"))).toBe(false);
  });

  test("an interrupted clean post-bootstrap Mac setup resumes from its durable journal", async () => {
    const bootstrapProfile: TargetProfile = {
      ...profile,
      lifecycle: "installation-incomplete",
    };
    let journaled: TargetProfile | undefined;
    const first = harness({
      macObservation: {
        observeMacLink: async () => ({
          ...macObservation,
          selectedEthernet: { ...macObservation.selectedEthernet, addresses: [] },
        }),
      },
      macAddressing: {
        addMacAddress: async () => {
          throw new Error("interrupted before Mac mutation");
        },
        removeMacAddress: async () => {},
      },
      profilePersistence: {
        persistProfileAtomically: async (candidate) => {
          journaled = candidate;
        },
      },
    });

    await expect(first.recovery.recover(bootstrapProfile)).rejects.toThrow("interrupted");
    expect(journaled).toMatchObject({
      revision: 5,
      pendingMigration: {
        operation: "initial-link",
        oldLink: profile.directLink,
        proposedLink: profile.directLink,
      },
    });

    const resumed = harness({
      macObservation: {
        observeMacLink: async () => ({
          ...macObservation,
          selectedEthernet: { ...macObservation.selectedEthernet, addresses: [] },
        }),
      },
    });
    const result = await resumed.recovery.recover(journaled!);

    expect(result.profile).not.toHaveProperty("pendingMigration");
    expect(resumed.events).toEqual([
      "add-mac:10.0.0.2",
      "probe:10.0.0.1",
      "persist:6",
    ]);
    expect(resumed.events).not.toContain("observe-recovery");
  });

  test.each([
    ["pc-alive", "pc-alive/direct-link-broken"],
    ["pc-inaccessible", "pc-inaccessible"],
  ] as const)("a failed Direct Link uses only read-only Recovery Channel observation: %s", async (kind, diagnosis) => {
    const { events, recovery } = harness({
      strictDirectProbe: {
        probeDirect: async () => {
          events.push("probe:10.0.0.1");
          return { kind: "unavailable" };
        },
      },
      recoveryChannel: {
        observeRecovery: async () => {
          events.push("observe-recovery");
          return kind === "pc-alive"
            ? { kind, windows: windowsObservation }
            : { kind };
        },
      },
    });

    await expect(recovery.recover(profile)).rejects.toMatchObject({
      name: "DirectLinkUnavailableError",
      diagnosis,
    } satisfies Partial<DirectLinkUnavailableError>);
    expect(events).toEqual(["observe-mac", "probe:10.0.0.1", "observe-recovery"]);
  });

  test("repairs Windows address drift over an observed physical link-local path", async () => {
    let probes = 0;
    const { events, recovery } = harness({
      strictDirectProbe: {
        probeDirect: async () => {
          probes += 1;
          events.push("probe:10.0.0.1");
          return probes === 1
            ? { kind: "unavailable" }
            : { kind: "reachable", windows: windowsObservation };
        },
      },
      recoveryChannel: {
        observeRecovery: async () => {
          events.push("observe-recovery");
          return {
            kind: "pc-alive",
            windows: windowsObservation,
            physicalPath: {
              macAddress: "169.254.20.2",
              windowsAddress: "169.254.20.1",
            },
          };
        },
      },
    });

    await expect(recovery.recover(profile)).resolves.toMatchObject({
      resolution: "recovered",
    });
    expect(events).toEqual([
      "observe-mac",
      "probe:10.0.0.1",
      "observe-recovery",
      "persist:5",
      "repair-physical:169.254.20.2->169.254.20.1",
      "probe:10.0.0.1",
      "persist:6",
    ]);
  });

  test("a composite Windows identity mismatch stops before mutation", async () => {
    const mismatches: WindowsLinkObservation[] = [
      { ...windowsObservation, machineId: "replacement-pc" },
      {
        ...windowsObservation,
        selectedEthernet: { ...windowsObservation.selectedEthernet, hardwareId: "{other-guid}" },
      },
      {
        ...windowsObservation,
        selectedEthernet: {
          ...windowsObservation.selectedEthernet,
          macAddress: "02-00-00-00-00-99",
        },
      },
    ];
    for (const windows of mismatches) {
      const { events, recovery } = harness({
        strictDirectProbe: {
          probeDirect: async () => {
            events.push("probe:10.0.0.1");
            return { kind: "reachable", windows };
          },
        },
      });

      await expect(recovery.recover(profile)).rejects.toBeInstanceOf(LinkIdentityMismatchError);
      expect(events).toEqual(["observe-mac", "probe:10.0.0.1"]);
    }
  });

  test("a Recovery Channel composite identity mismatch stops before address repair or intent persistence", async () => {
    const { events, recovery } = harness({
      macObservation: {
        observeMacLink: async () => {
          events.push("observe-mac");
          return {
            ...macObservation,
            selectedEthernet: { ...macObservation.selectedEthernet, addresses: [] },
          };
        },
      },
      strictDirectProbe: {
        probeDirect: async () => {
          events.push("probe:10.0.0.1");
          return { kind: "unavailable" };
        },
      },
      recoveryChannel: {
        observeRecovery: async () => {
          events.push("observe-recovery");
          return {
            kind: "pc-alive",
            windows: {
              ...windowsObservation,
              selectedEthernet: {
                ...windowsObservation.selectedEthernet,
                hardwareId: "{replacement-adapter}",
              },
            },
            physicalPath: {
              macAddress: "169.254.20.2",
              windowsAddress: "169.254.20.1",
            },
          };
        },
      },
    });

    await expect(recovery.recover(profile)).rejects.toBeInstanceOf(LinkIdentityMismatchError);
    expect(events).toEqual(["observe-mac", "probe:10.0.0.1", "observe-recovery"]);
  });

  test("alias drift is atomically persisted with one revision increment", async () => {
    const changedMac = {
      ...macObservation,
      hostAliases: ["studio-renamed.local"],
      selectedEthernet: { ...macObservation.selectedEthernet, serviceName: "Direct Cable" },
    };
    const changedWindows = {
      ...windowsObservation,
      hostAliases: ["PLAY-PC"],
      selectedEthernet: {
        ...windowsObservation.selectedEthernet,
        interfaceAlias: "Hardline Ethernet",
      },
    };
    let persisted: TargetProfile | undefined;
    const { events, recovery } = harness({
      macObservation: {
        observeMacLink: async () => {
          events.push("observe-mac");
          return changedMac;
        },
      },
      strictDirectProbe: {
        probeDirect: async () => {
          events.push("probe:10.0.0.1");
          return { kind: "reachable", windows: changedWindows };
        },
      },
      profilePersistence: {
        persistProfileAtomically: async (candidate) => {
          events.push(`persist:${candidate.revision}`);
          persisted = candidate;
        },
      },
    });

    const result = await recovery.recover(profile);

    expect(result).toEqual({ profile: persisted!, resolution: "recovered" });
    expect(persisted).toMatchObject({
      revision: 5,
      mac: {
        hostAliases: ["studio-renamed.local"],
        ethernet: { serviceName: "Direct Cable" },
      },
      windows: {
        hostAliases: ["PLAY-PC"],
        ethernet: { interfaceAlias: "Hardline Ethernet" },
      },
    });
    expect(events).toEqual(["observe-mac", "probe:10.0.0.1", "persist:5"]);
  });

  test("Windows address drift is repaired only over the current Direct Link and strictly re-proved", async () => {
    let probes = 0;
    const missingAddress = {
      ...windowsObservation,
      selectedEthernet: { ...windowsObservation.selectedEthernet, addresses: [] },
    };
    const { events, recovery } = harness({
      strictDirectProbe: {
        probeDirect: async (candidate) => {
          probes += 1;
          events.push(`probe:${candidate.directLink.windowsAddress}`);
          return { kind: "reachable", windows: probes === 1 ? missingAddress : windowsObservation };
        },
      },
    });

    await expect(recovery.recover(profile)).resolves.toMatchObject({
      profile: { revision: 6 },
      resolution: "recovered",
    });
    expect(events).toEqual([
      "observe-mac",
      "probe:10.0.0.1",
      "persist:5",
      "add-windows:10.0.0.1",
      "probe:10.0.0.1",
      "persist:6",
    ]);
  });

  test("an active-use observation skips an otherwise free /30 during migration", async () => {
    const collidingMac: MacLinkObservation = {
      ...macObservation,
      occupiedCidrs: [
        { cidr: "10.0.0.0/30", source: "route", ownership: "other" },
      ],
    };
    const collidingWindows: WindowsLinkObservation = {
      ...windowsObservation,
      occupiedCidrs: [
        { cidr: "10.0.0.5/32", source: "active-use", ownership: "other" },
      ],
    };
    const migratedWindows: WindowsLinkObservation = {
      ...windowsObservation,
      selectedEthernet: {
        ...windowsObservation.selectedEthernet,
        addresses: ["10.0.0.1/30", "10.0.0.9/30"],
      },
      occupiedCidrs: collidingWindows.occupiedCidrs,
    };
    let persisted: TargetProfile | undefined;
    const { events, recovery } = harness({
      macObservation: {
        observeMacLink: async () => {
          events.push("observe-mac");
          return collidingMac;
        },
      },
      strictDirectProbe: {
        probeDirect: async (candidate) => {
          events.push(`probe:${candidate.directLink.windowsAddress}`);
          return {
            kind: "reachable",
            windows:
              candidate.directLink.windowsAddress === profile.directLink.windowsAddress
                ? collidingWindows
                : migratedWindows,
          };
        },
      },
      profilePersistence: {
        persistProfileAtomically: async (candidate) => {
          events.push(`persist:${candidate.revision}`);
          persisted = candidate;
        },
      },
    });

    const result = await recovery.recover(profile);

    expect(result).toEqual({ profile: persisted!, resolution: "recovered" });
    expect(persisted).toMatchObject({
      revision: 7,
      directLink: {
        subnet: "10.0.0.8/30",
        windowsAddress: "10.0.0.9",
        macAddress: "10.0.0.10",
      },
    });
    expect(events).toEqual([
      "observe-mac",
      "probe:10.0.0.1",
      "persist:5",
      "add-mac:10.0.0.10",
      "add-windows:10.0.0.9",
      "probe:10.0.0.9",
      "persist:6",
      "remove-windows:10.0.0.1",
      "remove-mac:10.0.0.2",
      "persist:7",
    ]);
  });

  test("a migration failure before profile persistence never removes old addresses", async () => {
    const collidingMac: MacLinkObservation = {
      ...macObservation,
      occupiedCidrs: [{ cidr: "10.0.0.0/30", source: "route", ownership: "other" }],
    };
    let probes = 0;
    const { events, recovery } = harness({
      macObservation: {
        observeMacLink: async () => {
          events.push("observe-mac");
          return collidingMac;
        },
      },
      strictDirectProbe: {
        probeDirect: async (candidate) => {
          probes += 1;
          events.push(`probe:${candidate.directLink.windowsAddress}`);
          return probes === 1
            ? { kind: "reachable", windows: windowsObservation }
            : { kind: "unavailable" };
        },
      },
      recoveryChannel: {
        observeRecovery: async () => {
          events.push("observe-recovery");
          return { kind: "pc-alive", windows: windowsObservation };
        },
      },
    });

    await expect(recovery.recover(profile)).rejects.toBeInstanceOf(DirectLinkUnavailableError);
    expect(events).toEqual([
      "observe-mac",
      "probe:10.0.0.1",
      "persist:5",
      "add-mac:10.0.0.6",
      "add-windows:10.0.0.5",
      "probe:10.0.0.5",
    ]);
  });

  test("an interrupted journaled migration resumes without reallocating its proposed addresses", async () => {
    const collidingMac: MacLinkObservation = {
      ...macObservation,
      occupiedCidrs: [{ cidr: "10.0.0.0/30", source: "route", ownership: "other" }],
    };
    let journaled: TargetProfile | undefined;
    const first = harness({
      macObservation: { observeMacLink: async () => collidingMac },
      directLinkAddressing: {
        addWindowsAddressOverDirectLink: async () => {
          throw new Error("interrupted after Mac mutation");
        },
        addWindowsAddressOverObservedPhysicalLink: async () => {},
        removeWindowsAddressOverDirectLink: async () => {},
      },
      profilePersistence: {
        persistProfileAtomically: async (candidate) => {
          journaled = candidate;
        },
      },
    });

    await expect(first.recovery.recover(profile)).rejects.toThrow("interrupted");
    expect(journaled).toMatchObject({
      revision: 5,
      directLink: profile.directLink,
      pendingMigration: {
        operation: "migration",
        oldLink: profile.directLink,
        proposedLink: {
          subnet: "10.0.0.4/30",
          windowsAddress: "10.0.0.5",
          macAddress: "10.0.0.6",
        },
      },
    });

    const migratedWindows: WindowsLinkObservation = {
      ...windowsObservation,
      selectedEthernet: {
        ...windowsObservation.selectedEthernet,
        addresses: ["10.0.0.1/30", "10.0.0.5/30"],
      },
      occupiedCidrs: [
        { cidr: "10.0.0.5/30", source: "address", ownership: "hardline" },
      ],
    };
    let proposedProbes = 0;
    const resumed = harness({
      macObservation: {
        observeMacLink: async () => ({
          ...collidingMac,
          selectedEthernet: {
            ...collidingMac.selectedEthernet,
            addresses: ["10.0.0.2/30", "10.0.0.6/30"],
          },
          occupiedCidrs: [
            ...collidingMac.occupiedCidrs,
            { cidr: "10.0.0.6/30", source: "address", ownership: "hardline" },
          ],
        }),
      },
      strictDirectProbe: {
        probeDirect: async (candidate) => {
          const isProposed = candidate.directLink.windowsAddress === "10.0.0.5";
          if (isProposed && proposedProbes++ === 0) return { kind: "unavailable" };
          return { kind: "reachable", windows: isProposed ? migratedWindows : windowsObservation };
        },
      },
    });

    const result = await resumed.recovery.recover(journaled!);
    expect(result.profile).toMatchObject({ revision: 7, directLink: journaled!.pendingMigration!.proposedLink });
    expect(result.profile).not.toHaveProperty("pendingMigration");
    expect(resumed.events).not.toContain("add-mac:10.0.0.6");
    expect(resumed.events).toContain("add-windows:10.0.0.5");
  });

  test.each(["windows", "mac"] as const)(
    "cleanup resumes after interrupted %s address removal",
    async (interruptedRemoval) => {
      const proposedLink = {
        subnet: "10.0.0.4/30",
        windowsAddress: "10.0.0.5",
        macAddress: "10.0.0.6",
      };
      const pendingProfile: TargetProfile = {
        ...profile,
        revision: 5,
        pendingMigration: { operation: "migration", oldLink: profile.directLink, proposedLink },
      };
      let macAddresses = ["10.0.0.2/30", "10.0.0.6/30"];
      let windowsAddresses = ["10.0.0.1/30", "10.0.0.5/30"];
      let injected = false;
      let persisted = pendingProfile;
      const persistedRevisions: number[] = [];
      const { recovery } = harness({
        macObservation: {
          observeMacLink: async () => ({
            ...macObservation,
            selectedEthernet: { ...macObservation.selectedEthernet, addresses: macAddresses },
          }),
        },
        strictDirectProbe: {
          probeDirect: async () => ({
            kind: "reachable",
            windows: {
              ...windowsObservation,
              selectedEthernet: {
                ...windowsObservation.selectedEthernet,
                addresses: windowsAddresses,
              },
            },
          }),
        },
        macAddressing: {
          addMacAddress: async () => {},
          removeMacAddress: async (_hardwareId, address) => {
            if (!macAddresses.some((candidate) => candidate.startsWith(`${address}/`))) {
              throw new Error("Mac address does not exist");
            }
            macAddresses = macAddresses.filter(
              (candidate) => !candidate.startsWith(`${address}/`),
            );
            if (interruptedRemoval === "mac" && !injected) {
              injected = true;
              throw new Error("interrupted after Mac removal");
            }
          },
        },
        directLinkAddressing: {
          addWindowsAddressOverDirectLink: async () => {},
          addWindowsAddressOverObservedPhysicalLink: async () => {},
          removeWindowsAddressOverDirectLink: async (_current, address) => {
            if (!windowsAddresses.some((candidate) => candidate.startsWith(`${address}/`))) {
              throw new Error("Windows address does not exist");
            }
            windowsAddresses = windowsAddresses.filter(
              (candidate) => !candidate.startsWith(`${address}/`),
            );
            if (interruptedRemoval === "windows" && !injected) {
              injected = true;
              throw new Error("interrupted after Windows removal");
            }
          },
        },
        profilePersistence: {
          persistProfileAtomically: async (candidate) => {
            persisted = candidate;
            persistedRevisions.push(candidate.revision);
          },
        },
      });

      await expect(recovery.recover(pendingProfile)).rejects.toThrow(
        `interrupted after ${interruptedRemoval === "mac" ? "Mac" : "Windows"} removal`,
      );
      expect(persisted).toHaveProperty("pendingMigration");

      const result = await recovery.recover(persisted);

      expect(result.profile).toMatchObject({ revision: 7, directLink: proposedLink });
      expect(result.profile).not.toHaveProperty("pendingMigration");
      expect(macAddresses).toEqual(["10.0.0.6/30"]);
      expect(windowsAddresses).toEqual(["10.0.0.5/30"]);
      expect(persistedRevisions).toEqual([6, 7]);
    },
  );

  test("current Hardline-owned subnet observations do not create a false collision", async () => {
    const { events, recovery } = harness({
      macObservation: {
        observeMacLink: async () => {
          events.push("observe-mac");
          return {
            ...macObservation,
            occupiedCidrs: [
              { cidr: "10.0.0.0/30", source: "route", ownership: "hardline" },
              { cidr: "10.0.0.2/30", source: "address", ownership: "hardline" },
            ],
          };
        },
      },
      strictDirectProbe: {
        probeDirect: async (candidate) => {
          events.push(`probe:${candidate.directLink.windowsAddress}`);
          return {
            kind: "reachable",
            windows: {
              ...windowsObservation,
              occupiedCidrs: [
                { cidr: "10.0.0.1/30", source: "address", ownership: "hardline" },
              ],
            },
          };
        },
      },
    });

    await expect(recovery.recover(profile)).resolves.toEqual({ profile, resolution: "validated" });
    expect(events).toEqual(["observe-mac", "probe:10.0.0.1"]);
  });
});
