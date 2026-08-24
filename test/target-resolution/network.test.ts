import { describe, expect, test } from "bun:test";
import {
  allocatePrivate30,
  parseIpv4Cidr,
  selectPhysicalEthernetCandidate,
  type NetworkAdapterObservation,
} from "../../src/target-resolution/network";

const ethernet = (
  overrides: Partial<NetworkAdapterObservation> = {},
): NetworkAdapterObservation => ({
  stableId: "mac-en7",
  alias: "USB 10/100/1000 LAN",
  hardwareName: "Realtek USB GbE Family Controller",
  macAddress: "02:11:22:33:44:55",
  speedMbps: 1_000,
  physical: true,
  transport: "ethernet",
  virtual: false,
  linkState: "up",
  inUse: false,
  hasDefaultRoute: false,
  ...overrides,
});

describe("IPv4/CIDR parsing", () => {
  test("normalizes a CIDR host address into its closed network interval", () => {
    expect(parseIpv4Cidr("10.23.45.67/24")).toEqual({
      kind: "parsed",
      cidr: "10.23.45.0/24",
      firstAddress: "10.23.45.0",
      lastAddress: "10.23.45.255",
      prefixLength: 24,
    });
    expect(parseIpv4Cidr("192.168.4.9")).toEqual({
      kind: "parsed",
      cidr: "192.168.4.9/32",
      firstAddress: "192.168.4.9",
      lastAddress: "192.168.4.9",
      prefixLength: 32,
    });
  });

  test("returns typed failures for malformed addresses and prefixes", () => {
    expect(parseIpv4Cidr("10.0.256.1/24")).toEqual({
      kind: "invalid",
      input: "10.0.256.1/24",
      reason: "invalid-address",
    });
    expect(parseIpv4Cidr("10.0.0.1/33")).toEqual({
      kind: "invalid",
      input: "10.0.0.1/33",
      reason: "invalid-prefix",
    });
  });
});

describe("private /30 allocation", () => {
  test("does not treat a default route as occupation of the entire address space", () => {
    expect(
      allocatePrivate30({
        mac: { routes: ["0.0.0.0/0"], addresses: [], activeUse: [] },
        windows: { routes: ["0.0.0.0/0"], addresses: [], activeUse: [] },
      }),
    ).toMatchObject({ kind: "allocated", cidr: "10.0.0.0/30" });
  });

  test("skips overlapping routes and assigned address networks on both machines", () => {
    expect(
      allocatePrivate30({
        mac: {
          routes: ["10.0.0.0/30"],
          addresses: ["10.0.0.5/30"],
          activeUse: [],
        },
        windows: {
          routes: ["10.0.0.8/30"],
          addresses: ["10.0.0.13/30"],
          activeUse: [],
        },
      }),
    ).toEqual({
      kind: "allocated",
      cidr: "10.0.0.16/30",
      windowsAddress: "10.0.0.17",
      macAddress: "10.0.0.18",
    });
  });

  test("jumps whole occupied private ranges in deterministic RFC1918 order", () => {
    expect(
      allocatePrivate30({
        mac: { routes: ["10.0.0.0/8"], addresses: [], activeUse: [] },
        windows: { routes: [], addresses: [], activeUse: [] },
      }),
    ).toEqual({
      kind: "allocated",
      cidr: "172.16.0.0/30",
      windowsAddress: "172.16.0.1",
      macAddress: "172.16.0.2",
    });
  });

  test("treats a bare assigned host address as a collision", () => {
    expect(
      allocatePrivate30({
        mac: { routes: [], addresses: [], activeUse: [] },
        windows: { routes: [], addresses: ["10.0.0.2"], activeUse: [] },
      }),
    ).toEqual({
      kind: "allocated",
      cidr: "10.0.0.4/30",
      windowsAddress: "10.0.0.5",
      macAddress: "10.0.0.6",
    });
  });

  test("returns typed exhaustion when every RFC1918 range is occupied", () => {
    expect(
      allocatePrivate30({
        mac: {
          routes: ["192.168.0.0/16", "10.0.0.0/8"],
          addresses: [],
          activeUse: [],
        },
        windows: { routes: ["172.16.0.0/12"], addresses: [], activeUse: [] },
      }),
    ).toEqual({ kind: "exhausted" });
  });

  test("identifies the machine and source of an invalid observation", () => {
    expect(
      allocatePrivate30({
        mac: { routes: [], addresses: [], activeUse: [] },
        windows: { routes: [], addresses: ["192.168.1.300/24"], activeUse: [] },
      }),
    ).toEqual({
      kind: "invalid-observation",
      machine: "windows",
      source: "address",
      value: "192.168.1.300/24",
      reason: "invalid-address",
    });
  });
});

describe("physical Ethernet candidate selection", () => {
  test("automatically selects the only free physical Ethernet adapter", () => {
    const candidate = ethernet();

    expect(selectPhysicalEthernetCandidate([candidate])).toEqual({
      kind: "selected",
      candidate,
    });
  });

  test("excludes every unsafe or occupied adapter class with display evidence", () => {
    const observations = [
      ethernet({ stableId: "nonphysical", physical: false }),
      ethernet({ stableId: "non-ethernet", transport: "other" }),
      ethernet({ stableId: "virtual", virtual: true }),
      ethernet({ stableId: "wifi", transport: "wifi" }),
      ethernet({ stableId: "bluetooth", transport: "bluetooth" }),
      ethernet({ stableId: "vpn", transport: "vpn" }),
      ethernet({ stableId: "tunnel", transport: "tunnel" }),
      ethernet({ stableId: "bridge", transport: "bridge" }),
      ethernet({ stableId: "loopback", transport: "loopback" }),
      ethernet({ stableId: "disconnected", linkState: "down" }),
      ethernet({ stableId: "occupied", inUse: true }),
      ethernet({ stableId: "default-route", hasDefaultRoute: true }),
    ];

    const result = selectPhysicalEthernetCandidate(observations);
    expect(result.kind).toBe("not-found");
    if (result.kind !== "not-found") throw new Error("expected not-found");
    expect(result.evidence.map(({ stableId, exclusions }) => ({ stableId, exclusions }))).toEqual([
      { stableId: "nonphysical", exclusions: ["nonphysical"] },
      { stableId: "non-ethernet", exclusions: ["non-ethernet"] },
      { stableId: "virtual", exclusions: ["virtual"] },
      { stableId: "wifi", exclusions: ["non-ethernet"] },
      { stableId: "bluetooth", exclusions: ["non-ethernet"] },
      { stableId: "vpn", exclusions: ["non-ethernet"] },
      { stableId: "tunnel", exclusions: ["non-ethernet"] },
      { stableId: "bridge", exclusions: ["non-ethernet"] },
      { stableId: "loopback", exclusions: ["non-ethernet"] },
      { stableId: "disconnected", exclusions: ["disconnected"] },
      { stableId: "occupied", exclusions: ["in-use"] },
      { stableId: "default-route", exclusions: ["default-route"] },
    ]);
  });

  test("returns typed ambiguity with hardware facts instead of guessing", () => {
    const mac = ethernet();
    const windows = ethernet({
      stableId: "windows-pci-3",
      alias: "Ethernet 4",
      hardwareName: "Intel I225-V",
      macAddress: "0a:bb:cc:dd:ee:ff",
      speedMbps: 2_500,
    });

    expect(selectPhysicalEthernetCandidate([mac, windows])).toEqual({
      kind: "ambiguous",
      candidates: [mac, windows],
    });
  });
});
