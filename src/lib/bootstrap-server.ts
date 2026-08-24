import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import {
  BootstrapClosedError,
  BootstrapExpiredError,
  BootstrapHostKeyConflictError,
  BootstrapPhaseError,
  BootstrapProtocol,
  BootstrapReplayError,
  type HostKeyCheckpoint,
  InvalidBootstrapTokenError,
  type HostKeyObservation,
  type MutationPlan,
  type WindowsObservations,
} from "../target-resolution/bootstrap-protocol";
import templatePath from "../assets/bootstrap.ps1" with { type: "file" };
import { assertNoApostrophe } from "./powershell";

const MAX_JSON_BYTES = 64 * 1024;
const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
};

export type LocalBootstrapCommandOptions = Readonly<{
  urls: readonly string[];
  token: string;
  fingerprint: string;
}>;

export type CertificatePaths = Readonly<{
  directory: string;
  certPath: string;
  keyPath: string;
}>;

export type CertificateGenerator = (
  paths: CertificatePaths,
) => void | Promise<void>;

export type BootstrapWindowsObservations = Omit<WindowsObservations, "networkAdapters"> &
  Readonly<{
    administrator: string;
    networkAdapters: readonly {
      readonly alias: string;
      readonly interfaceIndex: number;
      readonly hardwareId: string;
      readonly hardwareName: string;
      readonly macAddress: string;
      readonly speedMbps: number | null;
      readonly physical: boolean;
      readonly transport: "ethernet" | "wifi" | "bluetooth" | "other";
      readonly virtual: boolean;
      readonly linkState: "up" | "down";
      readonly ipv4Addresses: readonly string[];
    }[];
    routes: readonly {
      interfaceIndex: number;
      destinationPrefix: string;
      nextHop: string;
    }[];
  }>;

export type BootstrapServerOptions = Readonly<{
  expiresAt: number;
  prepareTarget: (
    observations: BootstrapWindowsObservations,
  ) => MutationPlan | Promise<MutationPlan>;
  persistHostKey: (checkpoint: HostKeyCheckpoint) => void | Promise<void>;
  port?: number;
  bindHost?: string;
  advertiseHost?: string;
  advertiseHosts?: readonly string[];
  now?: () => number;
  template?: string;
  certificateGenerator?: CertificateGenerator;
}>;

export type BootstrapServer = Readonly<{
  url: string;
  urls: readonly string[];
  port: number;
  token: string;
  fingerprint: string;
  command: string;
  stop: () => Promise<void>;
}>;

export function localBootstrapCommand(
  options: LocalBootstrapCommandOptions,
): string {
  if (options.urls.length === 0) throw new Error("No Bootstrap Rendezvous path is available.");
  for (const [index, url] of options.urls.entries()) {
    assertNoApostrophe(url, `urls[${index}]`);
  }
  assertNoApostrophe(options.token, "token");
  assertNoApostrophe(options.fingerprint, "fingerprint");
  const urls = options.urls.map((url) => `'${url}'`).join(",");
  const prefix = `$HardlineUrls=@(${urls});$HardlineToken='${options.token}';$HardlineFingerprint='${options.fingerprint}'`;
  const source = "using System;using System.Net.Http;using System.Net.Http.Headers;using System.Security.Cryptography;public static class HardlinePinnedClient{public static HttpClient Create(string fingerprint,string token){var h=new HttpClientHandler();h.ServerCertificateCustomValidationCallback=(r,c,ch,e)=>c!=null&&StringComparer.Ordinal.Equals(c.GetCertHashString(HashAlgorithmName.SHA256),fingerprint);var client=new HttpClient(h);client.DefaultRequestHeaders.Authorization=new AuthenticationHeaderValue(\"Bearer\",token);return client;}}";
  const client = `if(-not ('HardlinePinnedClient' -as [type])){Add-Type -AssemblyName System.Net.Http;Add-Type -TypeDefinition '${source}'};$c=[HardlinePinnedClient]::Create($HardlineFingerprint,$HardlineToken)`;
  const retrieve = `$payload=$null;foreach($candidate in $HardlineUrls){$HardlineUrl=$candidate;try{$payload=$c.GetStringAsync(\"$HardlineUrl/bootstrap.ps1\").GetAwaiter().GetResult();break}catch{}};if(-not $payload){throw 'No authenticated Hardline rendezvous path responded.'};iex $payload`;
  return `& { ${prefix};${client};${retrieve} }`;
}

function localAdvertiseHosts(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map((address) => address.address);
  return [hostname(), ...addresses].filter(
    (host, index, hosts) => host.length > 0 && hosts.indexOf(host) === index,
  );
}

export async function loadBootstrapTemplate(): Promise<string> {
  return await Bun.file(templatePath).text();
}

