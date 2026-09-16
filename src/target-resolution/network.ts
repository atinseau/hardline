export type NetworkTransport =
  | "ethernet"
  | "wifi"
  | "bluetooth"
  | "vpn"
  | "tunnel"
  | "bridge"
  | "loopback"
  | "other";

export type NetworkAdapterObservation = {
  stableId: string;
  alias: string;
  hardwareName: string;
  macAddress: string;
  speedMbps: number | null;
  physical: boolean;
  transport: NetworkTransport;
  virtual: boolean;
  linkState: "up" | "down";
  inUse: boolean;
  hasDefaultRoute: boolean;
  /** Adresses IPv4 portees par l'adaptateur, au format "adresse/prefixe". */
  ipv4Addresses: readonly string[];
};

export function canonicalEthernetHardwareId(macAddress: string): string {
  return `ether:${macAddress.toLowerCase().replaceAll("-", ":")}`;
}

export type Ipv4Interval = {
  kind: "parsed";
  cidr: string;
  firstAddress: string;
  lastAddress: string;
  prefixLength: number;
};

export type InvalidIpv4Cidr = {
  kind: "invalid";
  input: string;
  reason: "invalid-address" | "invalid-prefix";
};

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;

function ipv4Number(octets: readonly number[]): number {
  return octets[0]! * 2 ** 24 + octets[1]! * 2 ** 16 + octets[2]! * 2 ** 8 + octets[3]!;
}

function ipv4String(value: number): string {
  return [
    Math.floor(value / 2 ** 24),
    Math.floor(value / 2 ** 16) % 256,
    Math.floor(value / 2 ** 8) % 256,
    value % 256,
  ].join(".");
}

function parseInterval(input: string):
  | { kind: "parsed"; start: number; end: number; prefixLength: number }
  | InvalidIpv4Cidr {
  const match = IPV4_PATTERN.exec(input.trim());
  if (!match) return { kind: "invalid", input, reason: "invalid-address" };

  const octets = match.slice(1, 5).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return { kind: "invalid", input, reason: "invalid-address" };
  }

  const prefixLength = match[5] === undefined ? 32 : Number(match[5]);
  if (prefixLength > 32) return { kind: "invalid", input, reason: "invalid-prefix" };

  const size = 2 ** (32 - prefixLength);
  const start = Math.floor(ipv4Number(octets) / size) * size;
  return { kind: "parsed", start, end: start + size - 1, prefixLength };
}

export function parseIpv4Cidr(input: string): Ipv4Interval | InvalidIpv4Cidr {
  const parsed = parseInterval(input);
  if (parsed.kind === "invalid") return parsed;
  const firstAddress = ipv4String(parsed.start);
  return {
    kind: "parsed",
    cidr: `${firstAddress}/${parsed.prefixLength}`,
    firstAddress,
    lastAddress: ipv4String(parsed.end),
    prefixLength: parsed.prefixLength,
  };
}

export type MachineNetworkObservation = {
  routes: readonly string[];
  addresses: readonly string[];
  activeUse: readonly string[];
};

export type Private30Allocation =
  | {
      kind: "allocated";
      cidr: string;
      windowsAddress: string;
      macAddress: string;
    }
  | {
      kind: "invalid-observation";
      machine: "mac" | "windows";
      source: "route" | "address" | "active-use";
      value: string;
      reason: InvalidIpv4Cidr["reason"];
    }
  | { kind: "exhausted" };

type NumericInterval = { start: number; end: number };

const PRIVATE_RANGES: readonly NumericInterval[] = [
  { start: ipv4Number([10, 0, 0, 0]), end: ipv4Number([10, 255, 255, 255]) },
  { start: ipv4Number([172, 16, 0, 0]), end: ipv4Number([172, 31, 255, 255]) },
  { start: ipv4Number([192, 168, 0, 0]), end: ipv4Number([192, 168, 255, 255]) },
];

export function allocatePrivate30(observations: {
  mac: MachineNetworkObservation;
  windows: MachineNetworkObservation;
}): Private30Allocation {
  const occupied: NumericInterval[] = [];

  for (const machine of ["mac", "windows"] as const) {
    for (const source of ["route", "address", "active-use"] as const) {
      const values = source === "route"
        ? observations[machine].routes
        : source === "address"
          ? observations[machine].addresses
          : observations[machine].activeUse;
      for (const value of values) {
        const parsed = parseInterval(value);
        if (parsed.kind === "invalid") {
          return { kind: "invalid-observation", machine, source, value, reason: parsed.reason };
        }
        if (source === "active-use" && parsed.prefixLength !== 32) {
          return { kind: "invalid-observation", machine, source, value, reason: "invalid-prefix" };
        }
        // A default route says where unknown destinations go; it does not make
        // every destination locally occupied.
        if (source === "route" && parsed.prefixLength === 0) continue;
        occupied.push({ start: parsed.start, end: parsed.end });
      }
    }
  }

  occupied.sort((left, right) => left.start - right.start || left.end - right.end);

  for (const privateRange of PRIVATE_RANGES) {
    let candidate = privateRange.start;
    for (const interval of occupied) {
      if (interval.end < candidate) continue;
      if (interval.start > candidate + 3) break;
      candidate = Math.ceil((interval.end + 1) / 4) * 4;
      if (candidate + 3 > privateRange.end) break;
    }
    if (candidate + 3 <= privateRange.end) {
      return {
        kind: "allocated",
        cidr: `${ipv4String(candidate)}/30`,
        windowsAddress: ipv4String(candidate + 1),
        macAddress: ipv4String(candidate + 2),
      };
    }
  }

  return { kind: "exhausted" };
}

