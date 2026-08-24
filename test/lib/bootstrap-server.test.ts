import { createHash, X509Certificate } from "node:crypto";
import { stat } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import type {
  MutationPlan,
  WindowsObservations,
} from "../../src/target-resolution/bootstrap-protocol";
import {
  loadBootstrapTemplate,
  localBootstrapCommand,
  serveBootstrap,
  type BootstrapWindowsObservations,
  type CertificateGenerator,
} from "../../src/lib/bootstrap-server";

const BOOTSTRAP_SCRIPT = await loadBootstrapTemplate();

const CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUV4UdOIttO1RMj++TdE5IymtyDWkwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgyNDExMjkyM1oXDTI2MDgy
NTExMjkyM1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAz8lBpuLKFcI4E95Ha2tFoAZms6F0wZiAcsrExveGZjtK
FP4okCtSZlvIhLpf5Pd137HqoaryAEw8cmhJ38s5LxGFB7Yylg4wbAUsaKXiMK/i
/a389DyVqFA/Aq70uDmapMnEqrfCujTG/X30UQ+6viNEiWlvARhau2SO9eGgu32j
MMV4ql32enpotjDYMBaAbwraawdbhpnfJtL6f0TlJ8qa7qSgxTyMkSm+HyOhlUwN
lnf4FxKFEmrk2digF4ZGnA1Z7NflsyPieKjQBtGutlqnrgKjVw5RCV+JwSh4dg0l
ybrgWZ4p7tSeRf/887j7rIOlbLLl0KiztUkkseQS+wIDAQABo28wbTAdBgNVHQ4E
FgQUHSdkhsN00MeA8yB3B2co4o/g6/YwHwYDVR0jBBgwFoAUHSdkhsN00MeA8yB3
B2co4o/g6/YwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAIs+k0Q4cegZQh5DRbBrFvLqUKHTGABM
PcMQsmFTvxm9GiXEo4no7lcQOBAe4b5tVBrGEPbOWqqeUFRolFJYgynzWyA3QPWz
CN+hCc9Pbz3scXPb31a2VA/1jCMcIN8K0+2glWf8adCjHFFQseK6igZUxYRq/95P
xZzMvHGcsiFs9aEjYUDlEO03apzQ50hqY80m2w9AFDfN9Gg9CVFjKNM92wxHz/34
9Uupe3pUcbvXiCXYH5rOctbycOVdc7tWo1Og52FSkTg9xKXFUq7gNUHZu9YFI/fP
yIyTE/cRCad0VifwgSGVcUgyNYpeAtdcTQT7Qtu9wzkOc55IfsKIwSg=
-----END CERTIFICATE-----`;

const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDPyUGm4soVwjgT
3kdra0WgBmazoXTBmIByysTG94ZmO0oU/iiQK1JmW8iEul/k93XfseqhqvIATDxy
aEnfyzkvEYUHtjKWDjBsBSxopeIwr+L9rfz0PJWoUD8CrvS4OZqkycSqt8K6NMb9
ffRRD7q+I0SJaW8BGFq7ZI714aC7faMwxXiqXfZ6emi2MNgwFoBvCtprB1uGmd8m
0vp/ROUnyprupKDFPIyRKb4fI6GVTA2Wd/gXEoUSauTZ2KAXhkacDVns1+WzI+J4
qNAG0a62WqeuAqNXDlEJX4nBKHh2DSXJuuBZninu1J5F//zzuPusg6VssuXQqLO1
SSSx5BL7AgMBAAECggEAXFO4fM+b7PQqV8W2ZWg6fUMq4ll1GErLlHY93o0A5q8k
mVRfsMPXLs1MuZFY59P/R+D1+VUMiA5X85wcazkRVTVLL6SJMLzoTi80TuGasniM
+5ySX/IFq87QWMBl0/Ago2VWImdZusSVwPB1HYnIOBFStF4paUqpkke58E6LzZLV
bf5KfYqcmhMGaBXpzWtgeoGkW2ttpOwE9LLM/hEOlw53j1CeeoSzabjcjohPjs7y
aaXSFq8tKgwapOQKi3AxMmLgEvUpXfGZ+hK33A6OnLbVtOZ2Q2xSjnqtFUDilUeM
oz1BsWFWXGO3C5QTqPukm+bkzQE+V4O2fjrCWDnhzQKBgQD/ETSAq6wFXC9i5JCf
wBjCWm1X23bBNfTxFdKd2TpXwT04StqXs/XhCk8pY/fXX1rlFDK3D08ZKQgPbidj
NyVvIQ7SIJTPdwFbWad8fQF+C+0m5kXPTXsrIaQmmhkEz3NoHQs3fUyuu8bazDJv
hmsDekNuLOj+LUJVYu+2MIYFjwKBgQDQi8lir0V43kMkR2WYCGwSOIRTJ4vqpiYn
uZyU69v/d8zCT3a7sRiNgGhWty5bKBiXzYY6Bhhab/4NIlDurQFy4jj9yL5aKrhW
QSXfEC0vUF0joevgZy1Ex/jkth82DybEji/AFLwQ+Z8Bb94zW4/Br9uCEP019t7Y
bhL5npvd1QKBgDkSWHUR9IOehNvT2KhmCyQxp5Wo/YFt2Ui4YVAAcxV/n3shBJg9
JB8ed2gDfkkqhOQNCOv8+O3gSHVraFTC2hVriC1sLN/e+Oa/wMISFmtlr8Ksc6JW
6+BSvrAEeuSgpmn9Va0s1COk0HHUjtR1dyxoBv53/gohhl4krQ5O/S3xAoGAXYWy
pEzRrOiP158lEk8EmA88WEYt2ubzyXDVpXs4R5KkAqe8KWO8DQj+wZSYd0y96qXC
ghblqPj8R0uSW9a+BZUp1bXGl4z86cGBiE0q1kMF4crlitb6WBQNrBN4X7ffvNm+
1Db4N+yZv/04+nMfPs7sc6HGzAKP4SNL4yGb6JkCgYADwcde4KxP9rJxUuQEf/4k
hrihuniOjBEHHzwKwX/QP6/Uk5Lg4zu1M4pfGBYpL7i0NUoovTJjEAlrHGSdqQnL
leb+K0YWwxfGq5yTsRW1UhBZGcr1V7TDoBa1oOBcesJQBTLudbYdoSxwhPT68y/3
30JMjqpZs/yVL0ZdarsyZQ==
-----END PRIVATE KEY-----`;

