import type { Config } from "../config";
import { psQuote } from "../lib/powershell";
import {
  runRemote as defaultRunRemote,
  runRemoteChecked as defaultRunRemoteChecked,
  type RemoteResult,
  type SSHTarget,
} from "../lib/ssh";
import type { MacBootstrapObservations } from "./bootstrap-target";
import type {
  LinkRecoveryAdapters,
  MacLinkObservation,
  OccupiedCidrObservation,
  WindowsLinkObservation,
} from "./link-recovery";
import {
  MacObservationCommandError,
  observeMacBootstrap as defaultObserveMac,
  parseMacIfconfig,
  parseMacArpObservations,
  parseMacRoutes,
  type MacObservationCommandResult,
  type MacObservationCommandRunner,
  type MacObservationOptions,
} from "./mac-observations";
import { projectTargetConfig as defaultProjectConfig } from "./project-config";
import { writeTargetProfile as defaultWriteProfile } from "./target-profile";
import type { TargetProfile } from "./types";
import { canonicalEthernetHardwareId, parseIpv4Cidr } from "./network";

export type WindowsLinkObservationPayload = {
  readonly machineId: string;
  readonly computerName: string;
  readonly selectedAdapter: {
    readonly alias: string;
    readonly hardwareId: string;
    readonly macAddress: string;
    readonly ifIndex: number;
  } | null;
  readonly addresses: readonly { readonly cidr: string; readonly ifIndex: number }[];
  readonly routes: readonly {
    readonly cidr: string;
    readonly ifIndex: number;
    readonly nextHop: string;
  }[];
  readonly activeIpv4Addresses: readonly { readonly cidr: string; readonly ifIndex: number }[];
};

export type LinkRecoveryAdapterOptions = {
  readonly profile: TargetProfile;
  readonly profilePath: string;
  readonly observeMac?: (options?: MacObservationOptions) => Promise<MacBootstrapObservations>;
  readonly runMacCommand?: MacObservationCommandRunner;
  readonly projectConfig?: (profile: TargetProfile) => Config;
  readonly runRemote?: (
    target: SSHTarget,
    script: string,
  ) => Promise<RemoteResult>;
  readonly runRemoteChecked?: (target: SSHTarget, script: string) => Promise<RemoteResult>;
  readonly writeProfile?: (path: string, profile: TargetProfile) => Promise<void>;
};

const runMacCommand: MacObservationCommandRunner = async (argv) => {
  const process = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
};

async function checkedMacCommand(
  runner: MacObservationCommandRunner,
  argv: readonly string[],
): Promise<MacObservationCommandResult> {
  let result: MacObservationCommandResult;
  try {
    result = await runner(argv);
  } catch (error) {
    throw new MacObservationCommandError(argv, null, "", error);
  }
  if (result.exitCode !== 0) {
    throw new MacObservationCommandError(argv, result.exitCode, result.stderr);
  }
  return result;
}

type InterfaceCidrObservation = {
  readonly cidr: string;
  readonly interfaceId: string | number;
  readonly connected?: boolean;
};

function ownership(
  profile: TargetProfile,
  machine: "mac" | "windows",
  observation: InterfaceCidrObservation,
  source: OccupiedCidrObservation["source"],
  selectedInterfaceId: string | number,
): OccupiedCidrObservation["ownership"] {
  if (observation.interfaceId !== selectedInterfaceId) return "other";
  const links = [
    profile.directLink,
    ...(profile.pendingMigration
      ? [profile.pendingMigration.oldLink, profile.pendingMigration.proposedLink]
      : []),
  ];
  return links.some((link) =>
    source === "route" || source === "active-use"
      ? cidrContainedBy(observation.cidr, link.subnet)
      : observation.cidr === (source === "address"
        ? `${machine === "mac" ? link.macAddress : link.windowsAddress}/30`
        : `${machine === "mac" ? link.windowsAddress : link.macAddress}/32`),
  ) ? "hardline" : "other";
}

