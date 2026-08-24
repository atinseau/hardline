import { describe, expect, test } from "bun:test";
import type {
  BootstrapServerOptions,
  BootstrapWindowsObservations,
} from "../../src/lib/bootstrap-server";
import {
  BootstrapIdentityPathMismatchError,
  BootstrapResumeMismatchError,
  BootstrapWorkflow,
  BootstrapWorkflowTimeoutError,
  type BootstrapWorkflowDependencies,
} from "../../src/target-resolution/bootstrap-workflow";
import { BootstrapHostKeyConflictError } from "../../src/target-resolution/bootstrap-protocol";
import type { MacBootstrapObservations } from "../../src/target-resolution/bootstrap-target";
import type { TargetProfile } from "../../src/target-resolution/types";

const mac: MacBootstrapObservations = {
  machineId: "mac-platform-uuid",
  hostAliases: ["studio.local"],
  adapters: [{
    stableId: "en8",
    alias: "USB LAN",
    hardwareName: "USB GbE",
    macAddress: "02:00:00:00:00:02",
    speedMbps: 1000,
    physical: true,
    transport: "ethernet",
    virtual: false,
    linkState: "up",
    inUse: false,
    hasDefaultRoute: false,
  }],
  routes: ["192.168.1.0/24"],
  addresses: ["192.168.1.20/24"],
  activeIpv4Addresses: [],
};

const windows: BootstrapWindowsObservations = {
  computerName: "GAMING-PC",
  machineId: "windows-product-uuid",
  capturedAt: "2026-08-24T12:00:00.000Z",
  administrator: "GAMING-PC\\Arthur",
  activeIpv4Addresses: [],
  networkAdapters: [{
    alias: "Ethernet 2",
    interfaceIndex: 7,
    hardwareId: "{adapter-guid}",
    hardwareName: "USB GbE",
    macAddress: "02-00-00-00-00-01",
    speedMbps: 1000,
    physical: true,
    transport: "ethernet",
    virtual: false,
    linkState: "up",
    ipv4Addresses: ["169.254.10.4/16"],
  }],
  routes: [{
    interfaceIndex: 3,
    destinationPrefix: "192.168.1.0/24",
    nextHop: "0.0.0.0",
  }],
  openSsh: {
    capabilityState: "NotPresent",
    serviceStartType: null,
    serviceStatus: null,
    firewallRulePresent: false,
    administratorsAuthorizedKeysPresent: false,
  },
};

const identity = {
  privateKeyPath: "/state/id_ed25519",
  publicKeyPath: "/state/id_ed25519.pub",
};

const existing: TargetProfile = {
  version: 1,
  revision: 7,
  lifecycle: "bootstrap-incomplete",
  mac: {
    machineId: mac.machineId,
    hostAliases: ["studio.local"],
    ethernet: {
      hardwareId: "ether:02:00:00:00:00:02",
      macAddress: "02:00:00:00:00:02",
      interfaceId: "en8",
      serviceName: "USB LAN",
    },
  },
  windows: {
    machineId: windows.machineId,
    hostAliases: ["GAMING-PC"],
    administrator: windows.administrator,
    smbUser: windows.administrator,
    ethernet: {
      hardwareId: "{adapter-guid}",
      macAddress: "02-00-00-00-00-01",
      interfaceAlias: "Ethernet 2",
    },
  },
  directLink: {
    subnet: "10.0.0.0/30",
    macAddress: "10.0.0.2",
    windowsAddress: "10.0.0.1",
  },
  hardlineIdentity: identity,
  sshHostKey: null,
  installationCatalogVersion: "2026.08.24",
};

function harness(overrides: Partial<BootstrapWorkflowDependencies> = {}) {
  const log: string[] = [];
  const writes: TargetProfile[] = [];
  let serverOptions: BootstrapServerOptions | undefined;
  const dependencies: BootstrapWorkflowDependencies = {
    observeMac: async () => mac,
    ensureIdentity: async () => identity,
    readPublicKey: async () => "ssh-ed25519 AAAAC3 hardline",
    serve: async (options) => {
      serverOptions = options;
      return {
        url: "https://studio.local:4567",
        urls: ["https://studio.local:4567"],
        port: 4567,
        token: "ab".repeat(32),
        fingerprint: "FINGERPRINT",
        command: "one-paste-command",
        stop: async () => { log.push("stop"); },
      };
    },
    profiles: {
      read: async () => null,
      write: async (_path, profile) => {
        log.push(`write:${profile.lifecycle}:${profile.revision}`);
        writes.push(profile);
      },
      remove: async () => {},
    },
    profilePath: "/state/target-profile.json",
    installationCatalogVersion: "2026.08.24",
    now: () => 1_000,
    deadline: 10_000,
    reportCommand: async (command) => { log.push(`report:${command}`); },
    chooseEthernetCandidate: async (_machine, candidates) => candidates[0]!.stableId,
    ...overrides,
  };
  return {
    workflow: new BootstrapWorkflow(dependencies),
    dependencies,
    log,
    writes,
    options: () => serverOptions!,
  };
}

