import { expect, test } from "bun:test";
import {
  MacArpObservationError,
  MacMachineIdentityUnavailableError,
  MacObservationCommandError,
  observeMacBootstrap,
  parseIOPlatformUUID,
  parseMacIfconfig,
  parseMacArp,
  parseMacNetworkServices,
  parseMacRoutes,
  type MacObservationCommandRunner,
} from "../../src/target-resolution/mac-observations";

const IOREG = `+-o MacBookPro18,2  <class IOPlatformExpertDevice, id 0x100000123, registered, matched, active, busy 0 (429 ms), retain 43>
    {
      "IOPlatformUUID" = "A1B2C3D4-E5F6-47A8-90AB-CDEF12345678"
      "IOPlatformSerialNumber" = "C02EXAMPLE"
    }
`;

const NETWORK_SERVICE_ORDER = `An asterisk (*) denotes that a network service is disabled.
(1) Wi-Fi
(Hardware Port: Wi-Fi, Device: en0)
(2) Dock LAN
(Hardware Port: USB 10/100/1000 LAN, Device: en8)
(3) *Bluetooth PAN
(Hardware Port: Bluetooth PAN, Device: en7)
(4) Thunderbolt Bridge
(Hardware Port: Thunderbolt Bridge, Device: bridge0)
`;

const IFCONFIG = `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tether aa:bb:cc:dd:ee:01
\tinet 192.168.50.14 netmask 0xffffff00 broadcast 192.168.50.255
\tmedia: autoselect
\tstatus: active
en8: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\toptions=404<VLAN_MTU,CHANNEL_IO>
\tether AA:BB:CC:DD:EE:08
\tinet 169.254.44.2 netmask 0xffff0000 broadcast 169.254.255.255
\tmedia: autoselect (1000baseT <full-duplex,flow-control>)
\tstatus: active
en7: flags=8822<BROADCAST,SMART,SIMPLEX,MULTICAST> mtu 1500
\tether aa:bb:cc:dd:ee:07
\tmedia: autoselect
\tstatus: inactive
bridge0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tether aa:bb:cc:dd:ee:09
\tinet 172.20.10.1 netmask 0xffffff00 broadcast 172.20.10.255
\tstatus: active
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1380
\tinet 10.8.0.2 --> 10.8.0.2 netmask 0xffffffff
`;

