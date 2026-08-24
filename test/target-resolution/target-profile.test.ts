import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CorruptTargetProfileError,
  defaultTargetStatePaths,
  readTargetProfile,
  removeTargetProfile,
  UnsupportedTargetProfileVersionError,
  writeTargetProfile,
} from "../../src/target-resolution";
import type { TargetProfile } from "../../src/target-resolution";

let directory: string | undefined;
const PROFILE_DIGEST_ATTRIBUTE = "com.hardline.target-profile-sha256";

async function writeSignedProfile(path: string, value: unknown): Promise<void> {
  const source = Buffer.from(JSON.stringify(value));
  await writeFile(path, source);
  const digest = createHash("sha256").update(source).digest("hex");
  const process = Bun.spawn(
    ["/usr/bin/xattr", "-w", PROFILE_DIGEST_ATTRIBUTE, digest, "--", path],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (await process.exited !== 0) {
    throw new Error(await new Response(process.stderr).text());
  }
}

const profile: TargetProfile = {
  version: 1,
  revision: 7,
  lifecycle: "installed",
  mac: {
    machineId: "mac-platform-uuid",
    hostAliases: ["studio.local"],
    ethernet: {
      hardwareId: "ether:02:00:00:00:00:02",
      macAddress: "02:00:00:00:00:02",
      interfaceId: "en8",
      serviceName: "USB LAN",
    },
  },
  windows: {
    machineId: "windows-machine-guid",
    hostAliases: ["gaming-pc"],
    administrator: "Admin",
    smbUser: "Admin",
    ethernet: {
      hardwareId: "{adapter-guid}",
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
    privateKeyPath: "/state/id_ed25519",
    publicKeyPath: "/state/id_ed25519.pub",
  },
  sshHostKey: {
    algorithm: "ssh-ed25519",
    publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
  installationCatalogVersion: "2026.08.24",
};

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("an absent Target Profile means there is no resolved target", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-target-profile-"));

  expect(await readTargetProfile(join(directory, "target-profile.json"))).toBeNull();
});

test("a complete version-1 Target Profile is accepted", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-target-profile-"));
  const path = join(directory, "target-profile.json");
  await writeTargetProfile(path, profile);

  expect(await readTargetProfile(path)).toEqual(profile);
});

test("a bootstrap-incomplete profile may await its host-key checkpoint", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-target-profile-"));
  const path = join(directory, "target-profile.json");
  const incomplete = {
    ...profile,
    lifecycle: "bootstrap-incomplete" as const,
    sshHostKey: null,
  };

  await writeTargetProfile(path, incomplete);
  expect(await readTargetProfile(path)).toEqual(incomplete);

  await writeSignedProfile(path, { ...profile, sshHostKey: null });
  await expect(readTargetProfile(path)).rejects.toBeInstanceOf(CorruptTargetProfileError);
});

test("corrupt or manually extended Target Profiles are rejected with a typed error", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-target-profile-"));
  const path = join(directory, "target-profile.json");

  await writeSignedProfile(path, "not json");
  await expect(readTargetProfile(path)).rejects.toBeInstanceOf(CorruptTargetProfileError);

  await writeSignedProfile(path, { ...profile, operatorOverride: true });
  await expect(readTargetProfile(path)).rejects.toBeInstanceOf(CorruptTargetProfileError);
});

test("old positional aliases and volatile Mac hardware identity are rejected", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-target-profile-"));
  const path = join(directory, "target-profile.json");
  const oldSchema = {
    ...profile,
    mac: {
      machineId: profile.mac.machineId,
      aliases: [profile.mac.ethernet.serviceName, ...profile.mac.hostAliases],
      ethernet: {
        hardwareId: profile.mac.ethernet.interfaceId,
        macAddress: profile.mac.ethernet.macAddress,
      },
    },
    windows: {
      machineId: profile.windows.machineId,
      aliases: [profile.windows.ethernet.interfaceAlias, ...profile.windows.hostAliases],
      administrator: profile.windows.administrator,
      ethernet: {
        hardwareId: profile.windows.ethernet.hardwareId,
        macAddress: profile.windows.ethernet.macAddress,
      },
    },
  };

  for (const candidate of [
    oldSchema,
    {
      ...profile,
      mac: {
        ...profile.mac,
        ethernet: { ...profile.mac.ethernet, hardwareId: "en8" },
      },
    },
    {
      ...profile,
      mac: {
        ...profile.mac,
        ethernet: {
          ...profile.mac.ethernet,
          hardwareId: "ether:02:00:00:00:00:99",
        },
      },
    },
    {
      ...profile,
      windows: { ...profile.windows, smbUser: undefined },
    },
  ]) {
    await writeSignedProfile(path, candidate);
    await expect(readTargetProfile(path)).rejects.toBeInstanceOf(CorruptTargetProfileError);
  }
});

