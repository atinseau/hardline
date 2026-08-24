import type { BootstrapWindowsObservations } from "../lib/bootstrap-server";
import type { MutationPlan } from "./bootstrap-protocol";
import {
  allocatePrivate30,
  canonicalEthernetHardwareId,
  selectPhysicalEthernetCandidate,
  type CandidateSelection,
  type NetworkAdapterObservation,
} from "./network";
import type { TargetProfile } from "./types";

export type MacBootstrapObservations = {
  readonly machineId: string;
  readonly hostAliases: readonly string[];
  readonly adapters: readonly NetworkAdapterObservation[];
  readonly routes: readonly string[];
  readonly addresses: readonly string[];
  readonly activeIpv4Addresses: readonly string[];
};

export type BootstrapIdentity = {
  readonly privateKeyPath: string;
  readonly publicKeyPath: string;
  readonly publicKey: string;
};

export class BootstrapTargetSelectionError extends Error {
  constructor(
    readonly machine: "mac" | "windows",
    readonly result: Exclude<CandidateSelection, { kind: "selected" }>,
  ) {
    super(
      result.kind === "ambiguous"
        ? `Multiple free physical Ethernet adapters were found on ${machine}.`
        : `No free physical Ethernet adapter was found on ${machine}.`,
    );
    this.name = "BootstrapTargetSelectionError";
  }
}

export class BootstrapSubnetAllocationError extends Error {
  constructor(readonly result: Exclude<ReturnType<typeof allocatePrivate30>, { kind: "allocated" }>) {
    super(
      result.kind === "exhausted"
        ? "No collision-free private /30 is available."
        : `Invalid ${result.machine} ${result.source} observation: ${result.value}.`,
    );
    this.name = "BootstrapSubnetAllocationError";
  }
}

export function prepareBootstrapTarget(options: {
  readonly mac: MacBootstrapObservations;
  readonly windows: BootstrapWindowsObservations;
  readonly identity: BootstrapIdentity;
  readonly installationCatalogVersion: string;
  readonly selectedMacInterfaceId?: string;
  readonly selectedWindowsHardwareId?: string;
}): { readonly profile: TargetProfile; readonly plan: MutationPlan } {
  let macSelection = selectPhysicalEthernetCandidate(options.mac.adapters);
  if (macSelection.kind === "ambiguous" && options.selectedMacInterfaceId) {
    const candidate = macSelection.candidates.find(
      ({ stableId }) => stableId === options.selectedMacInterfaceId,
    );
    if (candidate) macSelection = { kind: "selected", candidate };
  }
  if (macSelection.kind !== "selected") {
    throw new BootstrapTargetSelectionError("mac", macSelection);
  }

  const defaultRouteInterfaces = new Set(
    options.windows.routes
      .filter((route) => route.destinationPrefix === "0.0.0.0/0")
      .map((route) => route.interfaceIndex),
  );
  const windowsAdapters: NetworkAdapterObservation[] = options.windows.networkAdapters.map(
    (adapter) => ({
      stableId: adapter.hardwareId,
      alias: adapter.alias,
      hardwareName: adapter.hardwareName,
      macAddress: adapter.macAddress,
      speedMbps: adapter.speedMbps,
      physical: adapter.physical,
      transport: adapter.transport,
      virtual: adapter.virtual,
      linkState: adapter.linkState,
      inUse: adapter.ipv4Addresses.some(
        (address) => !address.startsWith("169.254.") && !address.startsWith("0.0.0.0"),
      ),
      hasDefaultRoute: defaultRouteInterfaces.has(adapter.interfaceIndex),
    }),
  );
  let windowsSelection = selectPhysicalEthernetCandidate(windowsAdapters);
  if (windowsSelection.kind === "ambiguous" && options.selectedWindowsHardwareId) {
    const candidate = windowsSelection.candidates.find(
      ({ stableId }) => stableId === options.selectedWindowsHardwareId,
    );
    if (candidate) windowsSelection = { kind: "selected", candidate };
  }
  if (windowsSelection.kind !== "selected") {
    throw new BootstrapTargetSelectionError("windows", windowsSelection);
  }

  const allocation = allocatePrivate30({
    mac: {
      routes: options.mac.routes,
      addresses: options.mac.addresses,
      activeUse: options.mac.activeIpv4Addresses,
    },
    windows: {
      routes: options.windows.routes.map((route) => route.destinationPrefix),
      addresses: options.windows.networkAdapters.flatMap((adapter) => adapter.ipv4Addresses),
      activeUse: options.windows.activeIpv4Addresses,
    },
  });
  if (allocation.kind !== "allocated") throw new BootstrapSubnetAllocationError(allocation);

  const macAdapter = macSelection.candidate;
  const windowsAdapter = windowsSelection.candidate;
  const observedHostKey = options.windows.openSsh.hostKey;
  const hostKeyFields = observedHostKey?.publicKey.trim().split(/\s+/) ?? [];
  const hostPublicKey = hostKeyFields[0] === observedHostKey?.algorithm
    ? hostKeyFields[1]
    : hostKeyFields[0];
  const profile: TargetProfile = {
    version: 1,
    revision: 1,
    lifecycle: "bootstrap-incomplete",
    mac: {
      machineId: options.mac.machineId,
      hostAliases: options.mac.hostAliases,
      ethernet: {
        hardwareId: canonicalEthernetHardwareId(macAdapter.macAddress),
        macAddress: macAdapter.macAddress,
        interfaceId: macAdapter.stableId,
        serviceName: macAdapter.alias,
      },
    },
    windows: {
      machineId: options.windows.machineId,
      hostAliases: [options.windows.computerName].filter(Boolean),
      administrator: options.windows.administrator,
      smbUser: options.windows.administrator,
      ethernet: {
        hardwareId: windowsAdapter.stableId,
        macAddress: windowsAdapter.macAddress,
        interfaceAlias: windowsAdapter.alias,
      },
    },
    directLink: {
      subnet: allocation.cidr,
      macAddress: allocation.macAddress,
      windowsAddress: allocation.windowsAddress,
    },
    hardlineIdentity: {
      privateKeyPath: options.identity.privateKeyPath,
      publicKeyPath: options.identity.publicKeyPath,
    },
    sshHostKey: observedHostKey && hostPublicKey
      ? { algorithm: observedHostKey.algorithm, publicKey: hostPublicKey }
      : null,
    installationCatalogVersion: options.installationCatalogVersion,
  };

  return {
    profile,
    plan: {
      directLink: {
        interfaceAlias: windowsAdapter.alias,
        address: allocation.windowsAddress,
        prefixLength: 30,
        networkCategory: "Private",
      },
      ssh: {
        installServer: options.windows.openSsh.capabilityState !== "Installed",
        startService:
          options.windows.openSsh.serviceStartType !== "Automatic" ||
          options.windows.openSsh.serviceStatus !== "Running",
        openFirewall: !options.windows.openSsh.firewallRulePresent,
        administratorPublicKey: options.identity.publicKey,
      },
    },
  };
}
