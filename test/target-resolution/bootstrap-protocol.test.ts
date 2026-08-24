import { describe, expect, test } from "bun:test";
import {
  BootstrapClosedError,
  BootstrapExpiredError,
  BootstrapHostKeyConflictError,
  BootstrapPhaseError,
  BootstrapProtocol,
  BootstrapReplayError,
  InvalidBootstrapTokenError,
  type MutationPlan,
  type WindowsObservations,
} from "../../src/target-resolution/bootstrap-protocol";

const TOKEN = "ab".repeat(32);

const observations: WindowsObservations = {
  computerName: "GAMING-PC",
  machineId: "machine-123",
  capturedAt: "2026-08-24T12:00:00.000Z",
  activeIpv4Addresses: [],
  networkAdapters: [
    {
      alias: "Ethernet",
      interfaceIndex: 7,
      macAddress: "00-11-22-33-44-55",
      ipv4Addresses: ["192.168.1.20/24"],
    },
  ],
  openSsh: {
    capabilityState: "NotPresent",
    serviceStartType: null,
    serviceStatus: null,
    firewallRulePresent: false,
    administratorsAuthorizedKeysPresent: false,
  },
};

const plan: MutationPlan = {
  directLink: {
    interfaceAlias: "Ethernet",
    address: "10.10.10.1",
    prefixLength: 24,
    networkCategory: "Private",
  },
  ssh: {
    installServer: true,
    startService: true,
    openFirewall: true,
    administratorPublicKey: "ssh-ed25519 AAAA hardline",
  },
};

function protocol() {
  return new BootstrapProtocol({
    token: TOKEN,
    expiresAt: 2_000,
    now: () => 1_000,
    prepareTarget: async () => plan,
    persistHostKey: async () => {},
  });
}