function cidrContainedBy(value: string, parent: string): boolean {
  const child = parseIpv4Cidr(value);
  const container = parseIpv4Cidr(parent);
  return child.kind === "parsed" &&
    container.kind === "parsed" &&
    ipv4Value(child.firstAddress) >= ipv4Value(container.firstAddress) &&
    ipv4Value(child.lastAddress) <= ipv4Value(container.lastAddress);
}

function ipv4Value(address: string): number {
  return address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}

function occupiedCidrs(
  profile: TargetProfile,
  machine: "mac" | "windows",
  selectedInterfaceId: string | number,
  addresses: readonly InterfaceCidrObservation[],
  routes: readonly InterfaceCidrObservation[],
  activeUse: readonly InterfaceCidrObservation[],
): OccupiedCidrObservation[] {
  return [
    ...addresses.map((observation) => ({
      cidr: observation.cidr,
      source: "address" as const,
      ownership: ownership(profile, machine, observation, "address", selectedInterfaceId),
    })),
    ...routes.map((observation) => ({
      cidr: observation.cidr,
      source: "route" as const,
      ownership: ownership(profile, machine, observation, "route", selectedInterfaceId),
    })),
    ...activeUse.map((observation) => ({
      cidr: observation.cidr,
      source: "active-use" as const,
      ownership: ownership(profile, machine, observation, "active-use", selectedInterfaceId),
    })),
  ];
}

function normalizedMacAddress(value: string): string {
  return value.toLowerCase().replaceAll("-", ":");
}

function windowsObservationScript(hardwareId: string): string {
  const hardwareIdQ = psQuote(hardwareId, "persisted Windows Ethernet hardware ID");
  // Windows PowerShell 5.1 can hang while serializing combined NetTCPIP collections.
  return `$ErrorActionPreference = 'Stop'
$separator = [char]9
$machineId = [string](Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID
$computerName = [string]$env:COMPUTERNAME
$adapter = Get-NetAdapter -IncludeHidden | Where-Object { ([string]$_.InterfaceGuid).Trim('{}') -ieq ${hardwareIdQ}.Trim('{}') } | Select-Object -First 1
$allAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)
$allRoutes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue)
$activeIpv4Addresses = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop | Where-Object { [string]$_.State -notin @('Unreachable', 'Incomplete') } | ForEach-Object { [pscustomobject]@{ cidr = "$([string]$_.IPAddress)/32"; ifIndex = [int]$_.InterfaceIndex } })
"machine$separator$machineId$separator$computerName"
if ($adapter) {
  "adapter$separator$($adapter.Name)$separator$($adapter.InterfaceGuid)$separator$($adapter.MacAddress)$separator$([int]$adapter.ifIndex)"
}
$allAddresses | ForEach-Object { "address$separator$($_.IPAddress)/$($_.PrefixLength)$separator$([int]$_.InterfaceIndex)" }
$allRoutes | ForEach-Object { "route$separator$($_.DestinationPrefix)$separator$([int]$_.InterfaceIndex)$separator$($_.NextHop)" }
$activeIpv4Addresses | ForEach-Object { "active-use$separator$($_.cidr)$separator$([int]$_.ifIndex)" }`;
}

function parseWindowsIfIndex(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("Invalid Windows interface index.");
  return Number(value);
}

