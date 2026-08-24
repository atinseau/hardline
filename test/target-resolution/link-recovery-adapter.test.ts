import { describe, expect, test } from "bun:test";
import type { Config } from "../../src/config";
import type { SSHTarget } from "../../src/lib/ssh";
import {
  createLinkRecoveryAdapters,
  type WindowsLinkObservationPayload,
} from "../../src/target-resolution/link-recovery-adapter";
import type { MacBootstrapObservations } from "../../src/target-resolution/bootstrap-target";
import type {
  MacObservationCommandResult,
  MacObservationOptions,
} from "../../src/target-resolution/mac-observations";
import type { TargetProfile } from "../../src/target-resolution/types";

const profile: TargetProfile = {
  version: 1,
  revision: 4,
  lifecycle: "installed",
  mac: {
    machineId: "MAC-UUID",
    hostAliases: ["studio.local"],
    ethernet: {
      hardwareId: "ether:02:00:00:00:00:02",
      macAddress: "02:00:00:00:00:02",
      interfaceId: "en8",
      serviceName: "Old USB LAN",
    },
  },
  windows: {
    machineId: "WINDOWS-UUID",
    hostAliases: ["GAMING-PC", "gaming-pc.local"],
    administrator: "GAMING-PC\\Arthur",
    smbUser: "GAMING-PC\\Arthur",
    ethernet: {
      hardwareId: "{ADAPTER-GUID}",
      macAddress: "02-00-00-00-00-01",
      interfaceAlias: "Ethernet 2",
    },
  },
  directLink: {
    subnet: "10.0.0.0/30",
    windowsAddress: "10.0.0.1",
    macAddress: "10.0.0.2",
  },
  hardlineIdentity: {
    privateKeyPath: "/state/id_ed25519",
    publicKeyPath: "/state/id_ed25519.pub",
  },
  sshHostKey: { algorithm: "ssh-ed25519", publicKey: "AAAAC3Nza-host" },
  installationCatalogVersion: "test-catalog",
};

const strictSsh: SSHTarget = {
  host: "10.0.0.1",
  user: "Arthur",
  identityFile: "/state/id_ed25519",
  connectTimeoutSec: 8,
  knownHostsFile: "/state/known_hosts",
  hostKeyAlias: "[hardline-windows]:22",
  sourceAddress: "10.0.0.2",
  bindInterface: "en8",
};

function projected(candidate: TargetProfile): Config {
  return {
    mac: { serviceName: candidate.mac.ethernet.serviceName, ip: candidate.directLink.macAddress, subnetMask: "255.255.255.252" },
    windows: { interfaceAlias: candidate.windows.ethernet.interfaceAlias, ip: candidate.directLink.windowsAddress, prefixLength: 30 },
    ssh: {
      host: candidate.directLink.windowsAddress,
      user: "Arthur",
      identityFile: "/state/id_ed25519",
      connectTimeoutSec: 8,
      knownHostsFile: "/state/known_hosts",
      hostKeyAlias: "[hardline-windows]:22",
      sourceAddress: candidate.directLink.macAddress,
      bindInterface: candidate.mac.ethernet.interfaceId,
    },
    bootstrapPort: 0,
    apollo: {} as Config["apollo"],
    moonlight: {} as Config["moonlight"],
    smb: {} as Config["smb"],
  };
}

const macBootstrap: MacBootstrapObservations = {
  machineId: "MAC-UUID",
  hostAliases: ["studio-renamed.local"],
  adapters: [
    {
      stableId: "en8",
      alias: "Direct Cable",
      hardwareName: "USB 2.5G Ethernet",
      macAddress: "02:00:00:00:00:02",
      speedMbps: 2500,
      physical: true,
      transport: "ethernet",
      virtual: false,
      linkState: "up",
      inUse: true,
      hasDefaultRoute: false,
    },
  ],
  routes: [],
  addresses: [],
  activeIpv4Addresses: ["10.0.0.1/32", "10.0.0.5/32"],
};