describe("BootstrapProtocol", () => {
  test("the first claim binds the token to its nonce and retries retrieve the same response", () => {
    const rendezvous = protocol();
    const request = { token: TOKEN, clientNonce: "nonce-a", observations };

    const first = rendezvous.claim(request);
    const retry = rendezvous.claim(request);

    expect(retry).toBe(first);
    expect(first).toEqual({ kind: "observations-accepted" });
    expect(() =>
      rendezvous.claim({ ...request, clientNonce: "nonce-b" }),
    ).toThrow(BootstrapReplayError);
    expect(() =>
      rendezvous.authorizePlan({ token: TOKEN, clientNonce: "nonce-b" }),
    ).toThrow(BootstrapReplayError);
  });

  test("accepts only the provisioned 256-bit token before its absolute expiry", () => {
    expect(
      () =>
        new BootstrapProtocol({
          token: "too-short",
          expiresAt: 2_000,
          now: () => 1_000,
          prepareTarget: async () => plan,
          persistHostKey: async () => {},
        }),
    ).toThrow(InvalidBootstrapTokenError);

    let now = 1_999;
    const rendezvous = new BootstrapProtocol({
      token: TOKEN,
      expiresAt: 2_000,
      now: () => now,
      prepareTarget: async () => plan,
      persistHostKey: async () => {},
    });
    const request = { token: TOKEN, clientNonce: "nonce-a", observations };

    expect(() => rendezvous.claim({ ...request, token: "cd".repeat(32) })).toThrow(
      InvalidBootstrapTokenError,
    );
    rendezvous.claim(request);
    now = 2_000;
    expect(() => rendezvous.claim(request)).toThrow(BootstrapExpiredError);
    expect(() =>
      rendezvous.authorizePlan({ token: TOKEN, clientNonce: "nonce-a" }),
    ).toThrow(BootstrapExpiredError);
  });

  test("authorizes the mutation plan only after target persistence succeeds", async () => {
    const log: string[] = [];
    const persisted = Promise.withResolvers<void>();
    const rendezvous = new BootstrapProtocol({
      token: TOKEN,
      expiresAt: 2_000,
      now: () => 1_000,
      prepareTarget: async (received) => {
        log.push(`persist-target:start:${received.machineId}`);
        await persisted.promise;
        log.push("persist-target:end");
        return plan;
      },
      persistHostKey: async () => {},
    });
    rendezvous.claim({ token: TOKEN, clientNonce: "nonce-a", observations });

    let authorized = false;
    const authorization = rendezvous
      .authorizePlan({ token: TOKEN, clientNonce: "nonce-a" })
      .then((response) => {
        authorized = true;
        log.push("plan:authorized");
        return response;
      });
    await Promise.resolve();

    expect(authorized).toBe(false);
    expect(log).toEqual(["persist-target:start:machine-123"]);

    persisted.resolve();
    const response = await authorization;
    const retry = await rendezvous.authorizePlan({
      token: TOKEN,
      clientNonce: "nonce-a",
    });

    expect(response).toEqual({ kind: "plan-authorized", plan });
    expect(retry).toBe(response);
    expect(log).toEqual([
      "persist-target:start:machine-123",
      "persist-target:end",
      "plan:authorized",
    ]);
  });

  test("does not advance phases when target persistence fails", async () => {
    const log: string[] = [];
    const rendezvous = new BootstrapProtocol({
      token: TOKEN,
      expiresAt: 2_000,
      now: () => 1_000,
      prepareTarget: async () => {
        log.push("persist-target");
        if (log.length === 1) throw new Error("disk unavailable");
        return plan;
      },
      persistHostKey: async () => {},
    });
    const authorization = { token: TOKEN, clientNonce: "nonce-a" };

    expect(() => rendezvous.authorizePlan(authorization)).toThrow(
      BootstrapPhaseError,
    );
    rendezvous.claim({ ...authorization, observations });
    await expect(rendezvous.authorizePlan(authorization)).rejects.toThrow(
      "disk unavailable",
    );

    await expect(rendezvous.authorizePlan(authorization)).resolves.toEqual({
      kind: "plan-authorized",
      plan,
    });
    expect(log).toEqual(["persist-target", "persist-target"]);
  });

  test("authorizes SSH only after the host-key checkpoint is persisted and completes idempotently", async () => {
    const log: string[] = [];
    const persisted = Promise.withResolvers<void>();
    const rendezvous = new BootstrapProtocol({
      token: TOKEN,
      expiresAt: 2_000,
      now: () => 1_000,
      prepareTarget: async () => {
        log.push("persist-target");
        return plan;
      },
      persistHostKey: async (checkpoint) => {
        log.push(`persist-host-key:start:${checkpoint.fingerprint}`);
        expect(checkpoint.machineId).toBe("machine-123");
        await persisted.promise;
        log.push("persist-host-key:end");
      },
    });
    const authorization = { token: TOKEN, clientNonce: "nonce-a" };
    const completion = {
      ...authorization,
      hostKey: {
        algorithm: "ssh-ed25519" as const,
        fingerprint: "SHA256:host-fingerprint",
        publicKey: "ssh-ed25519 AAAAC3 host",
      },
    };
    rendezvous.claim({ ...authorization, observations });

    expect(() => rendezvous.complete(completion)).toThrow(BootstrapPhaseError);
    await rendezvous.authorizePlan(authorization);
    let sshAuthorized = false;
    const completing = rendezvous.complete(completion).then((response) => {
      sshAuthorized = true;
      log.push("ssh:authorized");
      return response;
    });
    await Promise.resolve();

    expect(sshAuthorized).toBe(false);
    expect(log).toEqual([
      "persist-target",
      "persist-host-key:start:SHA256:host-fingerprint",
    ]);
    expect(() =>
      rendezvous.complete({
        ...completion,
        hostKey: {
          ...completion.hostKey,
          fingerprint: "SHA256:different-host",
        },
      }),
    ).toThrow(BootstrapHostKeyConflictError);

    persisted.resolve();
    const response = await completing;
    const retry = await rendezvous.complete(completion);

    expect(response.kind).toBe("ssh-authorized");
    expect(response.hostKey.fingerprint).toBe("SHA256:host-fingerprint");
    expect(retry).toBe(response);
    expect(log).toEqual([
      "persist-target",
      "persist-host-key:start:SHA256:host-fingerprint",
      "persist-host-key:end",
      "ssh:authorized",
    ]);
  });

  test("close is idempotent and rejects all further protocol work", () => {
    const rendezvous = protocol();
    const claim = { token: TOKEN, clientNonce: "nonce-a", observations };

    rendezvous.close();
    rendezvous.close();

    expect(() => rendezvous.claim(claim)).toThrow(BootstrapClosedError);
    expect(() =>
      rendezvous.authorizePlan({ token: TOKEN, clientNonce: "nonce-a" }),
    ).toThrow(BootstrapClosedError);
    expect(() =>
      rendezvous.complete({
        token: TOKEN,
        clientNonce: "nonce-a",
        hostKey: {
          algorithm: "ssh-ed25519",
          fingerprint: "SHA256:host-fingerprint",
          publicKey: "ssh-ed25519 AAAAC3 host",
        },
      }),
    ).toThrow(BootstrapClosedError);
  });
});
