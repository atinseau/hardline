import type { Config } from "../config";
import { psQuote } from "../lib/powershell";
import {
  runRemoteChecked as defaultRunRemoteChecked,
  runRemoteJson as defaultRunRemoteJson,
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
import { canonicalEthernetHardwareId } from "./network";

export type WindowsLinkObservationPayload = {
  readonly machineId: string;
  readonly computerName: string;
  readonly selectedAdapter: {
    readonly alias: string;
    readonly hardwareId: string;
    readonly macAddress: string;
    readonly ifIndex: number;
    readonly addresses: readonly string[];
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
  readonly runRemoteJson?: (
    target: SSHTarget,
    script: string,
  ) => Promise<readonly WindowsLinkObservationPayload[]>;
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
  if (source === "route" && observation.connected !== true) return "other";
  const links = [
    profile.directLink,
    ...(profile.pendingMigration
      ? [profile.pendingMigration.oldLink, profile.pendingMigration.proposedLink]
      : []),
  ];
  return links.some((link) =>
    observation.cidr === (source === "route"
      ? link.subnet
      : source === "address"
        ? `${machine === "mac" ? link.macAddress : link.windowsAddress}/30`
        : `${machine === "mac" ? link.windowsAddress : link.macAddress}/32`),
  ) ? "hardline" : "other";
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
  return `$machineId = [string](Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID
$computerName = [string]$env:COMPUTERNAME
$adapter = Get-NetAdapter -IncludeHidden | Where-Object { ([string]$_.InterfaceGuid).Trim('{}') -ieq ${hardwareIdQ}.Trim('{}') } | Select-Object -First 1
$allAddresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)
$allRoutes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue)
$activeIpv4Addresses = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop | Where-Object { [string]$_.State -notin @('Unreachable', 'Incomplete') } | ForEach-Object { [pscustomobject]@{ cidr = "$([string]$_.IPAddress)/32"; ifIndex = [int]$_.InterfaceIndex } })
[pscustomobject]@{
  machineId = $machineId
  computerName = $computerName
  selectedAdapter = if ($adapter) {
    [pscustomobject]@{
      alias = [string]$adapter.Name
      hardwareId = [string]$adapter.InterfaceGuid
      macAddress = [string]$adapter.MacAddress
      ifIndex = [int]$adapter.ifIndex
      addresses = @($allAddresses | Where-Object InterfaceIndex -eq $adapter.ifIndex | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
    }
  } else { $null }
  addresses = @($allAddresses | ForEach-Object { [pscustomobject]@{ cidr = "$($_.IPAddress)/$($_.PrefixLength)"; ifIndex = [int]$_.InterfaceIndex } })
  routes = @($allRoutes | ForEach-Object { [pscustomobject]@{ cidr = [string]$_.DestinationPrefix; ifIndex = [int]$_.InterfaceIndex; nextHop = [string]$_.NextHop } })
  activeIpv4Addresses = $activeIpv4Addresses
}`;
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
      addresses: [...payload.selectedAdapter.addresses],
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
  const runJson =
    options.runRemoteJson ??
    ((target: SSHTarget, script: string) =>
      defaultRunRemoteJson<WindowsLinkObservationPayload>(target, script));
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
          const payload = (await runJson(projectConfig(candidate).ssh, observationScript))[0];
          if (!payload) return { kind: "unavailable" };
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
            const payload = (await runJson(recoveryTarget(directTarget, alias), observationScript))[0];
            const observation = payload ? normalizeWindows(candidate, payload) : null;
            if (observation?.machineId === candidate.windows.machineId) {
              const windowsAddress = payload!.selectedAdapter?.addresses
                .map((address) => address.split("/")[0]!)
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