const ifconfig = `en8: flags=8863<UP,BROADCAST,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 10.0.0.2 netmask 0xfffffffc broadcast 10.0.0.3
\tinet 192.168.50.7 netmask 0xffffff00 broadcast 192.168.50.255
\tether 02:00:00:00:00:02
\tstatus: active
en9: flags=8863<UP,BROADCAST,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 172.16.0.2 netmask 0xffffff00 broadcast 172.16.0.255
\tether 02:00:00:00:00:09
\tstatus: active`;

const netstat = `Destination        Gateway            Flags               Netif Expire
default            192.168.50.1       UGScg                 en8
10.0.0/30          link#22            UCS                   en8
172.16             link#23            UCS                   en9`;

const arp = `? (10.0.0.1) at 02:00:00:00:00:01 on en8 ifscope [ethernet]
? (10.0.0.5) at 02:00:00:00:00:05 on en9 ifscope [ethernet]`;

const windowsPayload: WindowsLinkObservationPayload = {
  machineId: "WINDOWS-UUID",
  computerName: "PLAY-PC",
  selectedAdapter: {
    alias: "Hardline Ethernet",
    hardwareId: "{ADAPTER-GUID}",
    macAddress: "02-00-00-00-00-01",
    ifIndex: 22,
    addresses: ["10.0.0.1/30", "192.168.60.8/24"],
  },
  addresses: [
    { cidr: "10.0.0.1/30", ifIndex: 22 },
    { cidr: "192.168.60.8/24", ifIndex: 22 },
    { cidr: "172.20.0.4/16", ifIndex: 30 },
  ],
  routes: [
    { cidr: "10.0.0.0/30", ifIndex: 22, nextHop: "0.0.0.0" },
    { cidr: "0.0.0.0/0", ifIndex: 30, nextHop: "192.168.60.1" },
  ],
  activeIpv4Addresses: [
    { cidr: "10.0.0.2/32", ifIndex: 22 },
    { cidr: "10.0.0.5/32", ifIndex: 30 },
  ],
};

