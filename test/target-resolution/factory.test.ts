import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTALLATION_CATALOG,
  UnsupportedInstallationCatalogVersionError,
} from "../../src/installation-catalog";
import { readManifest } from "../../src/lib/manifest";
import {
  createTargetResolution,
  readTargetProfile,
  writeTargetProfile,
} from "../../src/target-resolution";
import type { TargetProfile } from "../../src/target-resolution";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function setupProfile(
  installationCatalogVersion: string = INSTALLATION_CATALOG.version,
): Promise<{ profile: TargetProfile; profilePath: string; manifestPath: string }> {
  directory = await mkdtemp(join(tmpdir(), "hardline-factory-"));
  const identityDirectory = join(directory, "identity");
  const profilePath = join(directory, "state", "target-profile.json");
  const manifestPath = join(directory, "state", "manifest.json");
  const profile: TargetProfile = {
    version: 1,
    revision: 8,
    lifecycle: "retirement-incomplete",
    mac: {
      machineId: "mac-id",
      hostAliases: ["mac.local"],
      ethernet: {
        hardwareId: "ether:02:00:00:00:00:02",
        macAddress: "02:00:00:00:00:02",
        interfaceId: "en8",
        serviceName: "USB LAN",
      },
    },
    windows: {
      machineId: "windows-id",
      hostAliases: ["pc"],
      administrator: "Admin",
      smbUser: "Admin",
      ethernet: {
        hardwareId: "adapter-id",
        macAddress: "02:00:00:00:00:01",
        interfaceAlias: "Ethernet 2",
      },
    },
    directLink: {
      subnet: "10.77.0.0/30",
      macAddress: "10.77.0.2",
      windowsAddress: "10.77.0.1",
    },
    hardlineIdentity: {
      privateKeyPath: join(identityDirectory, "id_ed25519"),
      publicKeyPath: join(identityDirectory, "id_ed25519.pub"),
    },
    sshHostKey: {
      algorithm: "ssh-ed25519",
      publicKey:
        "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
    installationCatalogVersion,
  };
  await writeTargetProfile(profilePath, profile);
  return { profile, profilePath, manifestPath };
}

function createResolution(profilePath: string, manifestPath: string) {
  return createTargetResolution({
    paths: { profile: profilePath, manifest: manifestPath },
    reportBootstrapCommand() {},
    chooseEthernetCandidate: (_machine, candidates) => candidates[0]!.stableId,
  });
}

test("production retirement validation accepts a removed identity and exposes an empty manifest", async () => {
  const { profile, profilePath, manifestPath } = await setupProfile();
  const resolution = createResolution(profilePath, manifestPath);

  const outcome = await resolution.during("uninstall", async (target) => {
    expect(target.profile).toEqual(profile);
    expect(await Bun.file(profile.hardlineIdentity.privateKeyPath).exists()).toBe(false);
    expect(await Bun.file(profile.hardlineIdentity.publicKeyPath).exists()).toBe(false);
    expect((await readManifest(target.manifestPath)).order).toEqual([]);
    return { lifecycle: "ready-to-retire", result: "retired" };
  });

  expect(outcome.result).toBe("retired");
  expect(await readTargetProfile(profilePath)).toBeNull();
  expect(await Bun.file(profile.hardlineIdentity.privateKeyPath).exists()).toBe(false);
});

test("production retirement validation still requires a known Installation Catalog", async () => {
  const { profilePath, manifestPath } = await setupProfile("unknown-catalog");
  const resolution = createResolution(profilePath, manifestPath);
  let callbacks = 0;

  await expect(
    resolution.during("uninstall", async () => {
      callbacks += 1;
      return { lifecycle: "ready-to-retire", result: null };
    }),
  ).rejects.toBeInstanceOf(UnsupportedInstallationCatalogVersionError);
  expect(callbacks).toBe(0);
  expect(await readTargetProfile(profilePath)).not.toBeNull();
});