function parseWindowsObservation(lines: readonly string[]): WindowsLinkObservationPayload {
  let machineId: string | undefined;
  let computerName: string | undefined;
  let selectedAdapter: WindowsLinkObservationPayload["selectedAdapter"] = null;
  const addresses: Array<{ cidr: string; ifIndex: number }> = [];
  const routes: Array<{ cidr: string; ifIndex: number; nextHop: string }> = [];
  const activeIpv4Addresses: Array<{ cidr: string; ifIndex: number }> = [];

  for (const line of lines) {
    const fields = line.split("\t");
    switch (fields[0]) {
      case "machine":
        if (fields.length !== 3 || machineId !== undefined) throw new Error("Invalid Windows machine observation.");
        machineId = fields[1]!;
        computerName = fields[2]!;
        break;
      case "adapter":
        if (fields.length !== 5 || selectedAdapter !== null) throw new Error("Invalid Windows adapter observation.");
        selectedAdapter = {
          alias: fields[1]!,
          hardwareId: fields[2]!,
          macAddress: fields[3]!,
          ifIndex: parseWindowsIfIndex(fields[4]!),
        };
        break;
      case "address":
        if (fields.length !== 3) throw new Error("Invalid Windows address observation.");
        addresses.push({ cidr: fields[1]!, ifIndex: parseWindowsIfIndex(fields[2]!) });
        break;
      case "route":
        if (fields.length !== 4) throw new Error("Invalid Windows route observation.");
        routes.push({
          cidr: fields[1]!,
          ifIndex: parseWindowsIfIndex(fields[2]!),
          nextHop: fields[3]!,
        });
        break;
      case "active-use":
        if (fields.length !== 3) throw new Error("Invalid Windows active-use observation.");
        activeIpv4Addresses.push({
          cidr: fields[1]!,
          ifIndex: parseWindowsIfIndex(fields[2]!),
        });
        break;
      default:
        throw new Error("Invalid Windows observation record.");
    }
  }

  if (machineId === undefined || computerName === undefined) {
    throw new Error("Windows machine observation is missing.");
  }
  return { machineId, computerName, selectedAdapter, addresses, routes, activeIpv4Addresses };
}

function normalizeWindows(
  profile: TargetProfile,
  payload: WindowsLinkObservationPayload,
): WindowsLinkObservation | null {
  if (!payload.selectedAdapter) return null;
  return {
    machineId: payload.machineId,
    hostAliases: [payload.computerName].filter(Boolean),
    selectedEthernet: {
      interfaceAlias: payload.selectedAdapter.alias,
      hardwareId: payload.selectedAdapter.hardwareId,
      macAddress: payload.selectedAdapter.macAddress,
      addresses: payload.addresses
        .filter(({ ifIndex }) => ifIndex === payload.selectedAdapter!.ifIndex)
        .map(({ cidr }) => cidr),
    },
    occupiedCidrs: occupiedCidrs(
      profile,
      "windows",
      payload.selectedAdapter.ifIndex,
      payload.addresses.map(({ cidr, ifIndex }) => ({ cidr, interfaceId: ifIndex })),
      payload.routes.map(({ cidr, ifIndex, nextHop }) => ({
        cidr,
        interfaceId: ifIndex,
        connected: nextHop === "0.0.0.0",
      })),
      payload.activeIpv4Addresses.map(({ cidr, ifIndex }) => ({ cidr, interfaceId: ifIndex })),
    ),
  };
}

function recoveryTarget(target: SSHTarget, host: string): SSHTarget {
  if (target.knownHostsFile === undefined) {
    throw new Error("Link Recovery requires a strict SSH target with a pinned host key.");
  }
  return {
    host,
    user: target.user,
    identityFile: target.identityFile,
    connectTimeoutSec: target.connectTimeoutSec,
    knownHostsFile: target.knownHostsFile,
    hostKeyAlias: target.hostKeyAlias,
  };
}

function observedPhysicalTarget(
  target: SSHTarget,
  physicalPath: { readonly macAddress: string; readonly windowsAddress: string },
): SSHTarget {
  if (target.knownHostsFile === undefined) {
    throw new Error("Physical Link Recovery requires a strict SSH target.");
  }
  return {
    host: physicalPath.windowsAddress,
    user: target.user,
    identityFile: target.identityFile,
    connectTimeoutSec: target.connectTimeoutSec,
    knownHostsFile: target.knownHostsFile,
    hostKeyAlias: target.hostKeyAlias,
    sourceAddress: physicalPath.macAddress,
    ...(target.bindInterface ? { bindInterface: target.bindInterface } : {}),
  };
}

