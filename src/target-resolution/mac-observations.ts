import type { MacBootstrapObservations } from "./bootstrap-target";
import { parseIpv4Cidr, type NetworkAdapterObservation, type NetworkTransport } from "./network";

export type MacObservationCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type MacObservationCommandRunner = (
  argv: readonly string[],
) => Promise<MacObservationCommandResult>;

export type MacObservationOptions = {
  readonly runner?: MacObservationCommandRunner;
};

export class MacObservationCommandError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    cause?: unknown,
  ) {
    super(
      exitCode === null
        ? `Unable to run ${argv[0]}.`
        : `${argv[0]} failed with exit code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
      { cause },
    );
    this.name = "MacObservationCommandError";
  }
}

export class MacMachineIdentityUnavailableError extends Error {
  constructor() {
    super("ioreg did not report a stable IOPlatformUUID.");
    this.name = "MacMachineIdentityUnavailableError";
  }
}

export class MacArpObservationError extends Error {
  constructor(readonly line: string) {
    super(`Malformed arp observation: ${line}`);
    this.name = "MacArpObservationError";
  }
}

export function parseIOPlatformUUID(stdout: string): string | null {
  return (
    stdout
      .match(
        /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})"/,
      )?.[1]
      ?.toUpperCase() ?? null
  );
}

export type MacNetworkService = {
  readonly interfaceId: string;
  readonly alias: string;
  readonly hardwareName: string;
  readonly enabled: boolean;
};

export type MacInterfaceObservation = {
  readonly interfaceId: string;
  readonly flags: readonly string[];
  readonly macAddress: string | null;
  readonly addresses: readonly string[];
  readonly linkState: "up" | "down";
  readonly speedMbps: number | null;
};

export type MacRouteObservation = {
  readonly cidr: string;
  readonly interfaceId: string;
  readonly connected: boolean;
};

export type MacArpObservation = {
  readonly cidr: string;
  readonly interfaceId: string;
};

export function parseMacNetworkServices(stdout: string): MacNetworkService[] {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  const services: MacNetworkService[] = [];
  for (let index = 0; index < lines.length; index++) {
    const service = /^\(\d+\)\s+(.+)$/.exec(lines[index] ?? "");
    const device = /^\(Hardware Port:\s*(.+?),\s*Device:\s*(.+?)\)$/.exec(
      lines[index + 1] ?? "",
    );
    if (!service || !device) continue;
    const enabled = !service[1]!.startsWith("*");
    services.push({
      alias: enabled ? service[1]! : service[1]!.slice(1),
      hardwareName: device[1]!,
      interfaceId: device[2]!,
      enabled,
    });
  }
  return services;
}

function prefixLength(netmask: string): number | null {
  let value: number;
  if (/^0x[0-9a-f]{8}$/i.test(netmask)) {
    value = Number.parseInt(netmask.slice(2), 16) >>> 0;
  } else {
    const octets = netmask.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
      return null;
    }
    value = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  }
  const inverse = ~value >>> 0;
  if ((inverse & (inverse + 1)) !== 0) return null;
  return 32 - Math.log2(inverse + 1);
}

function mediaSpeed(block: string): number | null {
  const match = /^\s*media:.*?\((\d+(?:\.\d+)?)([GMK]?)base[^)]*\)/im.exec(block);
  if (!match) return null;
  const multiplier = match[2] === "G" ? 1000 : match[2] === "K" ? 0.001 : 1;
  return Number(match[1]) * multiplier;
}

export function parseMacIfconfig(stdout: string): MacInterfaceObservation[] {
  const starts = [...stdout.matchAll(/^([^\s:]+):\s+flags=\w+<([^>]*)>.*$/gm)];
  return starts.map((header, index) => {
    const start = header.index!;
    const block = stdout.slice(start, starts[index + 1]?.index ?? stdout.length);
    const status = /^\s*status:\s*(\S+)/im.exec(block)?.[1]?.toLowerCase();
    const flags = header[2]!.split(",").filter(Boolean);
    const addresses: string[] = [];
    for (const address of block.matchAll(/^\s*inet\s+(\d{1,3}(?:\.\d{1,3}){3}).*?\snetmask\s+(\S+)/gm)) {
      const prefix = prefixLength(address[2]!);
      if (prefix !== null) addresses.push(`${address[1]!}/${prefix}`);
    }
    return {
      interfaceId: header[1]!,
      flags,
      macAddress: /^\s*ether\s+([0-9a-f:]{17})\s*$/im.exec(block)?.[1]?.toLowerCase() ?? null,
      addresses,
      linkState:
        status === "active" || (status === undefined && flags.includes("UP") && flags.includes("RUNNING"))
          ? "up"
          : "down",
      speedMbps: mediaSpeed(block),
    };
  });
}

function routeCidr(destination: string, flags: string): string | null {
  if (destination === "default") return "0.0.0.0/0";
  const [rawAddress, rawPrefix] = destination.split("/");
  const octets = rawAddress!.split(".");
  if (
    octets.length > 4 ||
    octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)
  ) {
    return null;
  }
  const prefix = rawPrefix === undefined ? (flags.includes("H") ? 32 : octets.length * 8) : Number(rawPrefix);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  while (octets.length < 4) octets.push("0");
  return `${octets.join(".")}/${prefix}`;
}

export function parseMacRoutes(stdout: string): MacRouteObservation[] {
  const routes: MacRouteObservation[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const columns = /^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s|$)/.exec(line);
    if (!columns) continue;
    const cidr = routeCidr(columns[1]!, columns[3]!);
    if (cidr !== null) {
      routes.push({
        cidr,
        interfaceId: columns[4]!,
        connected: columns[2]!.startsWith("link#"),
      });
    }
  }
  return routes;
}

export function parseMacArpObservations(stdout: string): MacArpObservation[] {
  const observations: MacArpObservation[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const entry = /^.+\s+\(([^)]+)\)\s+at\s+(\S+).*\son\s+(\S+)(?:\s|$)/.exec(line);
    if (!entry) throw new MacArpObservationError(rawLine);
    if (entry[2] === "(incomplete)") continue;
    if (!/^(?:[0-9a-f]{1,2}:){5}[0-9a-f]{1,2}$/i.test(entry[2]!)) {
      throw new MacArpObservationError(rawLine);
    }
    const parsed = parseIpv4Cidr(entry[1]!);
    if (parsed.kind === "invalid" || parsed.prefixLength !== 32) {
      throw new MacArpObservationError(rawLine);
    }
    observations.push({ cidr: `${parsed.firstAddress}/32`, interfaceId: entry[3]! });
  }
  return observations;
}

export function parseMacArp(stdout: string): string[] {
  return parseMacArpObservations(stdout).map(({ cidr }) => cidr);
}

const runCommand: MacObservationCommandRunner = async (argv) => {
  const process = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
};

function transportFor(
  networkInterface: MacInterfaceObservation,
  service: MacNetworkService | undefined,
): NetworkTransport {
  const description = service?.hardwareName.toLowerCase() ?? "";
  if (networkInterface.flags.includes("LOOPBACK")) return "loopback";
  if (networkInterface.flags.includes("POINTOPOINT")) return "tunnel";
  if (networkInterface.interfaceId.startsWith("bridge") || description.includes("bridge")) return "bridge";
  if (description.includes("wi-fi") || description.includes("airport")) return "wifi";
  if (description.includes("bluetooth")) return "bluetooth";
  if (description.includes("vpn")) return "vpn";
  if (/^(?:vlan|vmnet|vnic|tap|awdl|llw|ap)\d+$/.test(networkInterface.interfaceId)) return "other";
  if (service && networkInterface.macAddress) return "ethernet";
  return "other";
}

function normalizeAdapter(
  networkInterface: MacInterfaceObservation,
  service: MacNetworkService | undefined,
  defaultRouteInterfaces: ReadonlySet<string>,
): NetworkAdapterObservation {
  const transport = transportFor(networkInterface, service);
  const physical =
    networkInterface.macAddress !== null &&
    service !== undefined &&
    (transport === "ethernet" || transport === "wifi" || transport === "bluetooth");
  return {
    stableId: networkInterface.interfaceId,
    alias: service?.alias ?? networkInterface.interfaceId,
    hardwareName: service?.hardwareName ?? networkInterface.interfaceId,
    macAddress: networkInterface.macAddress ?? "",
    speedMbps: networkInterface.speedMbps,
    physical,
    transport,
    virtual: !physical,
    linkState: service?.enabled === false ? "down" : networkInterface.linkState,
    inUse: networkInterface.addresses.some((address) => !address.startsWith("169.254.")),
    hasDefaultRoute: defaultRouteInterfaces.has(networkInterface.interfaceId),
  };
}

export async function observeMacBootstrap(
  options: MacObservationOptions = {},
): Promise<MacBootstrapObservations> {
  const runner = options.runner ?? runCommand;
  const commands = [
    ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
    ["hostname"],
    ["networksetup", "-listnetworkserviceorder"],
    ["ifconfig", "-a"],
    ["netstat", "-rn", "-f", "inet"],
    ["arp", "-an"],
  ] as const;
  const [identityResult, hostnameResult, servicesResult, interfacesResult, routesResult, arpResult] =
    await Promise.all(
      commands.map(async (argv) => {
        try {
          return await runner(argv);
        } catch (error) {
          throw new MacObservationCommandError(argv, null, "", error);
        }
      }),
    );
  const results = [identityResult, hostnameResult, servicesResult, interfacesResult, routesResult];
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    if (result.exitCode !== 0) {
      throw new MacObservationCommandError(commands[index]!, result.exitCode, result.stderr);
    }
  }
  const services = parseMacNetworkServices(servicesResult!.stdout);
  const interfaces = parseMacIfconfig(interfacesResult!.stdout);
  const routes = parseMacRoutes(routesResult!.stdout);
  const servicesByDevice = new Map(services.map((service) => [service.interfaceId, service]));
  const defaultRouteInterfaces = new Set(
    routes.filter((route) => route.cidr === "0.0.0.0/0").map((route) => route.interfaceId),
  );
  const machineId = parseIOPlatformUUID(identityResult!.stdout);
  if (machineId === null) throw new MacMachineIdentityUnavailableError();

  return {
    machineId,
    hostAliases: [hostnameResult!.stdout.trim()].filter(Boolean),
    adapters: interfaces.map((networkInterface) =>
      normalizeAdapter(
        networkInterface,
        servicesByDevice.get(networkInterface.interfaceId),
        defaultRouteInterfaces,
      ),
    ),
    routes: routes.map((route) => route.cidr),
    addresses: interfaces.flatMap((networkInterface) => networkInterface.addresses),
    activeIpv4Addresses: parseMacArp(arpResult!.stdout),
  };
}
