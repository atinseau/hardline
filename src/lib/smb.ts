import { mkdir, stat } from "node:fs/promises";
import type { Config, SMBShare } from "../config";

/** Fonction pure. Compose l'URL smb://utilisateur:motdepasse@hote/partage. */
export function smbUrl(
  host: string,
  user: string,
  password: string,
  share: string,
): string {
  return `smb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}/${encodeURIComponent(share)}`;
}

/**
 * Retire toute occurrence du secret, brut ou encode pour une URL, d'un texte
 * destine a un message d'erreur. mount_smbfs peut echoer l'URL complete dans
 * son flux d'erreur : le secret ne doit jamais y survivre.
 */
function stripSecret(text: string, secret: string): string {
  if (secret === "") return text;
  return text.split(secret).join("***").split(encodeURIComponent(secret)).join("***");
}

// --- Frontiere systeme. ---

/**
 * Monte un partage. Cree le point de montage au besoin.
 *
 * Symetrique d'unmountShare, et gardee comme elle par isMounted : un montage
 * laisse par un `up` interrompu s'empilerait sinon a chaque lancement, macOS
 * ajoutant un suffixe au point de montage plutot que de refuser.
 */
export async function mountShare(
  share: SMBShare,
  config: Config,
  password: string,
): Promise<void> {
  if (await isMounted(share)) return;

  await mkdir(share.mountPoint, { recursive: true });

  const url = smbUrl(config.ssh.host, config.smb.user, password, share.name);
  const proc = Bun.spawn(["mount_smbfs", url, share.mountPoint], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `impossible de monter le partage «\u00a0${share.name}\u00a0» sur ${share.mountPoint} ` +
        `(code ${exitCode})\u00a0: ${stripSecret(stderr.trim(), password)}`,
    );
  }
}

/** Vrai si le point de montage porte un volume SMB. */
export async function isMounted(share: SMBShare): Promise<boolean> {
  const proc = Bun.spawn(["mount"], { stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  return stdout
    .split("\n")
    .some((line) => line.includes(` on ${share.mountPoint} (smbfs`));
}

/** Demonte. Ne leve pas si le partage n'etait pas monte. */
export async function unmountShare(share: SMBShare): Promise<void> {
  if (!(await isMounted(share))) return;

  const proc = Bun.spawn(["umount", share.mountPoint], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}

/** Vrai si le point de montage existe deja, et est bien un repertoire. */
export async function mountPointExists(mountPoint: string): Promise<boolean> {
  try {
    return (await stat(mountPoint)).isDirectory();
  } catch {
    return false;
  }
}

/** L'utilisateur courant, sous la forme que chown attend. */
function currentOwner(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const gid = typeof process.getgid === "function" ? process.getgid() : -1;
  return `${uid}:${gid}`;
}

async function sudo(command: string[], quoi: string): Promise<void> {
  const proc = Bun.spawn(["sudo", ...command], {
    stdout: "ignore",
    stderr: "pipe",
  });

  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`${quoi} (code ${exitCode})\u00a0: ${stderr.trim()}`);
  }
}

/**
 * Cree les points de montage manquants, puis les donne a l'utilisateur
 * courant. Sous sudo : /Volumes appartient a root:wheel en drwxr-xr-x, et un
 * mkdir sans privilege y echoue en EACCES.
 *
 * Un seul appel pour tous les repertoires : sudo ne redemande pas le mot de
 * passe a chaque invocation, mais rien ne justifie d'en multiplier les
 * occasions.
 */
export async function createMountPoints(mountPoints: string[]): Promise<void> {
  if (mountPoints.length === 0) return;

  await sudo(
    ["/bin/mkdir", "-p", ...mountPoints],
    "impossible de créer les points de montage",
  );
  await sudo(
    ["/usr/sbin/chown", currentOwner(), ...mountPoints],
    "impossible de donner les points de montage à l'utilisateur courant",
  );
}

/**
 * Retire des points de montage. rmdir, jamais rm -rf : un repertoire qui
 * refuse de partir porte encore quelque chose, et l'effacer de force est
 * exactement ce qu'une restauration ne doit pas faire.
 */
export async function removeMountPoints(mountPoints: string[]): Promise<void> {
  if (mountPoints.length === 0) return;

  await sudo(
    ["/bin/rmdir", ...mountPoints],
    "impossible de retirer les points de montage",
  );
}
