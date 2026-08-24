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

function candidateExclusions(adapter: NetworkAdapterObservation): CandidateExclusion[] {
  const exclusions: CandidateExclusion[] = [];
  if (!adapter.physical) exclusions.push("nonphysical");
  if (adapter.transport !== "ethernet") exclusions.push("non-ethernet");
  if (adapter.virtual) exclusions.push("virtual");
  if (adapter.linkState !== "up") exclusions.push("disconnected");
  if (adapter.inUse) exclusions.push("in-use");
  if (adapter.hasDefaultRoute) exclusions.push("default-route");
  return exclusions;
}

export function selectPhysicalEthernetCandidate(
  observations: readonly NetworkAdapterObservation[],
): CandidateSelection {
  const evidence = observations.map((adapter) => ({
    ...adapter,
    exclusions: candidateExclusions(adapter),
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
