import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readTargetProfile,
  removeTargetProfile,
  TargetResolution,
  TargetResolutionRefusedError,
  writeTargetProfile,
} from "../../src/target-resolution";
import type {
  TargetProfile,
  TargetResolutionDependencies,
} from "../../src/target-resolution";

let directory: string | undefined;

const installedProfile: TargetProfile = {
  version: 1,
  revision: 3,
  lifecycle: "installed",
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
    privateKeyPath: "/state/id_ed25519",
    publicKeyPath: "/state/id_ed25519.pub",
  },
  sshHostKey: {
    algorithm: "ssh-ed25519",
    publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
  installationCatalogVersion: "catalog-1",
};

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function setup(
  profile: TargetProfile | null = installedProfile,
  bootstrap?: (profilePath: string, events: string[]) => Promise<void>,
): Promise<{
  resolution: TargetResolution<{ host: string }>;
  dependencies: TargetResolutionDependencies<{ host: string }>;
  events: string[];
  profilePath: string;
}> {
  directory = await mkdtemp(join(tmpdir(), "hardline-resolution-"));
  const profilePath = join(directory, "target-profile.json");
  const manifestPath = join(directory, "manifest.json");
  if (profile) await writeTargetProfile(profilePath, profile);
  const events: string[] = [];
  let locked = false;
  const dependencies: TargetResolutionDependencies<{ host: string }> = {
    paths: { profile: profilePath, manifest: manifestPath },
    profiles: {
      read: readTargetProfile,
      async write(path, value) {
        expect(locked).toBe(true);
        events.push("profile:written");
        await writeTargetProfile(path, value);
      },
      async remove(path) {
        expect(locked).toBe(true);
        events.push("profile:removed");
        await removeTargetProfile(path);
      },
    },
    async acquireLock(path) {
      expect(path).toBe(manifestPath);
      locked = true;
      events.push("lock:acquired");
      return {
        async release() {
          events.push("lock:released");
          locked = false;
        },
      };
    },
    async validateProfile(value) {
      expect(locked).toBe(true);
      events.push("profile:validated");
      return value;
    },
    projectConfig(value) {
      expect(locked).toBe(true);
      events.push("config:projected");
      return { host: value.directLink.windowsAddress };
    },
    async removeManifest() {
      expect(locked).toBe(true);
      events.push("manifest:removed");
    },
    async removeIdentity() {
      expect(locked).toBe(true);
      events.push("identity:removed");
    },
    ...(bootstrap
      ? {
          bootstrapTarget: async () => bootstrap(profilePath, events),
        }
      : {}),
  };

  return {
    resolution: new TargetResolution(dependencies),
    dependencies,
    events,
    profilePath,
  };
}

test("an installed target is validated once and exposed while the shared lock is held", async () => {
  const { resolution, events } = await setup();
  let callbacks = 0;

  const outcome = await resolution.during("up", async (target) => {
    callbacks += 1;
    events.push("callback");
    expect(target.config).toEqual({ host: "10.77.0.1" });
    expect(target.resolution).toBe("validated");
    return { lifecycle: "unchanged", result: "streamed" };
  });

  expect(outcome).toEqual({ lifecycle: "unchanged", result: "streamed" });
  expect(callbacks).toBe(1);
  expect(events).toEqual([
    "lock:acquired",
    "profile:validated",
    "config:projected",
    "callback",
    "lock:released",
  ]);
});

test("absent and lifecycle-ineligible targets refuse before callback entry", async () => {
  const absent = await setup(null);
  let callbacks = 0;
  const callback = async () => {
    callbacks += 1;
    return { lifecycle: "unchanged", result: "unexpected" } as const;
  };

  await expect(absent.resolution.during("install", callback)).rejects.toMatchObject({
    name: "TargetResolutionRefusedError",
    reason: "profile-absent",
  });
  expect(absent.events).toEqual(["lock:acquired", "lock:released"]);

  const incomplete = await setup({
    ...installedProfile,
    lifecycle: "installation-incomplete",
  });
  await expect(incomplete.resolution.during("doctor", callback)).rejects.toBeInstanceOf(
    TargetResolutionRefusedError,
  );
  expect(incomplete.events).toEqual(["lock:acquired", "lock:released"]);
  expect(callbacks).toBe(0);
});