function harness(
  payloads: WindowsLinkObservationPayload[][] = [[windowsPayload]],
  persistedProfile: TargetProfile = profile,
  observedMac: MacBootstrapObservations = macBootstrap,
  observedIfconfig: string = ifconfig,
  observedNetstat: string = netstat,
) {
  const macArgv: Array<readonly string[]> = [];
  const jsonCalls: Array<{ target: SSHTarget; script: string }> = [];
  const checkedCalls: Array<{ target: SSHTarget; script: string }> = [];
  const observedOptions: MacObservationOptions[] = [];
  const persisted: Array<{ path: string; value: TargetProfile }> = [];
  let payloadIndex = 0;

  const runMacCommand = async (argv: readonly string[]): Promise<MacObservationCommandResult> => {
    macArgv.push(argv);
    const stdout =
      argv[0] === "ifconfig" ? observedIfconfig : argv[0] === "arp" ? arp : observedNetstat;
    return { exitCode: 0, stdout, stderr: "" };
  };
  const adapters = createLinkRecoveryAdapters({
    profile: persistedProfile,
    profilePath: "/state/target-profile.json",
    observeMac: async (options) => {
      observedOptions.push(options ?? {});
      return observedMac;
    },
    runMacCommand,
    projectConfig: projected,
    runRemoteJson: async (target, script) => {
      jsonCalls.push({ target, script });
      return payloads[payloadIndex++] ?? [];
    },
    runRemoteChecked: async (target, script) => {
      checkedCalls.push({ target, script });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    writeProfile: async (path, value) => {
      persisted.push({ path, value });
    },
  });
  return { adapters, macArgv, jsonCalls, checkedCalls, observedOptions, persisted, runMacCommand };
}

describe("createLinkRecoveryAdapters", () => {
  test("observes the persisted Mac Ethernet by stable ID and preserves collision ownership", async () => {
    const { adapters, macArgv, observedOptions, runMacCommand } = harness();

    const observation = await adapters.macObservation.observeMacLink();

    expect(observedOptions).toEqual([{ runner: runMacCommand }]);
    expect(macArgv).toEqual([
      ["ifconfig", "-a"],
      ["netstat", "-rn", "-f", "inet"],
      ["arp", "-an"],
    ]);
    expect(observation).toEqual({
      machineId: "MAC-UUID",
      hostAliases: ["studio-renamed.local"],
      selectedEthernet: {
        hardwareId: "ether:02:00:00:00:00:02",
        macAddress: "02:00:00:00:00:02",
        interfaceId: "en8",
        serviceName: "Direct Cable",
        addresses: ["10.0.0.2/30", "192.168.50.7/24"],
      },
      occupiedCidrs: [
        { cidr: "10.0.0.2/30", source: "address", ownership: "hardline" },
        { cidr: "192.168.50.7/24", source: "address", ownership: "other" },
        { cidr: "172.16.0.2/24", source: "address", ownership: "other" },
        { cidr: "0.0.0.0/0", source: "route", ownership: "other" },
        { cidr: "10.0.0.0/30", source: "route", ownership: "hardline" },
        { cidr: "172.16.0.0/16", source: "route", ownership: "other" },
        { cidr: "10.0.0.1/32", source: "active-use", ownership: "hardline" },
        { cidr: "10.0.0.5/32", source: "active-use", ownership: "other" },
      ],
    });
  });

  test("re-resolves a Mac adapter after en8 becomes en9 using hardware key and MAC", async () => {
    const reenumeratedMac: MacBootstrapObservations = {
      ...macBootstrap,
      adapters: [{
        ...macBootstrap.adapters[0]!,
        stableId: "en9",
        alias: "Renumbered Direct Cable",
      }],
    };
    const reenumeratedIfconfig = ifconfig
      .split("en9: flags=", 1)[0]!
      .replace(/^en8:/, "en9:");
    const { adapters } = harness(
      [[windowsPayload]],
      profile,
      reenumeratedMac,
      reenumeratedIfconfig,
    );

    await expect(adapters.macObservation.observeMacLink()).resolves.toMatchObject({
      selectedEthernet: {
        hardwareId: "ether:02:00:00:00:00:02",
        macAddress: "02:00:00:00:00:02",
        interfaceId: "en9",
        serviceName: "Renumbered Direct Cable",
      },
    });
  });

  test("owns a matching Mac connected route only on the selected Ethernet interface", async () => {
    const duplicateNetstat = `Destination        Gateway            Flags               Netif Expire
10.0.0/30          link#22            UCS                   en8
10.0.0/30          link#23            UCS                   en9`;
    const { adapters } = harness(
      [[windowsPayload]],
      profile,
      macBootstrap,
      ifconfig,
      duplicateNetstat,
    );

    const result = await adapters.macObservation.observeMacLink();

    expect(result.occupiedCidrs).toEqual(
      expect.arrayContaining([
        { cidr: "10.0.0.0/30", source: "route", ownership: "hardline" },
        { cidr: "10.0.0.0/30", source: "route", ownership: "other" },
      ]),
    );
  });

  test("refuses a Mac adapter unless both persisted hardware key and MAC match", async () => {
    const wrongHardwareKey: TargetProfile = {
      ...profile,
      mac: {
        ...profile.mac,
        ethernet: {
          ...profile.mac.ethernet,
          hardwareId: "ether:02:00:00:00:00:99",
        },
      },
    };
    const { adapters } = harness([[windowsPayload]], wrongHardwareKey);

    await expect(adapters.macObservation.observeMacLink()).rejects.toThrow(
      "persisted Mac Ethernet adapter is unavailable",
    );
  });

  test("uses one fixed read-only observation over the strict Direct target and normalizes Windows", async () => {
    const { adapters, jsonCalls } = harness();

    const result = await adapters.strictDirectProbe.probeDirect(profile);

    expect(jsonCalls).toHaveLength(1);
    expect(jsonCalls[0]!.target).toEqual(strictSsh);
    expect(jsonCalls[0]!.script).toContain("Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop");
    expect(jsonCalls[0]!.script).not.toContain("Test-Connection");
    expect(result).toEqual({
      kind: "reachable",
      windows: {
        machineId: "WINDOWS-UUID",
        hostAliases: ["PLAY-PC"],
        selectedEthernet: {
          interfaceAlias: "Hardline Ethernet",
          hardwareId: "{ADAPTER-GUID}",
          macAddress: "02-00-00-00-00-01",
          addresses: ["10.0.0.1/30", "192.168.60.8/24"],
        },
        occupiedCidrs: [
          { cidr: "10.0.0.1/30", source: "address", ownership: "hardline" },
          { cidr: "192.168.60.8/24", source: "address", ownership: "other" },
          { cidr: "172.20.0.4/16", source: "address", ownership: "other" },
          { cidr: "10.0.0.0/30", source: "route", ownership: "hardline" },
          { cidr: "0.0.0.0/0", source: "route", ownership: "other" },
          { cidr: "10.0.0.2/32", source: "active-use", ownership: "hardline" },
          { cidr: "10.0.0.5/32", source: "active-use", ownership: "other" },
        ],
      },
    });
  });

  test("owns a matching connected route only on the selected Ethernet interface", async () => {
    const duplicateRoutePayload: WindowsLinkObservationPayload = {
      ...windowsPayload,
      routes: [
        { cidr: "10.0.0.0/30", ifIndex: 22, nextHop: "0.0.0.0" },
        { cidr: "10.0.0.0/30", ifIndex: 44, nextHop: "0.0.0.0" },
      ],
    };
    const { adapters } = harness([[duplicateRoutePayload]]);

    const result = await adapters.strictDirectProbe.probeDirect(profile);

    expect(result).toMatchObject({
      kind: "reachable",
      windows: {
        occupiedCidrs: expect.arrayContaining([
          { cidr: "10.0.0.0/30", source: "route", ownership: "hardline" },
          { cidr: "10.0.0.0/30", source: "route", ownership: "other" },
        ]),
      },
    });
  });

  test("classifies both sides of a pending migration as Hardline-owned", async () => {
    const pendingProfile: TargetProfile = {
      ...profile,
      pendingMigration: {
        operation: "migration",
        oldLink: profile.directLink,
        proposedLink: {
          subnet: "10.0.0.4/30",
          windowsAddress: "10.0.0.5",
          macAddress: "10.0.0.6",
        },
      },
    };
    const pendingPayload = {
      ...windowsPayload,
      selectedAdapter: {
        ...windowsPayload.selectedAdapter!,
        addresses: ["10.0.0.1/30", "10.0.0.5/30"],
      },
      addresses: [
        { cidr: "10.0.0.1/30", ifIndex: 22 },
        { cidr: "10.0.0.5/30", ifIndex: 22 },
      ],
      routes: [
        { cidr: "10.0.0.0/30", ifIndex: 22, nextHop: "0.0.0.0" },
        { cidr: "10.0.0.4/30", ifIndex: 22, nextHop: "0.0.0.0" },
      ],
      activeIpv4Addresses: [
        { cidr: "10.0.0.2/32", ifIndex: 22 },
        { cidr: "10.0.0.6/32", ifIndex: 22 },
      ],
    };
    const { adapters } = harness([[pendingPayload]], pendingProfile);

    const result = await adapters.strictDirectProbe.probeDirect(pendingProfile);

    expect(result).toMatchObject({
      kind: "reachable",
      windows: {
        occupiedCidrs: [
          { cidr: "10.0.0.1/30", ownership: "hardline" },
          { cidr: "10.0.0.5/30", ownership: "hardline" },
          { cidr: "10.0.0.0/30", ownership: "hardline" },
          { cidr: "10.0.0.4/30", ownership: "hardline" },
          { cidr: "10.0.0.2/32", ownership: "hardline" },
          { cidr: "10.0.0.6/32", ownership: "hardline" },
        ],
      },
    });
  });

  test("mutates only the selected Windows adapter over the current or proposed strict Direct Link", async () => {
    const { adapters, checkedCalls } = harness();
    const proposed = {
      ...profile,
      directLink: { subnet: "10.0.0.4/30", windowsAddress: "10.0.0.5", macAddress: "10.0.0.6" },
    };

    await adapters.directLinkAddressing.addWindowsAddressOverDirectLink(profile, proposed);
    await adapters.directLinkAddressing.removeWindowsAddressOverDirectLink(proposed, "10.0.0.1", 30);

    expect(checkedCalls[0]!.target).toEqual(strictSsh);
    expect(checkedCalls[0]!.script).toContain("New-NetIPAddress");
    expect(checkedCalls[0]!.script).toContain("10.0.0.5");
    expect(checkedCalls[0]!.script).toContain("{ADAPTER-GUID}");
    expect(checkedCalls[0]!.script).not.toContain("Remove-NetIPAddress");
    expect(checkedCalls[1]!.target).toMatchObject({
      host: "10.0.0.5",
      sourceAddress: "10.0.0.6",
      bindInterface: "en8",
    });
    expect(checkedCalls[1]!.script).toContain("Remove-NetIPAddress");
    expect(checkedCalls[1]!.script).toContain("10.0.0.1");
    expect(checkedCalls[1]!.script).not.toContain("New-NetIPAddress");
  });

  test("recovery tries only Windows host aliases without Direct source binding and requires paired identity", async () => {
    const replacement = { ...windowsPayload, machineId: "REPLACEMENT-PC" };
    const { adapters, jsonCalls, checkedCalls } = harness([[replacement], [windowsPayload]]);

    await expect(adapters.recoveryChannel.observeRecovery(profile)).resolves.toMatchObject({
      kind: "pc-alive",
      windows: {
        machineId: "WINDOWS-UUID",
        selectedEthernet: {
          hardwareId: "{ADAPTER-GUID}",
          macAddress: "02-00-00-00-00-01",
        },
      },
    });

    expect(jsonCalls.map(({ target }) => target.host)).toEqual(["GAMING-PC", "gaming-pc.local"]);
    for (const { target } of jsonCalls) {
      expect(target).toMatchObject({
        identityFile: "/state/id_ed25519",
        knownHostsFile: "/state/known_hosts",
        hostKeyAlias: "[hardline-windows]:22",
      });
      expect(target).not.toHaveProperty("sourceAddress");
      expect(target).not.toHaveProperty("bindInterface");
    }
    expect(jsonCalls[0]!.script).toBe(jsonCalls[1]!.script);
    expect(checkedCalls).toEqual([]);

    const inaccessible = harness([[replacement], [replacement], [replacement]]);
    await expect(inaccessible.adapters.recoveryChannel.observeRecovery(profile)).resolves.toEqual({
      kind: "pc-inaccessible",
    });
  });

  test("uses explicit argv for Mac address mutation and delegates atomic persistence", async () => {
    const { adapters, macArgv, persisted } = harness();

    await adapters.macAddressing.addMacAddress("en8", "10.0.0.6", 30);
    await adapters.macAddressing.removeMacAddress("en8", "10.0.0.2", 30);
    await adapters.profilePersistence.persistProfileAtomically(profile);

    expect(macArgv).toEqual([
      ["sudo", "ifconfig", "en8", "alias", "10.0.0.6", "255.255.255.252"],
      ["sudo", "ifconfig", "en8", "-alias", "10.0.0.2"],
    ]);
    expect(persisted).toEqual([{ path: "/state/target-profile.json", value: profile }]);
  });

  test("keeps an injected persisted Windows stable ID inside its PowerShell literal", async () => {
    const injected = {
      ...profile,
      windows: {
        ...profile.windows,
        ethernet: { ...profile.windows.ethernet, hardwareId: "guid'; Remove-Item C:\\ -Recurse" },
      },
    };
    const { adapters, jsonCalls } = harness([[windowsPayload]], injected);

    await adapters.strictDirectProbe.probeDirect(injected);
    expect(jsonCalls[0]?.script).toContain(
      "'guid''; Remove-Item C:\\ -Recurse'",
    );
    expect(jsonCalls[0]?.script).not.toContain(
      "'guid'; Remove-Item C:\\ -Recurse",
    );
  });

  test("keeps an injected proposed address inside its PowerShell literal", async () => {
    const { adapters, checkedCalls } = harness();
    const injected = {
      ...profile,
      directLink: { ...profile.directLink, windowsAddress: "10.0.0.5'; whoami" },
    };

    await adapters.directLinkAddressing.addWindowsAddressOverDirectLink(profile, injected);
    expect(checkedCalls[0]?.script).toContain("'10.0.0.5''; whoami'");
    expect(checkedCalls[0]?.script).not.toContain("'10.0.0.5'; whoami");
  });
});