const OBSERVATIONS: WindowsObservations = {
  computerName: "GAMING-PC",
  machineId: "machine-123",
  capturedAt: "2026-08-24T12:00:00.000Z",
  activeIpv4Addresses: [],
  networkAdapters: [{
    alias: "Ethernet",
    interfaceIndex: 7,
    macAddress: "00-11-22-33-44-55",
    ipv4Addresses: ["192.168.1.20/24"],
  }],
  openSsh: {
    capabilityState: "NotPresent",
    serviceStartType: null,
    serviceStatus: null,
    firewallRulePresent: false,
    administratorsAuthorizedKeysPresent: false,
  },
};

const BOOTSTRAP_OBSERVATIONS: BootstrapWindowsObservations = {
  ...OBSERVATIONS,
  administrator: "GAMING-PC\\Arthur",
  networkAdapters: [{
    alias: "Ethernet",
    interfaceIndex: 7,
    hardwareId: "{adapter-guid}",
    hardwareName: "USB GbE",
    macAddress: "00-11-22-33-44-55",
    speedMbps: 1000,
    physical: true,
    transport: "ethernet",
    virtual: false,
    linkState: "up",
    ipv4Addresses: ["192.168.1.20/24"],
  }],
  routes: [{
    interfaceIndex: 7,
    destinationPrefix: "0.0.0.0/0",
    nextHop: "192.168.1.1",
  }],
};

const PLAN: MutationPlan = {
  directLink: {
    interfaceAlias: "Ethernet",
    address: "10.10.10.2",
    prefixLength: 30,
    networkCategory: "Private",
  },
  ssh: {
    installServer: true,
    startService: true,
    openFirewall: true,
    administratorPublicKey: "ssh-ed25519 AAAA hardline",
  },
};

function fixtureGenerator(onDirectory: (directory: string) => void): CertificateGenerator {
  return async ({ certPath, keyPath, directory }) => {
    onDirectory(directory);
    await Promise.all([
      Bun.write(certPath, CERTIFICATE),
      Bun.write(keyPath, PRIVATE_KEY),
    ]);
  };
}

function httpsFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, tls: { rejectUnauthorized: false } });
}

