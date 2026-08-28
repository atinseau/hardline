import type { DirectLink, TargetProfile } from "./types";
import { allocatePrivate30, parseIpv4Cidr, type Private30Allocation } from "./network";

export type OccupiedCidrObservation = {
  readonly cidr: string;
  readonly source: "route" | "address" | "active-use";
  readonly ownership: "hardline" | "other";
};

export type MacEthernetObservation = {
  readonly hardwareId: string;
  readonly macAddress: string;
  readonly interfaceId: string;
  readonly serviceName: string;
  readonly addresses: readonly string[];
};

export type WindowsEthernetObservation = {
  readonly hardwareId: string;
  readonly macAddress: string;
  readonly interfaceAlias: string;
  readonly addresses: readonly string[];
};

export type MacLinkObservation = {
  readonly machineId: string;
  readonly hostAliases: readonly string[];
  readonly selectedEthernet: MacEthernetObservation;
  readonly occupiedCidrs: readonly OccupiedCidrObservation[];
};

export type WindowsLinkObservation = {
  readonly machineId: string;
  readonly hostAliases: readonly string[];
  readonly selectedEthernet: WindowsEthernetObservation;
  readonly occupiedCidrs: readonly OccupiedCidrObservation[];
};

export type RecoveryObservation =
  | {
      readonly kind: "pc-alive";
      readonly physicalPath?: {
        readonly macAddress: string;
        readonly windowsAddress: string;
      };
      readonly windows: WindowsLinkObservation;
    }
  | { readonly kind: "pc-inaccessible" };

export type RecoveryChannelObservation = {
  readonly observeRecovery: (profile: TargetProfile) => Promise<RecoveryObservation>;
};

export type LinkRecoveryAdapters = {
  readonly macObservation: {
    readonly observeMacLink: () => Promise<MacLinkObservation>;
  };
  readonly macAddressing: {
    readonly addMacAddress: (interfaceId: string, address: string, prefixLength: 30) => Promise<void>;
    readonly removeMacAddress: (interfaceId: string, address: string, prefixLength: 30) => Promise<void>;
  };
  readonly strictDirectProbe: {
    readonly probeDirect: (
      profile: TargetProfile,
    ) => Promise<
      | { readonly kind: "reachable"; readonly windows: WindowsLinkObservation }
      | { readonly kind: "unavailable" }
    >;
  };
  readonly directLinkAddressing: {
    readonly addWindowsAddressOverDirectLink: (
      currentProfile: TargetProfile,
      proposedProfile: TargetProfile,
    ) => Promise<void>;
    readonly addWindowsAddressOverObservedPhysicalLink: (
      currentProfile: TargetProfile,
      proposedProfile: TargetProfile,
      physicalPath: { readonly macAddress: string; readonly windowsAddress: string },
    ) => Promise<void>;
    readonly removeWindowsAddressOverDirectLink: (
      currentProfile: TargetProfile,
      address: string,
      prefixLength: 30,
    ) => Promise<void>;
  };
  readonly recoveryChannel: RecoveryChannelObservation;
  readonly profilePersistence: {
    readonly persistProfileAtomically: (profile: TargetProfile) => Promise<void>;
  };
};

export type LinkRecoveryResult = {
  readonly profile: TargetProfile;
  readonly resolution: "validated" | "recovered";
};

export class LinkIdentityMismatchError extends Error {
  constructor(
    readonly machine: "mac" | "windows",
    readonly identity: "machine-id" | "ethernet-hardware-id" | "ethernet-mac-address",
    readonly expected: string,
    readonly observed: string,
  ) {
    super(`The observed ${machine} ${identity} does not match the Target Profile.`);
    this.name = "LinkIdentityMismatchError";
  }
}

export class DirectLinkUnavailableError extends Error {
  constructor(
    readonly diagnosis: "pc-alive/direct-link-broken" | "pc-inaccessible",
  ) {
    super(
      diagnosis === "pc-alive/direct-link-broken"
        ? "The paired PC is alive, but the Direct Link is unavailable."
        : "The paired PC is inaccessible through both the Direct Link and Recovery Channel.",
    );
    this.name = "DirectLinkUnavailableError";
  }
}

export class LinkRecoveryAllocationError extends Error {
  constructor(readonly result: Exclude<Private30Allocation, { kind: "allocated" }>) {
    super(
      result.kind === "exhausted"
        ? "No collision-free private /30 is available for Link Recovery."
        : `Invalid ${result.machine} ${result.source} observation: ${result.value}.`,
    );
    this.name = "LinkRecoveryAllocationError";
  }
}