export type CandidateSelection =
  | { kind: "selected"; candidate: NetworkAdapterObservation }
  | { kind: "ambiguous"; candidates: NetworkAdapterObservation[] }
  | { kind: "not-found"; evidence: CandidateEvidence[] };

export type CandidateExclusion =
  | "nonphysical"
  | "non-ethernet"
  | "virtual"
  | "disconnected"
  | "in-use"
  | "default-route";

export type CandidateEvidence = NetworkAdapterObservation & {
  exclusions: CandidateExclusion[];
};

/**
 * Ce qu'exige un candidat. Les valeurs par defaut decrivent le lien direct :
 * un adaptateur Ethernet physique, branche, que personne n'utilise. Les
 * relacher sert au lien partage, ou l'adaptateur est justement celui qui porte
 * deja le reseau de la maison.
 */
export type CandidateRequirements = {
  readonly transports?: readonly NetworkTransport[];
  /** Faux accepte un adaptateur deja adresse ou portant la route par defaut. */
  readonly requireIdle?: boolean;
};

function candidateExclusions(
  adapter: NetworkAdapterObservation,
  requirements: CandidateRequirements,
): CandidateExclusion[] {
  const transports = requirements.transports ?? ["ethernet"];
  const requireIdle = requirements.requireIdle ?? true;
  const exclusions: CandidateExclusion[] = [];
  if (!adapter.physical) exclusions.push("nonphysical");
  if (!transports.includes(adapter.transport)) exclusions.push("non-ethernet");
  if (adapter.virtual) exclusions.push("virtual");
  if (adapter.linkState !== "up") exclusions.push("disconnected");
  if (requireIdle && adapter.inUse) exclusions.push("in-use");
  if (requireIdle && adapter.hasDefaultRoute) exclusions.push("default-route");
  return exclusions;
}

export function selectPhysicalEthernetCandidate(
  observations: readonly NetworkAdapterObservation[],
  requirements: CandidateRequirements = {},
): CandidateSelection {
  const evidence = observations.map((adapter) => ({
    ...adapter,
    exclusions: candidateExclusions(adapter, requirements),
  }));
  const candidates = evidence
    .filter(({ exclusions }) => exclusions.length === 0)
    .map(({ exclusions: _, ...adapter }) => adapter);

  if (candidates.length === 1) {
    return { kind: "selected", candidate: candidates[0]! };
  }
  if (candidates.length > 1) return { kind: "ambiguous", candidates };
  return { kind: "not-found", evidence };
}

/**
 * Un lien partage ne s'alloue pas, il se CONSTATE : les deux machines portent
 * deja, sur un adaptateur chacune, deux adresses du meme sous-reseau. Chaque
 * appariement trouve est une preuve qu'un chemin existe entre elles, sans
 * qu'aucune ligne de configuration n'ait ete ecrite nulle part.
 */
export type SharedLinkCandidate = {
  readonly mac: NetworkAdapterObservation;
  readonly windows: NetworkAdapterObservation;
  readonly subnet: string;
  readonly prefixLength: number;
  readonly macAddress: string;
  readonly windowsAddress: string;
};

function routableAddresses(
  adapter: NetworkAdapterObservation,
): { address: string; prefixLength: number; network: string }[] {
  if (!adapter.physical || adapter.virtual || adapter.linkState !== "up") return [];
  const routable = [];
  for (const entry of adapter.ipv4Addresses) {
    const parsed = parseIpv4Cidr(entry);
    if (parsed.kind === "invalid") continue;
    const address = entry.split("/")[0]!;
    // Une adresse d'auto-configuration ne prouve aucun reseau commun, et un
    // /31 ou /32 ne contient pas deux hotes.
    if (address.startsWith("169.254.") || address.startsWith("127.")) continue;
    if (parsed.prefixLength > 30 || parsed.prefixLength < 1) continue;
    routable.push({ address, prefixLength: parsed.prefixLength, network: parsed.cidr });
  }
  return routable;
}

export function sharedLinkCandidates(
  macAdapters: readonly NetworkAdapterObservation[],
  windowsAdapters: readonly NetworkAdapterObservation[],
): SharedLinkCandidate[] {
  const candidates: SharedLinkCandidate[] = [];
  for (const mac of macAdapters) {
    for (const macEntry of routableAddresses(mac)) {
      for (const windows of windowsAdapters) {
        for (const windowsEntry of routableAddresses(windows)) {
          if (
            macEntry.prefixLength !== windowsEntry.prefixLength ||
            macEntry.network !== windowsEntry.network ||
            macEntry.address === windowsEntry.address
          ) continue;
          candidates.push({
            mac,
            windows,
            subnet: macEntry.network,
            prefixLength: macEntry.prefixLength,
            macAddress: macEntry.address,
            windowsAddress: windowsEntry.address,
          });
        }
      }
    }
  }
  // A egalite de preuve, le cable passe devant la radio : c'est le lien que le
  // projet existe pour preferer.
  const wired = (candidate: SharedLinkCandidate) =>
    (candidate.mac.transport === "ethernet" ? 1 : 0) +
    (candidate.windows.transport === "ethernet" ? 1 : 0);
  return candidates.sort((left, right) => wired(right) - wired(left));
}
