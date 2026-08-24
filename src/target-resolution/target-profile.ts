import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DirectLink, TargetProfile } from "./types";
import type { TargetStatePaths } from "./types";
import { parseIpv4Cidr } from "./network";

const PROFILE_DIGEST_ATTRIBUTE = "com.hardline.target-profile-sha256";
const XATTR = "/usr/bin/xattr";

async function runXattr(argv: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const process = Bun.spawn([XATTR, ...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function sha256(source: Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

export class CorruptTargetProfileError extends Error {
  constructor(path: string) {
    super(`Target Profile at ${path} is corrupt or does not match the strict version-1 schema.`);
    this.name = "CorruptTargetProfileError";
  }
}

export class UnsupportedTargetProfileVersionError extends Error {
  readonly version: unknown;

  constructor(path: string, version: unknown) {
    super(`Target Profile at ${path} uses unsupported version ${String(version)}.`);
    this.name = "UnsupportedTargetProfileVersionError";
    this.version = version;
  }
}

const profileKeys = [
  "version",
  "revision",
  "lifecycle",
  "mac",
  "windows",
  "directLink",
  "hardlineIdentity",
  "sshHostKey",
  "installationCatalogVersion",
] as const;

const profileKeysWithPendingMigration = [...profileKeys, "pendingMigration"] as const;
const MAC_ADDRESS =
  /^(?:(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}|(?:[0-9a-fA-F]{2}-){5}[0-9a-fA-F]{2})$/;
const STABLE_ID = /^[A-Za-z0-9{][A-Za-z0-9._:{}-]{0,127}$/;
const SSH_ALGORITHM =
  /^(?:ssh-(?:ed25519|rsa)|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;
const SSH_PUBLIC_KEY =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\0\r\n]/.test(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmpty);
}

function macEthernet(value: unknown): boolean {
  return (
    exactRecord(value, ["hardwareId", "macAddress", "interfaceId", "serviceName"]) &&
    typeof value["hardwareId"] === "string" &&
    typeof value["macAddress"] === "string" &&
    MAC_ADDRESS.test(value["macAddress"]) &&
    value["hardwareId"] ===
      `ether:${value["macAddress"].toLowerCase().replaceAll("-", ":")}` &&
    typeof value["interfaceId"] === "string" &&
    /^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(value["interfaceId"]) &&
    nonEmpty(value["serviceName"])
  );
}

function windowsEthernet(value: unknown): boolean {
  return (
    exactRecord(value, ["hardwareId", "macAddress", "interfaceAlias"]) &&
    typeof value["hardwareId"] === "string" &&
    STABLE_ID.test(value["hardwareId"]) &&
    typeof value["macAddress"] === "string" &&
    MAC_ADDRESS.test(value["macAddress"]) &&
    nonEmpty(value["interfaceAlias"])
  );
}

function isDirectLink(value: unknown): value is DirectLink {
  if (!exactRecord(value, ["subnet", "macAddress", "windowsAddress"])) return false;
  if (
    typeof value["subnet"] !== "string" ||
    typeof value["macAddress"] !== "string" ||
    typeof value["windowsAddress"] !== "string"
  ) return false;
  const subnet = parseIpv4Cidr(value["subnet"]);
  const mac = parseIpv4Cidr(value["macAddress"]);
  const windows = parseIpv4Cidr(value["windowsAddress"]);
  if (
    subnet.kind !== "parsed" ||
    subnet.prefixLength !== 30 ||
    subnet.cidr !== value["subnet"] ||
    mac.kind !== "parsed" ||
    mac.prefixLength !== 32 ||
    windows.kind !== "parsed" ||
    windows.prefixLength !== 32 ||
    value["macAddress"] === value["windowsAddress"]
  ) return false;
  const usable = [
    incrementIpv4(subnet.firstAddress, 1),
    incrementIpv4(subnet.firstAddress, 2),
  ];
  return usable.includes(value["macAddress"]) && usable.includes(value["windowsAddress"]);
}

function sameDirectLink(left: DirectLink, right: DirectLink): boolean {
  return (
    left.subnet === right.subnet &&
    left.macAddress === right.macAddress &&
    left.windowsAddress === right.windowsAddress
  );
}

function incrementIpv4(address: string, amount: number): string {
  const octets = address.split(".").map(Number);
  const value = octets.reduce((total, octet) => total * 256 + octet, 0) + amount;
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

function sshPublicKey(value: unknown, algorithm: unknown): boolean {
  if (
    typeof value !== "string" ||
    typeof algorithm !== "string" ||
    value.length === 0 ||
    !SSH_PUBLIC_KEY.test(value)
  ) return false;
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < 4) return false;
  const algorithmLength = decoded.readUInt32BE(0);
  return (
    algorithmLength > 0 &&
    decoded.length >= 4 + algorithmLength &&
    decoded.subarray(4, 4 + algorithmLength).toString("ascii") === algorithm
  );
}

function isTargetProfile(value: unknown): value is TargetProfile {
  if (!exactRecord(value, profileKeys) && !exactRecord(value, profileKeysWithPendingMigration)) {
    return false;
  }
  const mac = value["mac"];
  const windows = value["windows"];
  const directLink = value["directLink"];
  const identity = value["hardlineIdentity"];
  const hostKey = value["sshHostKey"];
  const pendingMigration = value["pendingMigration"];
  const lifecycles = [
    "bootstrap-incomplete",
    "installation-incomplete",
    "installed",
    "uninstall-incomplete",
    "retirement-incomplete",
  ];

  return (
    value["version"] === 1 &&
    Number.isInteger(value["revision"]) &&
    (value["revision"] as number) >= 1 &&
    typeof value["lifecycle"] === "string" &&
    lifecycles.includes(value["lifecycle"]) &&
    exactRecord(mac, ["machineId", "hostAliases", "ethernet"]) &&
    typeof mac["machineId"] === "string" &&
    STABLE_ID.test(mac["machineId"]) &&
    stringArray(mac["hostAliases"]) &&
    macEthernet(mac["ethernet"]) &&
    exactRecord(windows, ["machineId", "hostAliases", "administrator", "smbUser", "ethernet"]) &&
    typeof windows["machineId"] === "string" &&
    STABLE_ID.test(windows["machineId"]) &&
    stringArray(windows["hostAliases"]) &&
    nonEmpty(windows["administrator"]) &&
    nonEmpty(windows["smbUser"]) &&
    windowsEthernet(windows["ethernet"]) &&
    isDirectLink(directLink) &&
    (pendingMigration === undefined ||
      (exactRecord(pendingMigration, ["operation", "oldLink", "proposedLink"]) &&
        (pendingMigration["operation"] === "initial-link" ||
          pendingMigration["operation"] === "migration") &&
        isDirectLink(pendingMigration["oldLink"]) &&
        isDirectLink(pendingMigration["proposedLink"]) &&
        (sameDirectLink(directLink, pendingMigration["oldLink"]) ||
          sameDirectLink(directLink, pendingMigration["proposedLink"])))) &&
    exactRecord(identity, ["privateKeyPath", "publicKeyPath"]) &&
    nonEmpty(identity["privateKeyPath"]) &&
    nonEmpty(identity["publicKeyPath"]) &&
    ((value["lifecycle"] === "bootstrap-incomplete" && hostKey === null) ||
      (exactRecord(hostKey, ["algorithm", "publicKey"]) &&
        typeof hostKey["algorithm"] === "string" &&
        SSH_ALGORITHM.test(hostKey["algorithm"]) &&
        sshPublicKey(hostKey["publicKey"], hostKey["algorithm"]))) &&
    nonEmpty(value["installationCatalogVersion"])
  );
}

export async function readTargetProfile(path: string): Promise<TargetProfile | null> {
  let source: Buffer;
  try {
    source = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const attribute = await runXattr(["-p", PROFILE_DIGEST_ATTRIBUTE, "--", path]);
  const digest = attribute.stdout.replace(/\n$/, "");
  if (
    attribute.exitCode !== 0 ||
    !/^[0-9a-f]{64}$/.test(digest) ||
    digest !== sha256(source)
  ) {
    throw new CorruptTargetProfileError(path);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source.toString("utf8")) as unknown;
  } catch {
    throw new CorruptTargetProfileError(path);
  }

  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    parsed.version !== 1
  ) {
    throw new UnsupportedTargetProfileVersionError(path, parsed.version);
  }
  if (!isTargetProfile(parsed)) throw new CorruptTargetProfileError(path);
  return parsed;
}

let temporaryCounter = 0;

export async function writeTargetProfile(
  path: string,
  profile: TargetProfile,
): Promise<void> {
  if (!isTargetProfile(profile)) throw new CorruptTargetProfileError(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  temporaryCounter += 1;
  const temporary = `${path}.${process.pid}.${temporaryCounter}.tmp`;
  const source = Buffer.from(`${JSON.stringify(profile, null, 2)}\n`, "utf8");

  try {
    await writeFile(temporary, source, { mode: 0o600 });
    await chmod(temporary, 0o600);
    let temporaryHandle = await open(temporary, "r");
    try {
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    const attribute = await runXattr([
      "-w",
      PROFILE_DIGEST_ATTRIBUTE,
      sha256(source),
      "--",
      temporary,
    ]);
    if (attribute.exitCode !== 0) {
      throw new Error(
        `Could not set Target Profile integrity attribute on ${temporary}: ${attribute.stderr.trim()}`,
      );
    }
    temporaryHandle = await open(temporary, "r");
    try {
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await rename(temporary, path);
    const directoryHandle = await open(dirname(path), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // The temporary file was never created or was already published.
    }
    throw error;
  }
}

export async function removeTargetProfile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function defaultTargetStatePaths(home: string = homedir()): TargetStatePaths {
  const state = join(home, ".config", "hardline");
  return {
    profile: join(state, "target-profile.json"),
    manifest: join(state, "manifest.json"),
  };
}