describe("BootstrapWorkflow", () => {
  test("reports one command and resolves only after both durable Bootstrap Rendezvous checkpoints", async () => {
    const fixture = harness();
    const running = fixture.workflow.run(null);
    await Bun.sleep(0);

    expect(fixture.log).toEqual(["report:one-paste-command"]);
    const plan = await fixture.options().prepareTarget(windows);
    expect(plan.ssh.installServer).toBe(true);
    expect(plan.ssh.administratorPublicKey).toBe("ssh-ed25519 AAAAC3 hardline");
    expect(fixture.log).toEqual([
      "report:one-paste-command",
      "write:bootstrap-incomplete:1",
    ]);

    let resolved = false;
    void running.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    await fixture.options().persistHostKey({
      machineId: windows.machineId,
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:host",
      publicKey: "ssh-ed25519 AAAAC3host windows-host",
    });
    await expect(running).resolves.toMatchObject({
      revision: 2,
      lifecycle: "installation-incomplete",
      sshHostKey: { algorithm: "ssh-ed25519", publicKey: "AAAAC3host" },
    });
    expect(fixture.log).toEqual([
      "report:one-paste-command",
      "write:bootstrap-incomplete:1",
      "write:installation-incomplete:2",
      "stop",
    ]);
    expect(fixture.writes).toHaveLength(2);
  });

  test("does not return the mutation plan until the bootstrap-incomplete profile is published", async () => {
    const published = Promise.withResolvers<void>();
    let writeStarted = false;
    const fixture = harness({
      profiles: {
        read: async () => null,
        write: async () => {
          writeStarted = true;
          await published.promise;
        },
        remove: async () => {},
      },
    });
    const running = fixture.workflow.run(null);
    await Bun.sleep(0);
    let planReturned = false;
    const preparing = Promise.resolve(fixture.options().prepareTarget(windows)).then((plan) => {
      planReturned = true;
      return plan;
    });
    await Promise.resolve();

    expect(writeStarted).toBe(true);
    expect(planReturned).toBe(false);
    published.resolve();
    await preparing;
    await fixture.options().persistHostKey({
      machineId: windows.machineId,
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:host",
      publicKey: "AAAAC3host",
    });
    await running;
  });

  test("refuses a stored profile bound to different Hardline Identity paths before serving", async () => {
    let served = false;
    const fixture = harness({
      observeMac: async () => { throw new Error("should not observe"); },
      serve: async () => {
        served = true;
        throw new Error("should not serve");
      },
    });

    await expect(fixture.workflow.run({
      ...existing,
      hardlineIdentity: {
        privateKeyPath: "/operator/.ssh/id_ed25519",
        publicKeyPath: "/operator/.ssh/id_ed25519.pub",
      },
    })).rejects.toBeInstanceOf(BootstrapIdentityPathMismatchError);
    expect(served).toBe(false);
  });

  test("refuses composite machine identities and selected hardware changes on resume", async () => {
    const macMismatch = harness({
      observeMac: async () => ({ ...mac, machineId: "different-mac" }),
    });
    await expect(macMismatch.workflow.run(existing)).rejects.toMatchObject({
      name: "BootstrapResumeMismatchError",
      machine: "mac",
      fact: "machine-id",
    });
    for (const [changedWindows, expected] of [
      [{ ...windows, machineId: "different-windows" }, { machine: "windows", fact: "machine-id" }],
      [{
        ...windows,
        networkAdapters: [{ ...windows.networkAdapters[0]!, hardwareId: "{replacement-adapter}" }],
      }, { machine: "windows", fact: "hardware-id" }],
      [{
        ...windows,
        networkAdapters: [{ ...windows.networkAdapters[0]!, macAddress: "02-00-00-00-00-99" }],
      }, { machine: "windows", fact: "hardware-id" }],
    ] as const) {
      const fixture = harness();
      const running = fixture.workflow.run(existing);
      await Bun.sleep(0);

      await expect(fixture.options().prepareTarget(changedWindows)).rejects.toBeInstanceOf(
        BootstrapResumeMismatchError,
      );
      await expect(running).rejects.toMatchObject(expected);
      expect(fixture.log.at(-1)).toBe("stop");
      expect(fixture.writes).toHaveLength(0);
    }
  });

  test("refuses a conflicting phase-one host key before authorizing a mutation plan", async () => {
    const fixture = harness();
    const running = fixture.workflow.run({
      ...existing,
      sshHostKey: { algorithm: "ssh-ed25519", publicKey: "AAAAC3persisted" },
    });
    await Bun.sleep(0);
    let planAuthorized = false;
    const completion = running.catch((error: unknown) => error);

    const preparing = Promise.resolve(fixture.options().prepareTarget({
      ...windows,
      openSsh: {
        ...windows.openSsh,
        hostKey: {
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:observed",
          publicKey: "ssh-ed25519 AAAAC3different windows-host",
        },
      },
    })).then(() => {
      planAuthorized = true;
    });

    await expect(preparing).rejects.toBeInstanceOf(BootstrapHostKeyConflictError);
    await expect(completion).resolves.toBeInstanceOf(BootstrapHostKeyConflictError);
    expect(planAuthorized).toBe(false);
    expect(fixture.writes).toHaveLength(0);
  });

  test("refuses a missing phase-one host key when resuming a profile with a persisted key", async () => {
    const fixture = harness();
    const running = fixture.workflow.run({
      ...existing,
      sshHostKey: { algorithm: "ssh-ed25519", publicKey: "AAAAC3persisted" },
    });
    await Bun.sleep(0);
    let planAuthorized = false;
    const completion = running.catch((error: unknown) => error);

    const preparing = Promise.resolve(fixture.options().prepareTarget(windows)).then(() => {
      planAuthorized = true;
    });

    await expect(preparing).rejects.toBeInstanceOf(BootstrapHostKeyConflictError);
    await expect(completion).resolves.toBeInstanceOf(BootstrapHostKeyConflictError);
    expect(planAuthorized).toBe(false);
    expect(fixture.writes).toHaveLength(0);
  });

  test("increments each durable revision while resuming the same target", async () => {
    const fixture = harness();
    const running = fixture.workflow.run(existing);
    await Bun.sleep(0);
    await fixture.options().prepareTarget(windows);
    await fixture.options().persistHostKey({
      machineId: windows.machineId,
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:host",
      publicKey: "AAAAC3host",
    });

    await expect(running).resolves.toMatchObject({
      revision: 9,
      lifecycle: "installation-incomplete",
    });
    expect(fixture.writes.map((profile) => profile.revision)).toEqual([8, 9]);
  });

  test("resume reauthorizes the persisted Direct Link instead of allocating around itself", async () => {
    const fixture = harness();
    const running = fixture.workflow.run(existing);
    await Bun.sleep(0);
    const plan = await fixture.options().prepareTarget({
      ...windows,
      networkAdapters: [{
        ...windows.networkAdapters[0]!,
        ipv4Addresses: [`${existing.directLink.windowsAddress}/30`],
      }],
      routes: [{
        interfaceIndex: 7,
        destinationPrefix: existing.directLink.subnet,
        nextHop: "0.0.0.0",
      }],
    });

    expect(plan.directLink).toEqual({
      interfaceAlias: "Ethernet 2",
      address: existing.directLink.windowsAddress,
      prefixLength: 30,
      networkCategory: "Private",
    });
    expect(fixture.writes[0]?.directLink).toEqual(existing.directLink);

    await fixture.options().persistHostKey({
      machineId: windows.machineId,
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:host",
      publicKey: "ssh-ed25519 AAAAC3host",
    });
    await running;
  });

  test("refuses a phase-two checkpoint from a different Windows machine", async () => {
    const fixture = harness();
    const running = fixture.workflow.run(existing);
    await Bun.sleep(0);
    await fixture.options().prepareTarget(windows);

    const checkpoint = fixture.options().persistHostKey({
      machineId: "different-windows",
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:host",
      publicKey: "AAAAC3host",
    });
    await expect(checkpoint).rejects.toBeInstanceOf(BootstrapResumeMismatchError);
    await expect(running).rejects.toMatchObject({
      machine: "windows",
      fact: "machine-id",
    });
    expect(fixture.writes.map((profile) => profile.revision)).toEqual([8]);
    expect(fixture.log.at(-1)).toBe("stop");
  });

  test("rejects with a typed timeout only after awaited server cleanup", async () => {
    const stopped = Promise.withResolvers<void>();
    let stopCalls = 0;
    const fixture = harness({
      deadline: 1_000,
      serve: async () => ({
        url: "https://studio.local:4567",
        urls: ["https://studio.local:4567"],
        port: 4567,
        token: "ab".repeat(32),
        fingerprint: "FINGERPRINT",
        command: "one-paste-command",
        stop: async () => {
          stopCalls += 1;
          await stopped.promise;
        },
      }),
    });
    const running = fixture.workflow.run(null);
    let settled = false;
    void running.catch(() => { settled = true; });
    await Bun.sleep(1);

    expect(stopCalls).toBe(1);
    expect(settled).toBe(false);
    stopped.resolve();
    await expect(running).rejects.toBeInstanceOf(BootstrapWorkflowTimeoutError);
    expect(stopCalls).toBe(1);
  });
});
