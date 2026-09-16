import type { BootstrapWindowsObservations } from "../lib/bootstrap-server";
import type { MutationPlan } from "./bootstrap-protocol";
import {
  allocatePrivate30,
  canonicalEthernetHardwareId,
  selectPhysicalEthernetCandidate,
  sharedLinkCandidates,
  type CandidateSelection,
  type NetworkAdapterObservation,
  type SharedLinkCandidate,
} from "./network";
import type { DirectLink, LinkKind, TargetProfile } from "./types";

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

export class NoLinkFoundError extends Error {
  constructor(
    readonly macEvidence: readonly NetworkAdapterObservation[],
    readonly windowsEvidence: readonly NetworkAdapterObservation[],
  ) {
    super(
      "no path was found between the Mac and the PC: no free adapter to dedicate at both ends, and no network where both machines already hold an address. " +
        "Connect an Ethernet cable between them, or put both on the same network, then run 'hardline install' again.",
    );
    this.name = "NoLinkFoundError";
  }
}

/**
 * Ce que hardline ne peut pas deduire et doit demander.
 *
 * `adapter` : plusieurs adaptateurs libres au meme bout. Rien dans l'observation
 * ne dit lequel porte le cable qui va vers l'autre machine.
 *
 * `path` : plusieurs reseaux ou les deux machines se voient deja. Chacun est un
 * chemin reel ; le choix est un arbitrage, pas une deduction.
 */
export type LinkQuestion =
  | {
      readonly kind: "adapter";
      readonly machine: "mac" | "windows";
      readonly candidates: readonly NetworkAdapterObservation[];
    }
  | { readonly kind: "path"; readonly candidates: readonly SharedLinkCandidate[] };

/** Renvoie l'index du candidat retenu dans `question.candidates`. */
export type AskLink = (question: LinkQuestion) => number | Promise<number>;

/** Une reponse hors de la liste offerte n'est pas un choix : c'est un defaut. */
function pick<T>(candidates: readonly T[], index: number): T {
  const candidate = candidates[index];
  if (!candidate) {
    throw new Error("The answer does not designate one of the offered candidates.");
  }
  return candidate;
}

async function resolveSelection(
  machine: "mac" | "windows",
  selection: Exclude<CandidateSelection, { kind: "not-found" }>,
  ask: AskLink,
): Promise<NetworkAdapterObservation> {
  if (selection.kind === "selected") return selection.candidate;
  return pick(
    selection.candidates,
    await ask({ kind: "adapter", machine, candidates: selection.candidates }),
  );
}

export async function prepareBootstrapTarget(options: {
  readonly mac: MacBootstrapObservations;
  readonly windows: BootstrapWindowsObservations;
  readonly identity: BootstrapIdentity;
  readonly installationCatalogVersion: string;
  readonly ask: AskLink;
}): Promise<{ readonly profile: TargetProfile; readonly plan: MutationPlan }> {
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
      ipv4Addresses: adapter.ipv4Addresses,
    }),
  );
  const link = await selectLink(options.mac, options.windows, windowsAdapters, options.ask);
  const { macAdapter, windowsAdapter, directLink, linkKind } = link;
  const observedHostKey = options.windows.openSsh.hostKey;
  const hostKeyFields = observedHostKey?.publicKey.trim().split(/\s+/) ?? [];
  const hostPublicKey = hostKeyFields[0] === observedHostKey?.algorithm
    ? hostKeyFields[1]
    : hostKeyFields[0];
  const profile: TargetProfile = {
    version: 1,
    revision: 1,
    lifecycle: "bootstrap-incomplete",
    linkKind,
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
        wireless: windowsAdapter.transport === "wifi",
      },
    },
    directLink,
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
        address: linkKind === "shared" ? null : directLink.windowsAddress,
        prefixLength: directLink.prefixLength ?? 30,
        networkCategory: linkKind === "shared" ? null : "Private",
      },
      ssh: {
        installServer: options.windows.openSsh.capabilityState !== "Installed",
        startService:
          options.windows.openSsh.serviceStartType !== "Automatic" ||
          options.windows.openSsh.serviceStatus !== "Running",
        openFirewall: !options.windows.openSsh.firewallRulePresent,
        // Sur un lien partage, la regle de pare-feu ne peut pas s'appuyer sur
        // un profil Private que hardline n'a pas le droit d'imposer au reseau
        // de l'utilisateur. Elle vaut sur tous les profils, mais seulement pour
        // le sous-reseau du lien : sshd n'est pas expose ailleurs.
        firewallRemoteAddress: linkKind === "shared" ? directLink.subnet : null,
        administratorPublicKey: options.identity.publicKey,
      },
    },
  };
}

/**
 * Le cable d'abord, le reseau existant ensuite.
 *
 * Un adaptateur libre a chaque bout donne un lien que hardline possede
 * entierement : il l'adresse et le rend. C'est ce que le projet cherche, donc
 * ce qu'on essaie en premier. Faute de quoi on ne fabrique pas un lien, on en
 * CONSTATE un : un reseau ou les deux machines portent deja une adresse.
 */
async function selectLink(
  mac: MacBootstrapObservations,
  windows: BootstrapWindowsObservations,
  windowsAdapters: readonly NetworkAdapterObservation[],
  ask: AskLink,
): Promise<{
  readonly macAdapter: NetworkAdapterObservation;
  readonly windowsAdapter: NetworkAdapterObservation;
  readonly directLink: DirectLink;
  readonly linkKind: LinkKind;
}> {
  const macSelection = selectPhysicalEthernetCandidate(mac.adapters);
  const windowsSelection = selectPhysicalEthernetCandidate(windowsAdapters);
  if (macSelection.kind !== "not-found" && windowsSelection.kind !== "not-found") {
    const macAdapter = await resolveSelection("mac", macSelection, ask);
    const windowsAdapter = await resolveSelection("windows", windowsSelection, ask);
    const allocation = allocatePrivate30({
      mac: {
        routes: mac.routes,
        addresses: mac.addresses,
        activeUse: mac.activeIpv4Addresses,
      },
      windows: {
        routes: windows.routes.map((route) => route.destinationPrefix),
        addresses: windows.networkAdapters.flatMap((adapter) => [...adapter.ipv4Addresses]),
        activeUse: windows.activeIpv4Addresses,
      },
    });
    if (allocation.kind !== "allocated") throw new BootstrapSubnetAllocationError(allocation);
    return {
      macAdapter,
      windowsAdapter,
      linkKind: "direct",
      directLink: {
        subnet: allocation.cidr,
        macAddress: allocation.macAddress,
        windowsAddress: allocation.windowsAddress,
      },
    };
  }

  const paths = sharedLinkCandidates(mac.adapters, windowsAdapters);
  if (paths.length === 0) {
    throw new NoLinkFoundError(mac.adapters, windowsAdapters);
  }
  const path =
    paths.length === 1
      ? paths[0]!
      : pick(paths, await ask({ kind: "path", candidates: paths }));
  return {
    macAdapter: path.mac,
    windowsAdapter: path.windows,
    linkKind: "shared",
    directLink: {
      subnet: path.subnet,
      macAddress: path.macAddress,
      windowsAddress: path.windowsAddress,
      prefixLength: path.prefixLength,
    },
  };
}