test("malformed addressing, identity, MAC, and SSH host-key fields are rejected", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-target-profile-"));
  const path = join(directory, "target-profile.json");
  const malformed = [
    { ...profile, directLink: { ...profile.directLink, subnet: "10.77.0.0/24" } },
    { ...profile, directLink: { ...profile.directLink, macAddress: "10.77.0.9" } },
    { ...profile, directLink: { ...profile.directLink, macAddress: "10.77.0.1" } },
    {
      ...profile,
      windows: {
        ...profile.windows,
        ethernet: { ...profile.windows.ethernet, macAddress: "not-a-mac" },
      },
    },
    {
      ...profile,
      windows: {
        ...profile.windows,
        ethernet: { ...profile.windows.ethernet, hardwareId: "guid'; Remove-Item C:\\" },
      },
    },
    { ...profile, sshHostKey: { ...profile.sshHostKey!, algorithm: "ssh-ed25519; whoami" } },
    { ...profile, sshHostKey: { ...profile.sshHostKey!, publicKey: "key'; whoami" } },
    {
      ...profile,
      pendingMigration: {
        operation: "migration" as const,
        oldLink: profile.directLink,
        proposedLink: { ...profile.directLink, windowsAddress: "192.168.1.1" },
      },
    },
    {
      ...profile,
      directLink: { subnet: "10.88.0.0/30", windowsAddress: "10.88.0.1", macAddress: "10.88.0.2" },
      pendingMigration: {
        operation: "migration" as const,
        oldLink: profile.directLink,
        proposedLink: { subnet: "10.99.0.0/30", windowsAddress: "10.99.0.1", macAddress: "10.99.0.2" },
      },
    },
  ];

  for (const candidate of malformed) {
    await writeSignedProfile(path, candidate);
    await expect(readTargetProfile(path)).rejects.toBeInstanceOf(CorruptTargetProfileError);
  }
});

test("a future Target Profile version is distinguishable from corruption", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-target-profile-"));
  const path = join(directory, "target-profile.json");
  await writeSignedProfile(path, { ...profile, version: 2 });

  await expect(readTargetProfile(path)).rejects.toBeInstanceOf(
    UnsupportedTargetProfileVersionError,
  );
});

test("Target Profile replacement is owner-only and leaves only the published file", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-target-profile-"));
  const path = join(directory, "state", "target-profile.json");
  await writeTargetProfile(path, profile);
  await writeTargetProfile(path, { ...profile, revision: 8 });

  expect((await readTargetProfile(path))?.revision).toBe(8);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(join(directory, "state"))).toEqual(["target-profile.json"]);
});

test("a schema-valid manual in-place edit is rejected", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-target-profile-"));
  const path = join(directory, "target-profile.json");
  await writeTargetProfile(path, profile);

  await writeFile(path, JSON.stringify({ ...profile, revision: 8 }));

  await expect(readTargetProfile(path)).rejects.toBeInstanceOf(CorruptTargetProfileError);
});

test("a Target Profile without its integrity attribute is rejected", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-target-profile-"));
  const path = join(directory, "target-profile.json");
  await writeFile(path, JSON.stringify(profile));

  await expect(readTargetProfile(path)).rejects.toBeInstanceOf(CorruptTargetProfileError);
});

test("a Target Profile with a malformed integrity attribute is rejected", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-target-profile-"));
  const path = join(directory, "target-profile.json");
  await writeTargetProfile(path, profile);
  const process = Bun.spawn(
    ["/usr/bin/xattr", "-w", PROFILE_DIGEST_ATTRIBUTE, "not-a-sha256", "--", path],
    { stdout: "ignore", stderr: "ignore" },
  );
  expect(await process.exited).toBe(0);

  await expect(readTargetProfile(path)).rejects.toBeInstanceOf(CorruptTargetProfileError);
});

test("removing a Target Profile is idempotent", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-target-profile-"));
  const path = join(directory, "target-profile.json");
  await writeTargetProfile(path, profile);

  await removeTargetProfile(path);
  await removeTargetProfile(path);

  expect(await readTargetProfile(path)).toBeNull();
});

test("default durable state is kept under the supplied home directory", () => {
  expect(defaultTargetStatePaths("/Users/operator")).toEqual({
    profile: "/Users/operator/.config/hardline/target-profile.json",
    manifest: "/Users/operator/.config/hardline/manifest.json",
  });
});