function selectedAdapter(hardwareId: string): string {
  const hardwareIdQ = psQuote(hardwareId, "persisted Windows Ethernet hardware ID");
  return `$adapter = Get-NetAdapter -IncludeHidden | Where-Object { ([string]$_.InterfaceGuid).Trim('{}') -ieq ${hardwareIdQ}.Trim('{}') } | Select-Object -First 1
if (-not $adapter) { throw 'The persisted Windows Ethernet adapter is unavailable.' }`;
}

function addWindowsAddressScript(hardwareId: string, address: string, prefixLength: 30): string {
  const addressQ = psQuote(address, "Direct Link IPv4 address");
  return `${selectedAdapter(hardwareId)}
$address = Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -IPAddress ${addressQ} -ErrorAction SilentlyContinue
if ($address) {
  if ($address.PrefixLength -ne ${prefixLength}) {
    Set-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress ${addressQ} -PrefixLength ${prefixLength} | Out-Null
  }
} else {
  New-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress ${addressQ} -PrefixLength ${prefixLength} | Out-Null
}`;
}

function removeWindowsAddressScript(hardwareId: string, address: string): string {
  const addressQ = psQuote(address, "Direct Link IPv4 address");
  return `${selectedAdapter(hardwareId)}
Remove-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress ${addressQ} -Confirm:$false -ErrorAction SilentlyContinue`;
}