function normalizedMacAddress(value: string): string {
  return value.toLowerCase().replaceAll("-", ":");
}

function hasAddress(addresses: readonly string[], expected: string): boolean {
  return addresses.some((address) => address.split("/", 1)[0] === expected);
}

function hasDirectAddress(addresses: readonly string[], expected: string): boolean {
  return addresses.includes(`${expected}/30`);
}

function isIpv4Address(value: string): boolean {
  const parsed = parseIpv4Cidr(value);
  return parsed.kind === "parsed" && parsed.prefixLength === 32 && value === parsed.firstAddress;
}

function validateWindowsIdentity(profile: TargetProfile, windows: WindowsLinkObservation): void {
  const comparisons = [
    ["machine-id", profile.windows.machineId, windows.machineId],
    [
      "ethernet-hardware-id",
      profile.windows.ethernet.hardwareId,
      windows.selectedEthernet.hardwareId,
    ],
  ] as const;
  for (const [identity, expected, observed] of comparisons) {
    if (expected !== observed) {
      throw new LinkIdentityMismatchError("windows", identity, expected, observed);
    }
  }
  if (
    normalizedMacAddress(profile.windows.ethernet.macAddress) !==
    normalizedMacAddress(windows.selectedEthernet.macAddress)
  ) {
    throw new LinkIdentityMismatchError(
      "windows",
      "ethernet-mac-address",
      profile.windows.ethernet.macAddress,
      windows.selectedEthernet.macAddress,
    );
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}

function overlaps(left: string, right: string): boolean {
  const parsedLeft = parseIpv4Cidr(left);
  const parsedRight = parseIpv4Cidr(right);
  if (parsedLeft.kind === "invalid" || parsedRight.kind === "invalid") return true;
  return (
    ipv4Number(parsedLeft.firstAddress) <= ipv4Number(parsedRight.lastAddress) &&
    ipv4Number(parsedRight.firstAddress) <= ipv4Number(parsedLeft.lastAddress)
  );
}

function collisionInputs(
  profile: TargetProfile,
  mac: MacLinkObservation,
  windows: WindowsLinkObservation,
): {
  readonly collision: boolean;
  readonly observations: Parameters<typeof allocatePrivate30>[0];
} {
  const ownedLinks = [
    profile.directLink,
    ...(profile.pendingMigration
      ? [profile.pendingMigration.oldLink, profile.pendingMigration.proposedLink]
      : []),
  ];
  const included = (entry: OccupiedCidrObservation) => entry.ownership !== "hardline";
  const macOccupied = mac.occupiedCidrs.filter(included);
  const windowsOccupied = windows.occupiedCidrs.filter(included);
  const macAddresses = [
    ...macOccupied.filter(({ source }) => source === "address").map(({ cidr }) => cidr),
    ...mac.selectedEthernet.addresses.filter(
      (address) => !ownedLinks.some((link) => hasAddress([address], link.macAddress)),
    ),
  ];
  const windowsAddresses = [
    ...windowsOccupied.filter(({ source }) => source === "address").map(({ cidr }) => cidr),
    ...windows.selectedEthernet.addresses.filter(
      (address) => !ownedLinks.some((link) => hasAddress([address], link.windowsAddress)),
    ),
  ];
  const observations = {
    mac: {
      routes: macOccupied.filter(({ source }) => source === "route").map(({ cidr }) => cidr),
      addresses: macAddresses,
      activeUse: macOccupied
        .filter(({ source }) => source === "active-use")
        .map(({ cidr }) => cidr),
    },
    windows: {
      routes: windowsOccupied
        .filter(({ source }) => source === "route")
        .map(({ cidr }) => cidr),
      addresses: windowsAddresses,
      activeUse: windowsOccupied
        .filter(({ source }) => source === "active-use")
        .map(({ cidr }) => cidr),
    },
  };
  const allIncluded = [
    ...observations.mac.routes,
    ...observations.mac.addresses,
    ...observations.windows.routes,
    ...observations.windows.addresses,
    ...observations.mac.activeUse,
    ...observations.windows.activeUse,
  ];
  return {
    collision: allIncluded.some((cidr) => {
      const parsed = parseIpv4Cidr(cidr);
      return (
        (parsed.kind === "invalid" || parsed.prefixLength !== 0) &&
        overlaps(cidr, profile.directLink.subnet)
      );
    }),
    observations,
  };
}

export class LinkRecovery {
  constructor(private readonly adapters: LinkRecoveryAdapters) {}

  async recover(profile: TargetProfile): Promise<LinkRecoveryResult> {
    const mac = await this.adapters.macObservation.observeMacLink();
    if (mac.machineId !== profile.mac.machineId) {
      throw new LinkIdentityMismatchError(
        "mac",
        "machine-id",
        profile.mac.machineId,
        mac.machineId,
      );
    }
    if (mac.selectedEthernet.hardwareId !== profile.mac.ethernet.hardwareId) {
      throw new LinkIdentityMismatchError(
        "mac",
        "ethernet-hardware-id",
        profile.mac.ethernet.hardwareId,
        mac.selectedEthernet.hardwareId,
      );
    }
    if (
      normalizedMacAddress(mac.selectedEthernet.macAddress) !==
      normalizedMacAddress(profile.mac.ethernet.macAddress)
    ) {
      throw new LinkIdentityMismatchError(
        "mac",
        "ethernet-mac-address",
        profile.mac.ethernet.macAddress,
        mac.selectedEthernet.macAddress,
      );
    }
    const missingInitialMacAddress = !hasDirectAddress(
      mac.selectedEthernet.addresses,
      profile.directLink.macAddress,
    );
    const resumableInitialLink =
      profile.lifecycle === "installation-incomplete" &&
      profile.pendingMigration !== undefined &&
      profile.pendingMigration.operation === "initial-link" &&
      sameLink(profile.pendingMigration.oldLink, profile.directLink) &&
      sameLink(profile.pendingMigration.proposedLink, profile.directLink);
    if (
      profile.lifecycle === "installation-incomplete" &&
      ((!profile.pendingMigration && missingInitialMacAddress) || resumableInitialLink)
    ) {
      let journaled = profile;
      if (!profile.pendingMigration) {
        journaled = {
          ...profile,
          revision: profile.revision + 1,
          pendingMigration: {
            operation: "initial-link",
            oldLink: profile.directLink,
            proposedLink: profile.directLink,
          },
        };
        await this.adapters.profilePersistence.persistProfileAtomically(journaled);
      }
      return this.resumeInitialLink(journaled, mac);
    }
    const proposedLink = profile.pendingMigration?.proposedLink ?? profile.directLink;
    const proposedProfile = { ...profile, directLink: proposedLink };
    const candidates = sameLink(proposedLink, profile.directLink)
      ? [profile]
      : [proposedProfile, profile];
    let access:
      | { kind: "direct"; profile: TargetProfile; windows: WindowsLinkObservation }
      | {
          kind: "recovery";
          windows: WindowsLinkObservation;
          physicalPath?: { readonly macAddress: string; readonly windowsAddress: string };
        }
      | undefined;
    for (const candidate of candidates) {
      const direct = await this.adapters.strictDirectProbe.probeDirect(candidate);
      if (direct.kind === "reachable") {
        validateWindowsIdentity(profile, direct.windows);
        access = { kind: "direct", profile: candidate, windows: direct.windows };
        break;
      }
    }
    if (!access) {
      const recovery = await this.adapters.recoveryChannel.observeRecovery(profile);
      if (recovery.kind === "pc-inaccessible") {
        throw new DirectLinkUnavailableError("pc-inaccessible");
      }
      validateWindowsIdentity(profile, recovery.windows);
      const physicalPath =
        recovery.physicalPath &&
        isIpv4Address(recovery.physicalPath.macAddress) &&
        isIpv4Address(recovery.physicalPath.windowsAddress) &&
        recovery.physicalPath.macAddress !== recovery.physicalPath.windowsAddress
          ? recovery.physicalPath
          : undefined;
      access = {
        kind: "recovery",
        windows: recovery.windows,
        ...(physicalPath ? { physicalPath } : {}),
      };
    }

    if (profile.pendingMigration) {
      return this.resumeMigration(profile, mac, access);
    }

    const collision = collisionInputs(profile, mac, access.windows);
    let nextLink: DirectLink = profile.directLink;
    if (collision.collision) {
      const allocation = allocatePrivate30(collision.observations);
      if (allocation.kind !== "allocated") throw new LinkRecoveryAllocationError(allocation);
      nextLink = {
        subnet: allocation.cidr,
        macAddress: allocation.macAddress,
        windowsAddress: allocation.windowsAddress,
      };
    }
    const macHasProposedAddress = hasDirectAddress(
      mac.selectedEthernet.addresses,
      nextLink.macAddress,
    );
    const windowsHasProposedAddress = hasDirectAddress(
      access.windows.selectedEthernet.addresses,
      nextLink.windowsAddress,
    );
    const needsWindowsMutation =
      !windowsHasProposedAddress || (access.kind === "recovery" && macHasProposedAddress);
    const needsMutation =
      collision.collision ||
      !macHasProposedAddress ||
      needsWindowsMutation;
    if (needsMutation) {
      if (access.kind === "recovery" && needsWindowsMutation && !access.physicalPath) {
        throw new DirectLinkUnavailableError("pc-alive/direct-link-broken");
      }
      const journaled: TargetProfile = {
        ...profile,
        revision: profile.revision + 1,
        pendingMigration: {
          operation: "migration",
          oldLink: profile.directLink,
          proposedLink: nextLink,
        },
      };
      await this.adapters.profilePersistence.persistProfileAtomically(journaled);
      return this.resumeMigration(journaled, mac, access);
    }
    if (access.kind === "recovery") {
      throw new DirectLinkUnavailableError("pc-alive/direct-link-broken");
    }

    if (
      !sameStrings(mac.hostAliases, profile.mac.hostAliases) ||
      mac.selectedEthernet.interfaceId !== profile.mac.ethernet.interfaceId ||
      mac.selectedEthernet.serviceName !== profile.mac.ethernet.serviceName ||
      !sameStrings(access.windows.hostAliases, profile.windows.hostAliases) ||
      access.windows.selectedEthernet.interfaceAlias !== profile.windows.ethernet.interfaceAlias
    ) {
      const updated: TargetProfile = {
        ...profile,
        revision: profile.revision + 1,
        mac: {
          ...profile.mac,
          hostAliases: mac.hostAliases,
          ethernet: {
            ...profile.mac.ethernet,
            interfaceId: mac.selectedEthernet.interfaceId,
            serviceName: mac.selectedEthernet.serviceName,
          },
        },
        windows: {
          ...profile.windows,
          hostAliases: access.windows.hostAliases,
          ethernet: {
            ...profile.windows.ethernet,
            interfaceAlias: access.windows.selectedEthernet.interfaceAlias,
          },
        },
      };
      await this.adapters.profilePersistence.persistProfileAtomically(updated);
      return { profile: updated, resolution: "recovered" };
    }
    return { profile, resolution: "validated" };
  }

  private async resumeInitialLink(
    profile: TargetProfile,
    mac: MacLinkObservation,
  ): Promise<LinkRecoveryResult> {
    if (!hasDirectAddress(mac.selectedEthernet.addresses, profile.directLink.macAddress)) {
      await this.adapters.macAddressing.addMacAddress(
        mac.selectedEthernet.interfaceId,
        profile.directLink.macAddress,
        30,
      );
    }
    const proof = await this.adapters.strictDirectProbe.probeDirect(profile);
    if (proof.kind === "unavailable") {
      throw new DirectLinkUnavailableError("pc-alive/direct-link-broken");
    }
    validateWindowsIdentity(profile, proof.windows);
    if (!hasDirectAddress(proof.windows.selectedEthernet.addresses, profile.directLink.windowsAddress)) {
      throw new DirectLinkUnavailableError("pc-alive/direct-link-broken");
    }
    const { pendingMigration: _, ...withoutPending } = profile;
    const completed: TargetProfile = {
      ...withoutPending,
      revision: profile.revision + 1,
      mac: {
        ...profile.mac,
        hostAliases: mac.hostAliases,
        ethernet: {
          ...profile.mac.ethernet,
          interfaceId: mac.selectedEthernet.interfaceId,
          serviceName: mac.selectedEthernet.serviceName,
        },
      },
      windows: {
        ...profile.windows,
        hostAliases: proof.windows.hostAliases,
        ethernet: {
          ...profile.windows.ethernet,
          interfaceAlias: proof.windows.selectedEthernet.interfaceAlias,
        },
      },
    };
    await this.adapters.profilePersistence.persistProfileAtomically(completed);
    return { profile: completed, resolution: "recovered" };
  }

  private async resumeMigration(
    profile: TargetProfile,
    mac: MacLinkObservation,
    access:
      | { kind: "direct"; profile: TargetProfile; windows: WindowsLinkObservation }
      | {
          kind: "recovery";
          windows: WindowsLinkObservation;
          physicalPath?: { readonly macAddress: string; readonly windowsAddress: string };
        },
  ): Promise<LinkRecoveryResult> {
    const migration = profile.pendingMigration!;
    const proposed: TargetProfile = { ...profile, directLink: migration.proposedLink };
    if (!hasDirectAddress(mac.selectedEthernet.addresses, migration.proposedLink.macAddress)) {
      await this.adapters.macAddressing.addMacAddress(
        mac.selectedEthernet.interfaceId,
        migration.proposedLink.macAddress,
        30,
      );
    }
    const windowsNeedsMutation =
      !hasDirectAddress(access.windows.selectedEthernet.addresses, migration.proposedLink.windowsAddress) ||
      (access.kind === "recovery" &&
        hasDirectAddress(mac.selectedEthernet.addresses, migration.proposedLink.macAddress));
    if (windowsNeedsMutation) {
      if (access.kind === "direct") {
        await this.adapters.directLinkAddressing.addWindowsAddressOverDirectLink(
          access.profile,
          proposed,
        );
      } else if (access.physicalPath) {
        await this.adapters.directLinkAddressing.addWindowsAddressOverObservedPhysicalLink(
          profile,
          proposed,
          access.physicalPath,
        );
      } else {
        throw new DirectLinkUnavailableError("pc-alive/direct-link-broken");
      }
    }
    const proof = await this.adapters.strictDirectProbe.probeDirect(proposed);
    if (proof.kind === "unavailable") {
      throw new DirectLinkUnavailableError("pc-alive/direct-link-broken");
    }
    validateWindowsIdentity(profile, proof.windows);
    if (!hasDirectAddress(proof.windows.selectedEthernet.addresses, migration.proposedLink.windowsAddress)) {
      throw new DirectLinkUnavailableError("pc-alive/direct-link-broken");
    }

    let committed = profile;
    if (!sameLink(profile.directLink, migration.proposedLink)) {
      committed = {
        ...profile,
        revision: profile.revision + 1,
        directLink: migration.proposedLink,
        mac: {
          ...profile.mac,
          hostAliases: mac.hostAliases,
          ethernet: {
            ...profile.mac.ethernet,
            interfaceId: mac.selectedEthernet.interfaceId,
            serviceName: mac.selectedEthernet.serviceName,
          },
        },
        windows: {
          ...profile.windows,
          hostAliases: proof.windows.hostAliases,
          ethernet: {
            ...profile.windows.ethernet,
            interfaceAlias: proof.windows.selectedEthernet.interfaceAlias,
          },
        },
      };
      await this.adapters.profilePersistence.persistProfileAtomically(committed);
    }
    if (!sameLink(migration.oldLink, migration.proposedLink)) {
      if (hasAddress(proof.windows.selectedEthernet.addresses, migration.oldLink.windowsAddress)) {
        await this.adapters.directLinkAddressing.removeWindowsAddressOverDirectLink(
          committed,
          migration.oldLink.windowsAddress,
          30,
        );
      }
      if (hasAddress(mac.selectedEthernet.addresses, migration.oldLink.macAddress)) {
        await this.adapters.macAddressing.removeMacAddress(
          mac.selectedEthernet.interfaceId,
          migration.oldLink.macAddress,
          30,
        );
      }
    }
    const { pendingMigration: _, ...withoutPending } = committed;
    const completed: TargetProfile = {
      ...withoutPending,
      revision: committed.revision + 1,
      mac: {
        ...committed.mac,
        hostAliases: mac.hostAliases,
        ethernet: {
          ...committed.mac.ethernet,
          interfaceId: mac.selectedEthernet.interfaceId,
          serviceName: mac.selectedEthernet.serviceName,
        },
      },
      windows: {
        ...committed.windows,
        hostAliases: proof.windows.hostAliases,
        ethernet: {
          ...committed.windows.ethernet,
          interfaceAlias: proof.windows.selectedEthernet.interfaceAlias,
        },
      },
    };
    await this.adapters.profilePersistence.persistProfileAtomically(completed);
    return { profile: completed, resolution: "recovered" };
  }
}

function sameLink(left: DirectLink, right: DirectLink): boolean {
  return (
    left.subnet === right.subnet &&
    left.macAddress === right.macAddress &&
    left.windowsAddress === right.windowsAddress
  );
}
