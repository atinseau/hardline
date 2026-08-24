import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type HardlineIdentityPaths = {
  readonly privateKeyPath: string;
  readonly publicKeyPath: string;
};

export type HardlineIdentityCommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type HardlineIdentityCommandRunner = (
  argv: readonly string[],
) => Promise<HardlineIdentityCommandResult>;

export type HardlineIdentityOptions = {
  readonly directory?: string;
  readonly runner?: HardlineIdentityCommandRunner;
};

export type KnownHostsProfile = {
  readonly sshHostKey: {
    readonly algorithm: string;
    readonly publicKey: string;
  };
};

export type KnownHostsOptions = {
  readonly alias: string;
  readonly path: string;
};

export type MaterializedKnownHosts = {
  readonly knownHostsFile: string;
  readonly hostKeyAlias: string;
};

export function hardlineKnownHostsSettings(privateKeyPath: string): Readonly<{
  materialization: KnownHostsOptions;
  target: MaterializedKnownHosts;
}> {
  const alias = "hardline-windows";
  const path = join(dirname(privateKeyPath), "known_hosts");
  return {
    materialization: { alias, path },
    target: { knownHostsFile: path, hostKeyAlias: `[${alias}]:22` },
  };
}

export class InvalidHardlineIdentityError extends Error {
  constructor(readonly paths: HardlineIdentityPaths) {
    super(`The managed Hardline Identity at ${paths.privateKeyPath} is partial or invalid.`);
    this.name = "InvalidHardlineIdentityError";
  }
}

export function defaultHardlineIdentityDirectory(home: string = homedir()): string {
  return join(home, "Library", "Application Support", "Hardline");
}

function identityPaths(directory: string): HardlineIdentityPaths {
  return {
    privateKeyPath: join(directory, "id_ed25519"),
    publicKeyPath: join(directory, "id_ed25519.pub"),
  };
}

const runCommand: HardlineIdentityCommandRunner = async (argv) => {
  const process = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
};

async function fileState(path: string): Promise<"missing" | "file" | "invalid"> {
  try {
    return (await lstat(path)).isFile() ? "file" : "invalid";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function publicKeyFields(source: string): string | null {
  const match = /^(ssh-ed25519 [A-Za-z0-9+/]+={0,3}) Hardline Identity\n?$/.exec(source);
  return match?.[1] ?? null;
}

async function readIdentityPublicKey(
  sourcePaths: HardlineIdentityPaths,
  errorPaths: HardlineIdentityPaths,
): Promise<string> {
  let privateKeySource: string;
  let publicKeySource: string;
  try {
    [privateKeySource, publicKeySource] = await Promise.all([
      readFile(sourcePaths.privateKeyPath, "utf8"),
      readFile(sourcePaths.publicKeyPath, "utf8"),
    ]);
  } catch {
    throw new InvalidHardlineIdentityError(errorPaths);
  }
  const publicKey = publicKeyFields(publicKeySource);
  if (
    !privateKeySource.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n") ||
    !privateKeySource.endsWith("-----END OPENSSH PRIVATE KEY-----\n") ||
    publicKey === null
  ) {
    throw new InvalidHardlineIdentityError(errorPaths);
  }
  return publicKey;
}

async function validateExistingIdentity(
  paths: HardlineIdentityPaths,
  runner: HardlineIdentityCommandRunner,
): Promise<void> {
  const expectedPublicKey = await readIdentityPublicKey(paths, paths);
  const result = await runner(["ssh-keygen", "-y", "-f", paths.privateKeyPath]);
  if (result.exitCode !== 0 || result.stdout.trim() !== expectedPublicKey) {
    throw new InvalidHardlineIdentityError(paths);
  }
}

export async function ensureHardlineIdentity(
  options: HardlineIdentityOptions = {},
): Promise<HardlineIdentityPaths> {
  const directory = options.directory ?? defaultHardlineIdentityDirectory();
  const paths = identityPaths(directory);
  const temporaryPrivateKey = join(directory, `.id_ed25519.${randomUUID()}.tmp`);
  const temporaryPublicKey = `${temporaryPrivateKey}.pub`;

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const [privateState, publicState] = await Promise.all([
    fileState(paths.privateKeyPath),
    fileState(paths.publicKeyPath),
  ]);
  if (privateState === "file" && publicState === "file") {
    await validateExistingIdentity(paths, options.runner ?? runCommand);
    await chmod(paths.privateKeyPath, 0o600);
    await chmod(paths.publicKeyPath, 0o644);
    return paths;
  }
  if (privateState !== "missing" || publicState !== "missing") {
    throw new InvalidHardlineIdentityError(paths);
  }

  let publicKeyPublished = false;
  try {
    const result = await (options.runner ?? runCommand)([
      "ssh-keygen",
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "Hardline Identity",
      "-f",
      temporaryPrivateKey,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`ssh-keygen failed with exit code ${result.exitCode}: ${result.stderr}`);
    }

    await readIdentityPublicKey(
      { privateKeyPath: temporaryPrivateKey, publicKeyPath: temporaryPublicKey },
      paths,
    );
    await chmod(temporaryPrivateKey, 0o600);
    await chmod(temporaryPublicKey, 0o644);
    await rename(temporaryPublicKey, paths.publicKeyPath);
    publicKeyPublished = true;
    await rename(temporaryPrivateKey, paths.privateKeyPath);
    return paths;
  } catch (error) {
    await Promise.all([
      unlink(temporaryPrivateKey).catch(() => undefined),
      unlink(temporaryPublicKey).catch(() => undefined),
      publicKeyPublished ? unlink(paths.publicKeyPath).catch(() => undefined) : Promise.resolve(),
    ]);
    throw error;
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function removeHardlineIdentity(paths: HardlineIdentityPaths): Promise<void> {
  await Promise.all([
    unlinkIfPresent(paths.privateKeyPath),
    unlinkIfPresent(paths.publicKeyPath),
  ]);
}

export async function materializeKnownHosts(
  profile: KnownHostsProfile,
  options: KnownHostsOptions,
): Promise<MaterializedKnownHosts> {
  if (
    options.alias.length === 0 ||
    /[\s[\],]/.test(options.alias) ||
    !/^[A-Za-z0-9@._+-]+$/.test(profile.sshHostKey.algorithm) ||
    !/^[A-Za-z0-9+/]+={0,3}$/.test(profile.sshHostKey.publicKey)
  ) {
    throw new Error("The SSH host key or HostKeyAlias is invalid.");
  }

  const hostKeyAlias = `[${options.alias}]:22`;
  const temporary = `${options.path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });

  try {
    await writeFile(
      temporary,
      `${hostKeyAlias} ${profile.sshHostKey.algorithm} ${profile.sshHostKey.publicKey}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(temporary, 0o600);
    await rename(temporary, options.path);
  } catch (error) {
    await unlinkIfPresent(temporary);
    throw error;
  }

  return { knownHostsFile: options.path, hostKeyAlias };
}
