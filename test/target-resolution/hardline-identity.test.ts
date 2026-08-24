import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultHardlineIdentityDirectory,
  ensureHardlineIdentity,
  InvalidHardlineIdentityError,
  materializeKnownHosts,
  removeHardlineIdentity,
  type HardlineIdentityCommandRunner,
} from "../../src/target-resolution/hardline-identity";

const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey Hardline Identity";
const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----\n";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

test("generation creates only the dedicated Ed25519 Hardline Identity with owner-only custody", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-identity-"));
  const managedDirectory = join(directory, "Application Support", "Hardline");
  const calls: string[][] = [];
  const runner: HardlineIdentityCommandRunner = async (argv) => {
    calls.push([...argv]);
    const outputIndex = argv.indexOf("-f");
    const output = argv[outputIndex + 1];
    if (!output) throw new Error("missing output path");
    await writeFile(output, privateKey, { mode: 0o644 });
    await writeFile(`${output}.pub`, `${publicKey}\n`, { mode: 0o600 });
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  const identity = await ensureHardlineIdentity({ directory: managedDirectory, runner });

  expect(identity).toEqual({
    privateKeyPath: join(managedDirectory, "id_ed25519"),
    publicKeyPath: join(managedDirectory, "id_ed25519.pub"),
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[0]).toBe("ssh-keygen");
  expect(calls[0]).toContain("ed25519");
  expect(calls[0]).toContain("-N");
  expect((await stat(managedDirectory)).mode & 0o777).toBe(0o700);
  expect((await stat(identity.privateKeyPath)).mode & 0o777).toBe(0o600);
  expect((await stat(identity.publicKeyPath)).mode & 0o777).toBe(0o644);
});

test("a valid pair is reused only from its exact managed paths", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-identity-"));
  const privateKeyPath = join(directory, "id_ed25519");
  const publicKeyPath = `${privateKeyPath}.pub`;
  await writeFile(privateKeyPath, privateKey);
  await writeFile(publicKeyPath, `${publicKey}\n`);
  await chmod(directory, 0o755);
  await chmod(privateKeyPath, 0o644);
  const calls: string[][] = [];
  const runner: HardlineIdentityCommandRunner = async (argv) => {
    calls.push([...argv]);
    return { exitCode: 0, stdout: `${publicKey.split(" ").slice(0, 2).join(" ")}\n`, stderr: "" };
  };

  const first = await ensureHardlineIdentity({ directory, runner });
  const second = await ensureHardlineIdentity({ directory, runner });

  expect(first).toEqual({ privateKeyPath, publicKeyPath });
  expect(second).toEqual(first);
  expect(calls).toEqual([
    ["ssh-keygen", "-y", "-f", privateKeyPath],
    ["ssh-keygen", "-y", "-f", privateKeyPath],
  ]);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(privateKeyPath)).mode & 0o777).toBe(0o600);
});

test("a partial or invalid managed pair fails with a typed error instead of replacing keys", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-identity-"));
  const privateKeyPath = join(directory, "id_ed25519");
  await writeFile(privateKeyPath, privateKey);
  let called = false;
  const runner: HardlineIdentityCommandRunner = async () => {
    called = true;
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await expect(ensureHardlineIdentity({ directory, runner })).rejects.toBeInstanceOf(
    InvalidHardlineIdentityError,
  );
  expect(called).toBeFalse();

  await writeFile(`${privateKeyPath}.pub`, "ssh-rsa user-key\n");
  await expect(ensureHardlineIdentity({ directory, runner })).rejects.toBeInstanceOf(
    InvalidHardlineIdentityError,
  );
  expect(called).toBeFalse();
});

test("a syntactically valid but mismatched managed pair is rejected", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-identity-"));
  const privateKeyPath = join(directory, "id_ed25519");
  await writeFile(privateKeyPath, privateKey);
  await writeFile(`${privateKeyPath}.pub`, `${publicKey}\n`);
  const runner: HardlineIdentityCommandRunner = async () => ({
    exitCode: 0,
    stdout: "ssh-ed25519 AAAAC3NzaDifferentKey\n",
    stderr: "",
  });

  await expect(ensureHardlineIdentity({ directory, runner })).rejects.toBeInstanceOf(
    InvalidHardlineIdentityError,
  );
});

test("invalid command output is not published and unique temporary files are cleaned up", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-identity-"));
  const outputs: string[] = [];
  const runner: HardlineIdentityCommandRunner = async (argv) => {
    const output = argv[argv.indexOf("-f") + 1];
    if (!output) throw new Error("missing output path");
    outputs.push(output);
    await writeFile(output, "not a private key");
    await writeFile(`${output}.pub`, "not a public key");
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  await expect(ensureHardlineIdentity({ directory, runner })).rejects.toBeInstanceOf(
    InvalidHardlineIdentityError,
  );

  expect(outputs[0]).not.toBe(join(directory, "id_ed25519"));
  expect(await readdir(directory)).toEqual([]);
});

test("removing the Hardline Identity deletes both key files idempotently", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-identity-"));
  const paths = {
    privateKeyPath: join(directory, "id_ed25519"),
    publicKeyPath: join(directory, "id_ed25519.pub"),
  };
  await writeFile(paths.privateKeyPath, privateKey);
  await writeFile(paths.publicKeyPath, publicKey);

  await removeHardlineIdentity(paths);
  await removeHardlineIdentity(paths);

  expect(await readdir(directory)).toEqual([]);
});

test("known hosts is atomically materialized with an exact bracketed HostKeyAlias", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-identity-"));
  const path = join(directory, "state", "known_hosts");
  const profile = {
    sshHostKey: {
      algorithm: "ssh-ed25519",
      publicKey: "AAAAC3NzaC1lZDI1NTE5AAAAIWindowsHostKey",
    },
  };

  const materialized = await materializeKnownHosts(profile, {
    alias: "hardline.windows-machine-guid",
    path,
  });
  await materializeKnownHosts(profile, { alias: "hardline.windows-machine-guid", path });

  expect(materialized).toEqual({
    knownHostsFile: path,
    hostKeyAlias: "[hardline.windows-machine-guid]:22",
  });
  expect(await readFile(path, "utf8")).toBe(
    "[hardline.windows-machine-guid]:22 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIWindowsHostKey\n",
  );
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(join(directory, "state"))).toEqual(["known_hosts"]);
});

test("the default identity directory is the current user's Application Support", () => {
  expect(defaultHardlineIdentityDirectory("/Users/operator")).toBe(
    "/Users/operator/Library/Application Support/Hardline",
  );
});

test("a failed ssh-keygen run cleans temporary material without touching a user identity", async () => {
  directory = await mkdtemp(join(tmpdir(), "hardline-identity-"));
  const managedDirectory = join(directory, "Library", "Application Support", "Hardline");
  const userPrivateKey = join(directory, "id_ed25519");
  await writeFile(userPrivateKey, "operator key");
  const runner: HardlineIdentityCommandRunner = async (argv) => {
    const output = argv[argv.indexOf("-f") + 1];
    if (!output) throw new Error("missing output path");
    await writeFile(output, privateKey);
    await writeFile(`${output}.pub`, publicKey);
    return { exitCode: 1, stdout: "", stderr: "generation failed" };
  };

  await expect(ensureHardlineIdentity({ directory: managedDirectory, runner })).rejects.toThrow(
    "ssh-keygen failed",
  );

  expect(await readFile(userPrivateKey, "utf8")).toBe("operator key");
  expect(await readdir(managedDirectory)).toEqual([]);
});