function authenticated(token: string, body?: unknown): RequestInit {
  return {
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

describe("localBootstrapCommand", () => {
  test("renders one pasteable command with exact per-client certificate pinning", () => {
    const command = localBootstrapCommand({
      urls: ["https://mac.local:7443", "https://169.254.10.2:7443"],
      token: "ab".repeat(32),
      fingerprint: "12AB34CD",
    });

    expect(command).not.toContain("\n");
    expect(command).toContain("$HardlineUrls=@('https://mac.local:7443','https://169.254.10.2:7443')");
    expect(command).toContain("foreach($candidate in $HardlineUrls)");
    expect(command).toContain(`$HardlineToken='${"ab".repeat(32)}'`);
    expect(command).toContain("$HardlineFingerprint='12AB34CD'");
    expect(command).toContain("ServerCertificateCustomValidationCallback");
    expect(command).toContain("StringComparer.Ordinal.Equals(c.GetCertHashString(HashAlgorithmName.SHA256),fingerprint)");
    expect(command).toContain("[HardlinePinnedClient]::Create($HardlineFingerprint,$HardlineToken)");
    expect(command).not.toContain("ServicePointManager");
    expect(command).not.toContain("DangerousAcceptAnyServerCertificateValidator");
    expect(command).not.toContain("-SkipCertificateCheck");
  });
});

describe("bootstrap.ps1", () => {
  test("observes and obtains authorization before recovery capture and mutation", () => {
    const phaseOne = BOOTSTRAP_SCRIPT.indexOf("/phase-one");
    const recovery = BOOTSTRAP_SCRIPT.indexOf("Move-Item -Path $recoveryTemp");
    const firstMutation = Math.min(
      ...[
        "Add-WindowsCapability",
        "Set-Service -Name sshd",
        "New-NetFirewallRule",
        "Add-Content -Path $keyFile",
        "New-NetIPAddress",
        "Set-NetConnectionProfile",
      ].map((statement) => {
        const index = BOOTSTRAP_SCRIPT.indexOf(statement);
        expect(index).toBeGreaterThan(0);
        return index;
      }),
    );

    expect(BOOTSTRAP_SCRIPT).toContain("Get-NetAdapter -Physical");
    expect(BOOTSTRAP_SCRIPT).toContain("Get-NetRoute -AddressFamily IPv4");
    expect(BOOTSTRAP_SCRIPT).toContain("[System.Security.Principal.WindowsIdentity]::GetCurrent().Name");
    expect(phaseOne).toBeGreaterThan(0);
    expect(recovery).toBeGreaterThan(phaseOne);
    expect(firstMutation).toBeGreaterThan(recovery);
  });

  test("mutates from the authorized plan and completes with the SSH host key", () => {
    expect(BOOTSTRAP_SCRIPT).toContain("$plan = $authorization.plan");
    expect(BOOTSTRAP_SCRIPT).toContain(
      "$authorizedAlias = [string]$plan.directLink.interfaceAlias",
    );
    expect(BOOTSTRAP_SCRIPT).toContain("$alias = [string]$adapter.Name");
    expect(BOOTSTRAP_SCRIPT).toContain("$publicKey = [string]$plan.ssh.administratorPublicKey");
    expect(BOOTSTRAP_SCRIPT).not.toMatch(/@@[A-Z_]+@@/);
    expect(BOOTSTRAP_SCRIPT.indexOf("$currentHostKey =")).toBeLessThan(
      BOOTSTRAP_SCRIPT.indexOf("/phase-one"),
    );
    expect(BOOTSTRAP_SCRIPT.indexOf("/phase-two")).toBeGreaterThan(
      BOOTSTRAP_SCRIPT.indexOf("ssh_host_ed25519_key.pub"),
    );
  });

  test("is ASCII and never weakens TLS validation", () => {
    expect([...BOOTSTRAP_SCRIPT].filter((character) => character.charCodeAt(0) > 127)).toEqual([]);
    expect(BOOTSTRAP_SCRIPT).not.toContain("ServerCertificateValidationCallback");
    expect(BOOTSTRAP_SCRIPT).not.toContain("-SkipCertificateCheck");
  });
});

describe("serveBootstrap", () => {
  test("serves the two phases over HTTPS and cleans up idempotently", async () => {
    const log: string[] = [];
    let directory = "";
    const rendezvous = await serveBootstrap({
      port: 0,
      advertiseHost: "localhost",
      advertiseHosts: ["localhost", "169.254.10.2"],
      expiresAt: Date.now() + 60_000,
      template: "# bootstrap fixture",
      certificateGenerator: fixtureGenerator((value) => { directory = value; }),
      prepareTarget: (value) => {
        log.push(`target:${value.machineId}`);
        return PLAN;
      },
      persistHostKey: (value) => { log.push(`host:${value.fingerprint}`); },
    });

    try {
      expect(rendezvous.url).toMatch(/^https:\/\/localhost:\d+$/);
      expect(rendezvous.urls[1]).toMatch(/^https:\/\/169\.254\.10\.2:\d+$/);
      expect(rendezvous.token).toMatch(/^[0-9a-f]{64}$/);
      const expectedFingerprint = createHash("sha256")
        .update(new X509Certificate(CERTIFICATE).raw)
        .digest("hex")
        .toUpperCase();
      expect(rendezvous.fingerprint).toBe(expectedFingerprint);
      expect(rendezvous.command).toContain(expectedFingerprint);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);

      const script = await httpsFetch(
        `${rendezvous.url}/bootstrap.ps1`,
        authenticated(rendezvous.token),
      );
      expect(script.status).toBe(200);
      expect(await script.text()).toBe("# bootstrap fixture");

      const earlyCompletion = await httpsFetch(`${rendezvous.url}/phase-two`, {
        method: "POST",
        ...authenticated(rendezvous.token, {
          clientNonce: "nonce-a",
          hostKey: {
            algorithm: "ssh-ed25519",
            fingerprint: "SHA256:host",
            publicKey: "ssh-ed25519 AAAA host",
          },
        }),
      });
      expect(earlyCompletion.status).toBe(409);

      const phaseOne = await httpsFetch(`${rendezvous.url}/phase-one`, {
        method: "POST",
        ...authenticated(rendezvous.token, {
          clientNonce: "nonce-a",
          observations: BOOTSTRAP_OBSERVATIONS,
        }),
      });
      expect(phaseOne.status).toBe(200);
      expect(await phaseOne.json()).toEqual({ kind: "plan-authorized", plan: PLAN });
      expect(log).toEqual(["target:machine-123"]);

      const phaseTwo = await httpsFetch(`${rendezvous.url}/phase-two`, {
        method: "POST",
        ...authenticated(rendezvous.token, {
          clientNonce: "nonce-a",
          hostKey: {
            algorithm: "ssh-ed25519",
            fingerprint: "SHA256:host",
            publicKey: "ssh-ed25519 AAAA host",
          },
        }),
      });
      expect(phaseTwo.status).toBe(200);
      expect((await phaseTwo.json() as { kind: string }).kind).toBe("ssh-authorized");
      expect(log).toEqual(["target:machine-123", "host:SHA256:host"]);
    } finally {
      await rendezvous.stop();
      await rendezvous.stop();
    }

    await expect(stat(directory)).rejects.toThrow();
    await expect(httpsFetch(`${rendezvous.url}/bootstrap.ps1`)).rejects.toThrow();
  });

  test("rejects missing and wrong tokens without revealing credentials", async () => {
    const rendezvous = await serveBootstrap({
      port: 0,
      advertiseHost: "localhost",
      expiresAt: Date.now() + 60_000,
      template: "secret script",
      certificateGenerator: fixtureGenerator(() => {}),
      prepareTarget: () => PLAN,
      persistHostKey: () => {},
    });
    try {
      for (const authorization of [undefined, "Bearer wrong"]) {
        const response = await httpsFetch(`${rendezvous.url}/bootstrap.ps1`, {
          headers: authorization === undefined ? {} : { authorization },
        });
        expect(response.status).toBe(401);
        const body = await response.text();
        expect(body).not.toContain(rendezvous.token);
        expect(body).not.toContain("secret script");
      }
    } finally {
      await rendezvous.stop();
    }
  });

  test("enforces methods, JSON content type, schemas, and body limits", async () => {
    const rendezvous = await serveBootstrap({
      port: 0,
      advertiseHost: "localhost",
      expiresAt: Date.now() + 60_000,
      certificateGenerator: fixtureGenerator(() => {}),
      prepareTarget: () => PLAN,
      persistHostKey: () => {},
    });
    try {
      const wrongMethod = await httpsFetch(`${rendezvous.url}/phase-one`, {
        ...authenticated(rendezvous.token),
        method: "GET",
      });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("POST");

      const wrongType = await httpsFetch(`${rendezvous.url}/phase-one`, {
        method: "POST",
        headers: { authorization: `Bearer ${rendezvous.token}` },
        body: "{}",
      });
      expect(wrongType.status).toBe(415);

      const unknownField = await httpsFetch(`${rendezvous.url}/phase-one`, {
        method: "POST",
        ...authenticated(rendezvous.token, {
          clientNonce: "nonce-a",
          observations: BOOTSTRAP_OBSERVATIONS,
          extra: true,
        }),
      });
      expect(unknownField.status).toBe(400);

      const oversized = await httpsFetch(`${rendezvous.url}/phase-one`, {
        method: "POST",
        ...authenticated(rendezvous.token, { padding: "x".repeat(65 * 1024) }),
      });
      expect(oversized.status).toBe(413);
    } finally {
      await rendezvous.stop();
    }
  });

  test("removes generated material when certificate generation fails", async () => {
    let directory = "";
    await expect(serveBootstrap({
      port: 0,
      advertiseHost: "localhost",
      expiresAt: Date.now() + 60_000,
      certificateGenerator: async (paths) => {
        directory = paths.directory;
        await Bun.write(paths.keyPath, "partial secret");
        throw new Error("generator failed");
      },
      prepareTarget: () => PLAN,
      persistHostKey: () => {},
    })).rejects.toThrow("generator failed");

    await expect(stat(directory)).rejects.toThrow();
  });
});