export async function serveBootstrap(
  options: BootstrapServerOptions,
): Promise<BootstrapServer> {
  const directory = await mkdtemp(join(tmpdir(), "hardline-bootstrap-"));
  await chmod(directory, 0o700);
  const paths: CertificatePaths = {
    directory,
    certPath: join(directory, "certificate.pem"),
    keyPath: join(directory, "private-key.pem"),
  };
  let protocol: BootstrapProtocol | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;

  try {
    await (options.certificateGenerator ?? generateCertificate)(paths);
    await chmod(paths.keyPath, 0o600);
    const [certificate, privateKey, script] = await Promise.all([
      readFile(paths.certPath, "utf8"),
      readFile(paths.keyPath, "utf8"),
      options.template === undefined
        ? loadBootstrapTemplate()
        : Promise.resolve(options.template),
    ]);
    const fingerprint = createHash("sha256")
      .update(new X509Certificate(certificate).raw)
      .digest("hex")
      .toUpperCase();
    const token = randomBytes(32).toString("hex");
    protocol = new BootstrapProtocol({
      token,
      expiresAt: options.expiresAt,
      now: options.now ?? Date.now,
      prepareTarget: (observations) =>
        options.prepareTarget(observations as BootstrapWindowsObservations),
      persistHostKey: options.persistHostKey,
    });

    server = Bun.serve({
      hostname: options.bindHost ?? "0.0.0.0",
      port: options.port ?? 0,
      tls: { cert: certificate, key: privateKey },
      fetch: (request) => routeRequest(request, token, script, protocol!),
    });
    if (server.port === undefined) {
      throw new Error("The Bootstrap Rendezvous has no TCP port.");
    }
    const hosts = [
      ...(options.advertiseHost ? [options.advertiseHost] : []),
      ...(options.advertiseHosts ?? localAdvertiseHosts()),
    ].filter((host, index, all) => host.length > 0 && all.indexOf(host) === index);
    const urls = hosts.map((host) => `https://${host}:${server!.port}`);
    const url = urls[0];
    if (!url) throw new Error("The Bootstrap Rendezvous has no advertised path.");
    let stopped: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      if (stopped) return stopped;
      protocol?.close();
      stopped = (async () => {
        try {
          await Promise.resolve(server?.stop(true));
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      })();
      return stopped;
    };

    return {
      url,
      urls,
      port: server.port,
      token,
      fingerprint,
      command: localBootstrapCommand({ urls, token, fingerprint }),
      stop,
    };
  } catch (error) {
    protocol?.close();
    try {
      await Promise.resolve(server?.stop(true));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}

async function generateCertificate(paths: CertificatePaths): Promise<void> {
  const process = Bun.spawn([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    paths.keyPath,
    "-out",
    paths.certPath,
    "-days",
    "1",
    "-subj",
    "/CN=hardline-bootstrap",
  ], { stdout: "ignore", stderr: "ignore" });
  if (await process.exited !== 0) {
    throw new Error("Unable to generate the ephemeral bootstrap certificate.");
  }
}

async function routeRequest(
  request: Request,
  token: string,
  script: string,
  protocol: BootstrapProtocol,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!["/bootstrap.ps1", "/phase-one", "/phase-two"].includes(path)) {
    return new Response("Not found", { status: 404 });
  }
  if (request.headers.get("authorization") !== `Bearer ${token}`) {
    return jsonError(401, "UNAUTHORIZED");
  }

  if (path === "/bootstrap.ps1") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return new Response(script, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (request.method !== "POST") return methodNotAllowed("POST");

  try {
    const body = await readJson(request);
    if (path === "/phase-one") {
      const phaseOne = parsePhaseOne(body);
      protocol.claim({ token, ...phaseOne });
      return Response.json(
        await protocol.authorizePlan({ token, clientNonce: phaseOne.clientNonce }),
        { headers: JSON_HEADERS },
      );
    }
    const phaseTwo = parsePhaseTwo(body);
    return Response.json(await protocol.complete({ token, ...phaseTwo }), {
      headers: JSON_HEADERS,
    });
  } catch (error) {
    return safeError(error);
  }
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
    throw new RequestFailure(415, "UNSUPPORTED_MEDIA_TYPE");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new RequestFailure(413, "BODY_TOO_LARGE");
  }
  if (!request.body) throw new RequestFailure(400, "INVALID_JSON");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new RequestFailure(413, "BODY_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestFailure(400, "INVALID_JSON");
  }
}

function parsePhaseOne(value: unknown): {
  clientNonce: string;
  observations: BootstrapWindowsObservations;
} {
  const body = exactObject(value, ["clientNonce", "observations"]);
  const observations = exactObject(body.observations, [
    "computerName",
    "machineId",
    "capturedAt",
    "activeIpv4Addresses",
    "administrator",
    "networkAdapters",
    "routes",
    "openSsh",
  ]);
  const adapters = array(observations.networkAdapters).map((entry) => {
    const adapter = exactObject(entry, [
      "alias",
      "interfaceIndex",
      "hardwareId",
      "hardwareName",
      "macAddress",
      "speedMbps",
      "physical",
      "transport",
      "virtual",
      "linkState",
      "ipv4Addresses",
    ]);
    const transport = string(adapter.transport);
    const linkState = string(adapter.linkState);
    if (!["ethernet", "wifi", "bluetooth", "other"].includes(transport)) {
      throw invalidRequest();
    }
    if (linkState !== "up" && linkState !== "down") throw invalidRequest();
    return {
      alias: string(adapter.alias),
      interfaceIndex: integer(adapter.interfaceIndex),
      hardwareId: string(adapter.hardwareId),
      hardwareName: string(adapter.hardwareName),
      macAddress: string(adapter.macAddress),
      speedMbps: nullableNumber(adapter.speedMbps),
      physical: boolean(adapter.physical),
      transport: transport as "ethernet" | "wifi" | "bluetooth" | "other",
      virtual: boolean(adapter.virtual),
      linkState: linkState as "up" | "down",
      ipv4Addresses: array(adapter.ipv4Addresses).map(string),
    };
  });
  const routes = array(observations.routes).map((entry) => {
    const route = exactObject(entry, [
      "interfaceIndex",
      "destinationPrefix",
      "nextHop",
    ]);
    return {
      interfaceIndex: integer(route.interfaceIndex),
      destinationPrefix: string(route.destinationPrefix),
      nextHop: string(route.nextHop),
    };
  });
  const ssh = exactObjectWithOptional(observations.openSsh, [
    "capabilityState",
    "serviceStartType",
    "serviceStatus",
    "firewallRulePresent",
    "administratorsAuthorizedKeysPresent",
  ], ["hostKey"]);
  const observedHostKey = ssh.hostKey === undefined || ssh.hostKey === null
    ? null
    : parseHostKey(ssh.hostKey);
  return {
    clientNonce: string(body.clientNonce),
    observations: {
      computerName: string(observations.computerName),
      machineId: string(observations.machineId),
      capturedAt: string(observations.capturedAt),
      activeIpv4Addresses: array(observations.activeIpv4Addresses).map(string),
      administrator: string(observations.administrator),
      networkAdapters: adapters,
      routes,
      openSsh: {
        capabilityState: nullableString(ssh.capabilityState),
        serviceStartType: nullableString(ssh.serviceStartType),
        serviceStatus: nullableString(ssh.serviceStatus),
        firewallRulePresent: boolean(ssh.firewallRulePresent),
        administratorsAuthorizedKeysPresent: boolean(
          ssh.administratorsAuthorizedKeysPresent,
        ),
        hostKey: observedHostKey,
      },
    },
  };
}

function parsePhaseTwo(value: unknown): {
  clientNonce: string;
  hostKey: HostKeyObservation;
} {
  const body = exactObject(value, ["clientNonce", "hostKey"]);
  const hostKey = parseHostKey(body.hostKey);
  return {
    clientNonce: string(body.clientNonce),
    hostKey,
  };
}

function parseHostKey(value: unknown): HostKeyObservation {
  const hostKey = exactObject(value, [
    "algorithm",
    "fingerprint",
    "publicKey",
  ]);
  const algorithm = string(hostKey.algorithm);
  if (!["ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"].includes(algorithm)) {
    throw invalidRequest();
  }
  return {
    algorithm: algorithm as HostKeyObservation["algorithm"],
    fingerprint: string(hostKey.fingerprint),
    publicKey: string(hostKey.publicKey),
  };
}

class RequestFailure extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function invalidRequest(): RequestFailure {
  return new RequestFailure(400, "INVALID_REQUEST");
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest();
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw invalidRequest();
  }
  return object;
}

function exactObjectWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest();
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  if (
    required.some((key) => !(key in object)) ||
    actual.some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw invalidRequest();
  }
  return object;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw invalidRequest();
  return value;
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  return string(value);
}

function integer(value: unknown): number {
  if (!Number.isInteger(value)) throw invalidRequest();
  return value as number;
}

function nullableNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidRequest();
  }
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalidRequest();
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw invalidRequest();
  return value;
}

function methodNotAllowed(allowed: string): Response {
  return new Response("Method not allowed", {
    status: 405,
    headers: { allow: allowed },
  });
}

function jsonError(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: JSON_HEADERS });
}

function safeError(error: unknown): Response {
  if (error instanceof RequestFailure) return jsonError(error.status, error.code);
  if (error instanceof InvalidBootstrapTokenError) return jsonError(401, error.code);
  if (error instanceof BootstrapExpiredError || error instanceof BootstrapClosedError) {
    return jsonError(410, error.code);
  }
  if (
    error instanceof BootstrapReplayError ||
    error instanceof BootstrapPhaseError ||
    error instanceof BootstrapHostKeyConflictError
  ) {
    return jsonError(409, error.code);
  }
  return jsonError(500, "INTERNAL_ERROR");
}
