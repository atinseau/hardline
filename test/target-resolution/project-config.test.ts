import { expect, test } from "bun:test";
import { INSTALLATION_CATALOG } from "../../src/installation-catalog";
import { projectTargetConfig } from "../../src/target-resolution/project-config";
import type { TargetProfile } from "../../src/target-resolution";

const profile: TargetProfile = {
  version: 1,
  revision: 2,
  lifecycle: "installed",
  mac: {
    machineId: "mac-id",
    hostAliases: ["studio.local"],
    ethernet: {
      hardwareId: "ether:00:11:22:33:44:55",
      macAddress: "00:11:22:33:44:55",
      interfaceId: "en8",
      serviceName: "USB LAN",
    },
  },
  windows: {
    machineId: "windows-id",
    hostAliases: ["GAMING-PC"],
    administrator: "GAMING-PC\\Arthur",
    smbUser: "GAMING-PC\\ShareUser",
    ethernet: {
      hardwareId: "{adapter-guid}",
      macAddress: "00-11-22-33-44-66",
      interfaceAlias: "Ethernet 2",
    },
  },
  directLink: {
    subnet: "10.0.0.0/30",
    windowsAddress: "10.0.0.1",
    macAddress: "10.0.0.2",
  },
  hardlineIdentity: {
    privateKeyPath: "/Users/operator/Library/Application Support/Hardline/id_ed25519",
    publicKeyPath: "/Users/operator/Library/Application Support/Hardline/id_ed25519.pub",
  },
  sshHostKey: { algorithm: "ssh-ed25519", publicKey: "AAAAC3Host" },
  installationCatalogVersion: INSTALLATION_CATALOG.version,
};

test("projects command-only Config from the validated Target Profile and fixed catalog", () => {
  const config = projectTargetConfig(profile);

  expect(config.mac).toEqual({
    serviceName: "USB LAN",
    ip: "10.0.0.2",
    subnetMask: "255.255.255.252",
  });
  expect(config.windows).toEqual({
    interfaceAlias: "Ethernet 2",
    ip: "10.0.0.1",
    prefixLength: 30,
  });
  expect(config.ssh).toEqual({
    host: "10.0.0.1",
    user: "Arthur",
    identityFile: profile.hardlineIdentity.privateKeyPath,
    connectTimeoutSec: 8,
    knownHostsFile: "/Users/operator/Library/Application Support/Hardline/known_hosts",
    hostKeyAlias: "[hardline-windows]:22",
    sourceAddress: "10.0.0.2",
    bindInterface: "en8",
  });
  expect(config.apollo).toEqual(INSTALLATION_CATALOG.apollo);
  expect(config.moonlight).toEqual(INSTALLATION_CATALOG.moonlight);
  expect(config.smb.user).toBe("ShareUser");
  expect(config.smb.shares).toEqual([]);
});

test("refuses to project an incomplete trust checkpoint", () => {
  expect(() => projectTargetConfig({ ...profile, sshHostKey: null })).toThrow(
    "SSH host key",
  );
});