export function createLinkRecoveryAdapters(
  options: LinkRecoveryAdapterOptions,
): LinkRecoveryAdapters {
  const profile = options.profile;
  const observeMac = options.observeMac ?? defaultObserveMac;
  const macRunner = options.runMacCommand ?? runMacCommand;
  const projectConfig = options.projectConfig ?? defaultProjectConfig;
  const runObservation = options.runRemote ??
    ((target: SSHTarget, script: string) => defaultRunRemote(target, script, 30_000));
  const runChecked = options.runRemoteChecked ?? defaultRunRemoteChecked;
  const writeProfile = options.writeProfile ?? defaultWriteProfile;
  const observationScript = windowsObservationScript(profile.windows.ethernet.hardwareId);
  let latestMac: MacLinkObservation | undefined;

  return {
    macObservation: {
      observeMacLink: async (): Promise<MacLinkObservation> => {
        const [bootstrap, interfacesResult, routesResult, arpResult] = await Promise.all([
          observeMac({ runner: macRunner }),
          checkedMacCommand(macRunner, ["ifconfig", "-a"]),
          checkedMacCommand(macRunner, ["netstat", "-rn", "-f", "inet"]),
          checkedMacCommand(macRunner, ["arp", "-an"]),
        ]);
        const adapter = bootstrap.adapters.find(
          (candidate) =>
            canonicalEthernetHardwareId(candidate.macAddress) ===
              profile.mac.ethernet.hardwareId &&
            normalizedMacAddress(candidate.macAddress) ===
              normalizedMacAddress(profile.mac.ethernet.macAddress),
        );
        const networkInterface = parseMacIfconfig(interfacesResult.stdout).find(
          ({ interfaceId }) => interfaceId === adapter?.stableId,
        );
        if (!adapter || !networkInterface || !networkInterface.macAddress) {
          throw new Error("The persisted Mac Ethernet adapter is unavailable.");
        }
        const interfaces = parseMacIfconfig(interfacesResult.stdout);
        const routes = parseMacRoutes(routesResult.stdout);
        latestMac = {
          machineId: bootstrap.machineId,
          hostAliases: bootstrap.hostAliases,
          selectedEthernet: {
            hardwareId: canonicalEthernetHardwareId(networkInterface.macAddress),
            macAddress: networkInterface.macAddress,
            interfaceId: adapter.stableId,
            serviceName: adapter.alias,
            addresses: networkInterface.addresses,
          },
          occupiedCidrs: occupiedCidrs(
            profile,
            "mac",
            adapter.stableId,
            interfaces.flatMap(({ interfaceId, addresses }) =>
              addresses.map((cidr) => ({ cidr, interfaceId })),
            ),
            routes,
            parseMacArpObservations(arpResult.stdout),
          ),
        };
        return latestMac;
      },
    },
    macAddressing: {
      addMacAddress: async (interfaceId, address) => {
        await checkedMacCommand(macRunner, [
          "sudo",
          "ifconfig",
          interfaceId,
          "alias",
          address,
          "netmask",
          "255.255.255.252",
        ]);
      },
      removeMacAddress: async (interfaceId, address) => {
        await checkedMacCommand(macRunner, ["sudo", "ifconfig", interfaceId, "-alias", address]);
      },
    },
    strictDirectProbe: {
      probeDirect: async (candidate) => {
        try {
          const result = await runObservation(projectConfig(candidate).ssh, observationScript);
          if (result.exitCode !== 0) return { kind: "unavailable" };
          const payload = parseWindowsObservation(
            result.stdout.split(/\r?\n/).filter(Boolean),
          );
          const windows = normalizeWindows(candidate, payload);
          return windows ? { kind: "reachable", windows } : { kind: "unavailable" };
        } catch {
          return { kind: "unavailable" };
        }
      },
    },
    directLinkAddressing: {
      addWindowsAddressOverDirectLink: async (currentProfile, proposedProfile) => {
        await runChecked(
          projectConfig(currentProfile).ssh,
          addWindowsAddressScript(
            profile.windows.ethernet.hardwareId,
            proposedProfile.directLink.windowsAddress,
            30,
          ),
        );
      },
      addWindowsAddressOverObservedPhysicalLink: async (currentProfile, proposedProfile, physicalPath) => {
        await runChecked(
          observedPhysicalTarget(projectConfig(currentProfile).ssh, physicalPath),
          addWindowsAddressScript(
            profile.windows.ethernet.hardwareId,
            proposedProfile.directLink.windowsAddress,
            30,
          ),
        );
      },
      removeWindowsAddressOverDirectLink: async (currentProfile, address) => {
        await runChecked(
          projectConfig(currentProfile).ssh,
          removeWindowsAddressScript(profile.windows.ethernet.hardwareId, address),
        );
      },
    },
    recoveryChannel: {
      observeRecovery: async (candidate) => {
        const directTarget = projectConfig(candidate).ssh;
        for (const alias of candidate.windows.hostAliases) {
          try {
            const result = await runObservation(recoveryTarget(directTarget, alias), observationScript);
            if (result.exitCode !== 0) continue;
            const payload = parseWindowsObservation(
              result.stdout.split(/\r?\n/).filter(Boolean),
            );
            const observation = normalizeWindows(candidate, payload);
            if (observation?.machineId === candidate.windows.machineId) {
              const selectedIfIndex = payload!.selectedAdapter?.ifIndex;
              const windowsAddress = payload!.addresses
                .filter(({ ifIndex }) => ifIndex === selectedIfIndex)
                .map(({ cidr }) => cidr.split("/")[0]!)
                .find((address) => address.startsWith("169.254."));
              const mac = latestMac?.selectedEthernet.addresses
                .map((address) => address.split("/")[0]!)
                .find((address) => address.startsWith("169.254."));
              return windowsAddress && mac
                ? {
                    kind: "pc-alive",
                    windows: observation,
                    physicalPath: { macAddress: mac, windowsAddress: windowsAddress },
                  }
                : { kind: "pc-alive", windows: observation };
            }
          } catch {
            // Try the next observed machine alias without widening Recovery Channel capability.
          }
        }
        return { kind: "pc-inaccessible" };
      },
    },
    profilePersistence: {
      persistProfileAtomically: async (candidate) => {
        await writeProfile(options.profilePath, candidate);
      },
    },
  };
}