test("clean install bootstraps and persists a target before callback entry", async () => {
  const incomplete = {
    ...installedProfile,
    lifecycle: "installation-incomplete" as const,
  };
  const { resolution, events, profilePath } = await setup(
    null,
    async (path, log) => {
      log.push("bootstrap:start");
      await writeTargetProfile(path, incomplete);
      log.push("bootstrap:profile-persisted");
    },
  );

  const outcome = await resolution.during("install", async (target) => {
    events.push("callback");
    expect(await readTargetProfile(profilePath)).toEqual(incomplete);
    expect(target.profile.lifecycle).toBe("installation-incomplete");
    expect(target.resolution).toBe("bootstrapped");
    return { lifecycle: "installed", result: "installed" };
  });

  expect(outcome.result).toBe("installed");
  expect(events).toEqual([
    "lock:acquired",
    "bootstrap:start",
    "bootstrap:profile-persisted",
    "profile:validated",
    "config:projected",
    "callback",
    "profile:written",
    "lock:released",
  ]);
});

test("uninstall resumes a bootstrap-incomplete target before restoration callback", async () => {
  const bootstrapProfile: TargetProfile = {
    ...installedProfile,
    lifecycle: "bootstrap-incomplete",
    sshHostKey: null,
  };
  const resumable: TargetProfile = {
    ...installedProfile,
    lifecycle: "installation-incomplete",
  };
  const { resolution, events } = await setup(
    bootstrapProfile,
    async (path, log) => {
      log.push("bootstrap:resumed");
      await writeTargetProfile(path, resumable);
    },
  );

  const outcome = await resolution.during("uninstall", async (target) => {
    events.push("callback");
    expect(target.profile.lifecycle).toBe("installation-incomplete");
    return { lifecycle: "incomplete", result: "restoration started" };
  });

  expect(outcome.result).toBe("restoration started");
  expect(events.indexOf("bootstrap:resumed")).toBeLessThan(events.indexOf("callback"));
});

test("Link Recovery runs under the lock before projection and exposes recovered resolution", async () => {
  const { dependencies, events } = await setup();
  const resolution = new TargetResolution({
    ...dependencies,
    recoverLink: async (profile) => {
      events.push("link:recovered");
      return {
        profile: { ...profile, revision: profile.revision + 1 },
        resolution: "recovered",
      };
    },
  });

  await resolution.during("up", async (target) => {
    events.push("callback");
    expect(target.profile.revision).toBe(4);
    expect(target.resolution).toBe("recovered");
    return { lifecycle: "unchanged", result: null };
  });

  expect(events).toEqual([
    "lock:acquired",
    "profile:validated",
    "link:recovered",
    "config:projected",
    "callback",
    "lock:released",
  ]);
});

test("install captures bootstrap recovery durably before command callback", async () => {
  const { dependencies, events } = await setup({
    ...installedProfile,
    lifecycle: "installation-incomplete",
  });
  const resolution = new TargetResolution({
    ...dependencies,
    prepareOperation: async (_profile, intent) => {
      expect(intent).toBe("install");
      events.push("recovery:captured");
    },
  });

  await resolution.during("install", async () => {
    events.push("callback");
    return { lifecycle: "incomplete", result: null };
  });

  expect(events.indexOf("recovery:captured")).toBeLessThan(events.indexOf("callback"));
});

test("install atomically promotes an incomplete profile after the callback succeeds", async () => {
  const { resolution, events, profilePath } = await setup({
    ...installedProfile,
    lifecycle: "installation-incomplete",
  });

  const outcome = await resolution.during("install", async () => {
    events.push("callback");
    return { lifecycle: "installed", result: { status: "succeeded" } };
  });

  expect(outcome).toEqual({ lifecycle: "installed", result: { status: "succeeded" } });
  expect(await readTargetProfile(profilePath)).toEqual({
    ...installedProfile,
    revision: 4,
    lifecycle: "installed",
  });
  expect(events).toEqual([
    "lock:acquired",
    "profile:validated",
    "config:projected",
    "callback",
    "profile:written",
    "lock:released",
  ]);
});

test("an interrupted install records an incomplete lifecycle without changing its result", async () => {
  const { resolution, profilePath } = await setup();
  const outcome = await resolution.during("install", async () => ({
    lifecycle: "incomplete",
    result: { status: "incomplete", summary: "resume install" },
  }));

  expect(outcome.result).toEqual({ status: "incomplete", summary: "resume install" });
  expect(await readTargetProfile(profilePath)).toMatchObject({
    revision: 4,
    lifecycle: "installation-incomplete",
  });
});

