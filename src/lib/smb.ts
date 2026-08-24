import { mkdir, rmdir, stat } from "node:fs/promises";
import type { Config, SMBShare } from "../config";

const SHARE_PROBE_DEADLINE_MS = 3_000;

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
  if (await isMounted(share)) {
    if (await isResponsive(share)) return;

    const unmount = Bun.spawn(["umount", "-f", share.mountPoint], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const exitCode = await unmount.exited;
    if (exitCode !== 0) {
      throw new Error(
        `could not recycle unresponsive SMB share '${share.name}' at ${share.mountPoint}`,
      );
    }
  }

  await mkdir(share.mountPoint, { recursive: true });

  const url = smbUrl(config.ssh.host, config.smb.user, password, share.name);
  const proc = Bun.spawn(["mount_smbfs", url, share.mountPoint], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [_stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `could not mount share '${share.name}' at ${share.mountPoint} (code ${exitCode}).`,
    );
  }
}

/** Une enumeration bornee distingue un volume utilisable d'un montage SMB fige. */
async function isResponsive(share: SMBShare): Promise<boolean> {
  const proc = Bun.spawn(["/bin/ls", "-1f", share.mountPoint], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: SHARE_PROBE_DEADLINE_MS,
    killSignal: "SIGKILL",
  });
  return (await proc.exited) === 0;
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

/**
 * Cree les points de montage. Aucun privilege : ils vivent dans le dossier
 * personnel de l'utilisateur, pas sous /Volumes.
 *
 * /Volumes appartient a root:wheel en drwxr-xr-x — un mkdir y echoue en
 * EACCES pour l'utilisateur — et, surtout, macOS y EFFACE les repertoires
 * vides : diskarbitrationd s'en charge au demontage comme au redemarrage. Les
 * points crees a l'installation ne survivaient donc pas a la premiere
 * fermeture de session, et `up` echouait ensuite sur ce meme EACCES sans
 * pouvoir les recreer. Sous le dossier personnel, ils se creent sans mot de
 * passe, personne ne les efface, et `up` reste sans privilege — ce que
 * l'exigence de transparence du projet demande.
 */
export async function createMountPoints(mountPoints: string[]): Promise<void> {
  for (const mountPoint of mountPoints) {
    await mkdir(mountPoint, { recursive: true });
  }
}

/**
 * Retire des points de montage. rmdir, jamais rm -rf : un repertoire qui
 * refuse de partir porte encore quelque chose, et l'effacer de force est
 * exactement ce qu'une restauration ne doit pas faire.
 */
export async function removeMountPoints(mountPoints: string[]): Promise<void> {
  for (const mountPoint of mountPoints) {
    try {
      await rmdir(mountPoint);
    } catch (error) {
      // Un repertoire deja absent n'est pas un echec de restauration : c'est
      // son but, atteint sans nous. Le cas est reel — les anciens points sous
      // /Volumes que macOS a effaces figurent encore au manifeste, et une
      // desinstallation buterait dessus alors qu'il n'y a plus rien a rendre.
      // Tout le reste se dit : un montage encore actif, un fichier depose
      // dans le repertoire, ce sont des refus qui doivent remonter.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
  }
}