const NETSTAT = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            192.168.50.1       UGScg                 en0
10.8.0.2           10.8.0.2           UH                  utun4
127                127.0.0.1          UCS                   lo0
127.0.0.1          127.0.0.1          UH                    lo0
169.254            link#19            UCS                   en8      !
192.168.50         link#15            UCS                   en0      !
192.168.50.14/32   link#15            UCS                   en0      !
224.0.0/4          link#15            UmCS                  en0      !
`;

const ARP = `? (192.168.50.1) at a:bb:cc:dd:ee:1 on en0 ifscope [ethernet]
? (10.0.0.1) at 2:0:0:0:0:1 on en8 ifscope [ethernet]
? (10.0.0.5) at (incomplete) on en8 ifscope [ethernet]
`;

test("parses the stable IOPlatformUUID from literal ioreg output", () => {
  expect(parseIOPlatformUUID(IOREG)).toBe("A1B2C3D4-E5F6-47A8-90AB-CDEF12345678");
});

test("parses service aliases separately from hardware ports and devices", () => {
  expect(parseMacNetworkServices(NETWORK_SERVICE_ORDER)).toEqual([
    { alias: "Wi-Fi", hardwareName: "Wi-Fi", interfaceId: "en0", enabled: true },
    {
      alias: "Dock LAN",
      hardwareName: "USB 10/100/1000 LAN",
      interfaceId: "en8",
      enabled: true,
    },
    {
      alias: "Bluetooth PAN",
      hardwareName: "Bluetooth PAN",
      interfaceId: "en7",
      enabled: false,
    },
    {
      alias: "Thunderbolt Bridge",
      hardwareName: "Thunderbolt Bridge",
      interfaceId: "bridge0",
      enabled: true,
    },
  ]);
});

test("parses every IPv4 address and observable interface evidence from ifconfig", () => {
  expect(parseMacIfconfig(IFCONFIG)).toEqual([
    {
      interfaceId: "lo0",
      flags: ["UP", "LOOPBACK", "RUNNING", "MULTICAST"],
      macAddress: null,
      addresses: ["127.0.0.1/8"],
      linkState: "up",
      speedMbps: null,
    },
    {
      interfaceId: "en0",
      flags: ["UP", "BROADCAST", "SMART", "RUNNING", "SIMPLEX", "MULTICAST"],
      macAddress: "aa:bb:cc:dd:ee:01",
      addresses: ["192.168.50.14/24"],
      linkState: "up",
      speedMbps: null,
    },
    {
      interfaceId: "en8",
      flags: ["UP", "BROADCAST", "SMART", "RUNNING", "SIMPLEX", "MULTICAST"],
      macAddress: "aa:bb:cc:dd:ee:08",
      addresses: ["169.254.44.2/16"],
      linkState: "up",
      speedMbps: 1000,
    },
    {
      interfaceId: "en7",
      flags: ["BROADCAST", "SMART", "SIMPLEX", "MULTICAST"],
      macAddress: "aa:bb:cc:dd:ee:07",
      addresses: [],
      linkState: "down",
      speedMbps: null,
    },
    {
      interfaceId: "bridge0",
      flags: ["UP", "BROADCAST", "SMART", "RUNNING", "SIMPLEX", "MULTICAST"],
      macAddress: "aa:bb:cc:dd:ee:09",
      addresses: ["172.20.10.1/24"],
      linkState: "up",
      speedMbps: null,
    },
    {
      interfaceId: "utun4",
      flags: ["UP", "POINTOPOINT", "RUNNING", "MULTICAST"],
      macAddress: null,
      addresses: ["10.8.0.2/32"],
      linkState: "up",
      speedMbps: null,
    },
  ]);
});

test("normalizes every IPv4 route while retaining its interface", () => {
  expect(parseMacRoutes(NETSTAT)).toEqual([
    { cidr: "0.0.0.0/0", interfaceId: "en0", connected: false },
    { cidr: "10.8.0.2/32", interfaceId: "utun4", connected: false },
    { cidr: "127.0.0.0/8", interfaceId: "lo0", connected: false },
    { cidr: "127.0.0.1/32", interfaceId: "lo0", connected: false },
    { cidr: "169.254.0.0/16", interfaceId: "en8", connected: true },
    { cidr: "192.168.50.0/24", interfaceId: "en0", connected: true },
    { cidr: "192.168.50.14/32", interfaceId: "en0", connected: true },
    { cidr: "224.0.0.0/4", interfaceId: "en0", connected: true },
  ]);
});

test("parses active ARP entries as occupied hosts and ignores incomplete entries", () => {
  expect(parseMacArp(ARP)).toEqual(["192.168.50.1/32", "10.0.0.1/32"]);
});

test("fails safe on malformed ARP output", () => {
  expect(() => parseMacArp("? (10.0.0.999) at aa:bb:cc:dd:ee:ff on en8\n"))
    .toThrow(MacArpObservationError);
  expect(() => parseMacArp("? malformed neighbor output\n"))
    .toThrow(MacArpObservationError);
});

test("observes phase-one Mac facts using only fixed argv and normalized adapter evidence", async () => {
  const calls: string[][] = [];
  const outputs = new Map<string, string>([
    ["ioreg\0-rd1\0-c\0IOPlatformExpertDevice", IOREG],
    ["hostname", "studio.local\n"],
    ["networksetup\0-listnetworkserviceorder", NETWORK_SERVICE_ORDER],
    ["ifconfig\0-a", IFCONFIG],
    ["netstat\0-rn\0-f\0inet", NETSTAT],
    ["arp\0-an", ARP],
  ]);
  const runner: MacObservationCommandRunner = async (argv) => {
    calls.push([...argv]);
    return { exitCode: 0, stdout: outputs.get(argv.join("\0")) ?? "", stderr: "" };
  };

  const observation = await observeMacBootstrap({ runner });

  expect(calls).toEqual([
    ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
    ["hostname"],
    ["networksetup", "-listnetworkserviceorder"],
    ["ifconfig", "-a"],
    ["netstat", "-rn", "-f", "inet"],
    ["arp", "-an"],
  ]);
  expect(observation).toEqual({
    machineId: "A1B2C3D4-E5F6-47A8-90AB-CDEF12345678",
    hostAliases: ["studio.local"],
    adapters: [
      {
        stableId: "lo0",
        alias: "lo0",
        hardwareName: "lo0",
        macAddress: "",
        speedMbps: null,
        physical: false,
        transport: "loopback",
        virtual: true,
        linkState: "up",
        inUse: true,
        hasDefaultRoute: false,
      },
      {
        stableId: "en0",
        alias: "Wi-Fi",
        hardwareName: "Wi-Fi",
        macAddress: "aa:bb:cc:dd:ee:01",
        speedMbps: null,
        physical: true,
        transport: "wifi",
        virtual: false,
        linkState: "up",
        inUse: true,
        hasDefaultRoute: true,
      },
      {
        stableId: "en8",
        alias: "Dock LAN",
        hardwareName: "USB 10/100/1000 LAN",
        macAddress: "aa:bb:cc:dd:ee:08",
        speedMbps: 1000,
        physical: true,
        transport: "ethernet",
        virtual: false,
        linkState: "up",
        inUse: false,
        hasDefaultRoute: false,
      },
      {
        stableId: "en7",
        alias: "Bluetooth PAN",
        hardwareName: "Bluetooth PAN",
        macAddress: "aa:bb:cc:dd:ee:07",
        speedMbps: null,
        physical: true,
        transport: "bluetooth",
        virtual: false,
        linkState: "down",
        inUse: false,
        hasDefaultRoute: false,
      },
      {
        stableId: "bridge0",
        alias: "Thunderbolt Bridge",
        hardwareName: "Thunderbolt Bridge",
        macAddress: "aa:bb:cc:dd:ee:09",
        speedMbps: null,
        physical: false,
        transport: "bridge",
        virtual: true,
        linkState: "up",
        inUse: true,
        hasDefaultRoute: false,
      },
      {
        stableId: "utun4",
        alias: "utun4",
        hardwareName: "utun4",
        macAddress: "",
        speedMbps: null,
        physical: false,
        transport: "tunnel",
        virtual: true,
        linkState: "up",
        inUse: true,
        hasDefaultRoute: false,
      },
    ],
    routes: [
      "0.0.0.0/0",
      "10.8.0.2/32",
      "127.0.0.0/8",
      "127.0.0.1/32",
      "169.254.0.0/16",
      "192.168.50.0/24",
      "192.168.50.14/32",
      "224.0.0.0/4",
    ],
    addresses: [
      "127.0.0.1/8",
      "192.168.50.14/24",
      "169.254.44.2/16",
      "172.20.10.1/24",
      "10.8.0.2/32",
    ],
    activeIpv4Addresses: ["192.168.50.1/32", "10.0.0.1/32"],
  });
});

test("fails typed when any observation command exits unsuccessfully", async () => {
  const runner: MacObservationCommandRunner = async (argv) => ({
    exitCode: argv[0] === "ifconfig" ? 1 : 0,
    stdout: argv[0] === "ioreg" ? IOREG : "",
    stderr: argv[0] === "ifconfig" ? "ifconfig: permission denied\n" : "",
  });

  try {
    await observeMacBootstrap({ runner });
    throw new Error("expected observation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(MacObservationCommandError);
    expect(error).toMatchObject({
      argv: ["ifconfig", "-a"],
      exitCode: 1,
      stderr: "ifconfig: permission denied\n",
    });
  }
});

test("fails typed when ioreg does not provide a stable machine identity", async () => {
  const runner: MacObservationCommandRunner = async (argv) => ({
    exitCode: 0,
    stdout: argv[0] === "hostname" ? "studio.local\n" : "",
    stderr: "",
  });

  await expect(observeMacBootstrap({ runner })).rejects.toBeInstanceOf(
    MacMachineIdentityUnavailableError,
  );
});

test("wraps an unavailable built-in as the same typed command failure", async () => {
  const runner: MacObservationCommandRunner = async (argv) => {
    if (argv[0] === "hostname") throw new Error("ENOENT");
    return { exitCode: 0, stdout: argv[0] === "ioreg" ? IOREG : "", stderr: "" };
  };

  try {
    await observeMacBootstrap({ runner });
    throw new Error("expected observation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(MacObservationCommandError);
    expect(error).toMatchObject({ argv: ["hostname"], exitCode: null });
  }
});

test("marks a service-backed VLAN as virtual rather than physical Ethernet", async () => {
  const runner: MacObservationCommandRunner = async (argv) => {
    const stdout =
      argv[0] === "ioreg"
        ? IOREG
        : argv[0] === "hostname"
          ? "studio.local\n"
          : argv[0] === "networksetup"
            ? "(1) Corp LAN\n(Hardware Port: VLAN, Device: vlan0)\n"
            : argv[0] === "ifconfig"
              ? "vlan0: flags=8843<UP,BROADCAST,RUNNING,SIMPLEX,MULTICAST> mtu 1500\n\tether aa:bb:cc:dd:ee:10\n\tstatus: active\n"
              : argv[0] === "netstat"
                ? "Routing tables\n"
                : "";
    return { exitCode: 0, stdout, stderr: "" };
  };

  expect((await observeMacBootstrap({ runner })).adapters[0]).toMatchObject({
    stableId: "vlan0",
    physical: false,
    transport: "other",
    virtual: true,
  });
});