test("an unexpected callback interruption records resumable lifecycle before rethrowing", async () => {
  const { resolution, profilePath, events } = await setup();

  await expect(
    resolution.during("install", async () => {
      events.push("callback");
      throw new Error("power lost");
    }),
  ).rejects.toThrow("power lost");

  expect(await readTargetProfile(profilePath)).toMatchObject({
    revision: 4,
    lifecycle: "installation-incomplete",
  });
  expect(events).toContain("profile:written");
});

test("ready-to-retire checkpoints retirement before terminal removal and removes the profile last", async () => {
  const { resolution, events, profilePath } = await setup({
    ...installedProfile,
    lifecycle: "uninstall-incomplete",
  });

  const outcome = await resolution.during("uninstall", async () => {
    events.push("callback");
    return { lifecycle: "ready-to-retire", result: "tail launched" };
  });

  expect(outcome).toEqual({ lifecycle: "ready-to-retire", result: "tail launched" });
  expect(await readTargetProfile(profilePath)).toBeNull();
  expect(events).toEqual([
    "lock:acquired",
    "profile:validated",
    "config:projected",
    "callback",
    "profile:written",
    "manifest:removed",
    "identity:removed",
    "profile:removed",
    "lock:released",
  ]);
});

test("terminal cleanup resumes without requiring a Direct Link that was already removed", async () => {
  const { dependencies, events, profilePath } = await setup({
    ...installedProfile,
    lifecycle: "retirement-incomplete",
  });
  const resolution = new TargetResolution({
    ...dependencies,
    recoverLink: async () => {
      throw new Error("must not recover a retired link");
    },
    prepareOperation: async () => {
      throw new Error("must not contact retired Windows target");
    },
  });

  await resolution.during("uninstall", async () => {
    events.push("callback");
    return { lifecycle: "terminal-incomplete", result: "retry local cleanup" };
  });

  expect(await readTargetProfile(profilePath)).toMatchObject({
    lifecycle: "retirement-incomplete",
    revision: 3,
  });
  expect(events).toContain("callback");
  expect(events).not.toContain("profile:written");
});

for (const checkpoint of [
  "lifecycle write",
  "manifest deletion",
  "identity deletion",
] as const) {
  test(`retirement resumes after failure following ${checkpoint}`, async () => {
    const initial = await setup({
      ...installedProfile,
      lifecycle: "uninstall-incomplete",
    });
    let manifestPresent = true;
    let identityPresent = true;
    let fail = true;
    const observations: Array<{ manifestPresent: boolean; identityPresent: boolean }> = [];
    const resolution = new TargetResolution({
      ...initial.dependencies,
      profiles: {
        ...initial.dependencies.profiles,
        async remove(path) {
          if (checkpoint === "identity deletion" && fail) {
            fail = false;
            throw new Error("interrupted after identity deletion");
          }
          await initial.dependencies.profiles.remove(path);
        },
      },
      async removeManifest() {
        if (checkpoint === "lifecycle write" && fail) {
          fail = false;
          throw new Error("interrupted after lifecycle write");
        }
        manifestPresent = false;
      },
      async removeIdentity() {
        if (checkpoint === "manifest deletion" && fail) {
          fail = false;
          throw new Error("interrupted after manifest deletion");
        }
        identityPresent = false;
      },
    });
    const retire = async (target: { profile: TargetProfile }) => {
      const expectedLifecycle =
        observations.length === 0 ? "uninstall-incomplete" : "retirement-incomplete";
      observations.push({ manifestPresent, identityPresent });
      expect(target.profile.lifecycle).toBe(expectedLifecycle);
      return { lifecycle: "ready-to-retire", result: "retired" } as const;
    };

    await expect(resolution.during("uninstall", retire)).rejects.toThrow("interrupted");
    expect(await readTargetProfile(initial.profilePath)).toMatchObject({
      lifecycle: "retirement-incomplete",
      revision: 4,
    });

    const outcome = await resolution.during("uninstall", retire);

    expect(outcome).toEqual({ lifecycle: "ready-to-retire", result: "retired" });
    expect(await readTargetProfile(initial.profilePath)).toBeNull();
    expect(initial.events.filter((event) => event === "profile:written")).toHaveLength(1);
    expect(observations).toEqual([
      { manifestPresent: true, identityPresent: true },
      checkpoint === "lifecycle write"
        ? { manifestPresent: true, identityPresent: true }
        : checkpoint === "manifest deletion"
          ? { manifestPresent: false, identityPresent: true }
          : { manifestPresent: false, identityPresent: false },
    ]);
  });
}
