import { mkdir } from "node:fs/promises";
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

/** Monte un partage. Cree le point de montage au besoin. */
export async function mountShare(
  share: SMBShare,
  config: Config,
  password: string,
): Promise<void> {
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
      `impossible de monter le partage « ${share.name} » sur ${share.mountPoint} ` +
        `(code ${exitCode}) : ${stripSecret(stderr.trim(), password)}`,
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
