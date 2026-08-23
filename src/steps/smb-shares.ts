import { psQuote } from "../lib/powershell";
import { unmountShare } from "../lib/smb";
import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import type { Config, SMBShare } from "../config";
import type { Step } from "./types";

export type ShareState = { name: string; existed: boolean };

/**
 * Les partages que cette etape cree et defait. "arthur" en est exclu : il
 * preexiste sur le PC de reference et son chemin vaut null dans la
 * configuration precisement pour marquer qu'il n'est pas a creer.
 */
function managedShares(config: Config): SMBShare[] {
  return config.smb.shares.filter((share) => share.path !== null);
}

const INSPECT = (names: string[]) => `
$names = @(${names.map((n) => psQuote(n, "nom de partage")).join(", ")})
$names | ForEach-Object {
  $s = Get-SmbShare -Name $_ -ErrorAction SilentlyContinue
  [pscustomobject]@{ name = $_; existed = [bool]$s }
}`;

const APPLY = (shares: SMBShare[], user: string) =>
  shares
    .map((share) => {
      const name = psQuote(share.name, "nom de partage");
      const path = psQuote(share.path as string, "chemin de partage");
      const owner = psQuote(user, "compte du partage");
      return [
        `$s = Get-SmbShare -Name ${name} -ErrorAction SilentlyContinue`,
        `if (-not $s) { New-SmbShare -Name ${name} -Path ${path} -FullAccess ${owner} | Out-Null }`,
      ].join("\n");
    })
    .join("\n");

const RESTORE = (names: string[]) =>
  names
    .map(
      (name) =>
        `Remove-SmbShare -Name ${psQuote(name, "nom de partage")} -Force -Confirm:$false -ErrorAction SilentlyContinue`,
    )
    .join("\n");

export const smbSharesStep: Step<ShareState[]> = {
  name: "smb-shares",
  label: "Partages des disques D: et E: (PC)",

  async inspect(config: Config) {
    const managed = managedShares(config);
    const rows = await runRemoteJson<ShareState>(
      config.ssh,
      INSPECT(managed.map((s) => s.name)),
    );
    const current = managed.map((share) => {
      const row = rows.find((r) => r.name === share.name);
      return { name: share.name, existed: row?.existed ?? false };
    });

    const conforming = current.every((s) => s.existed);

    return {
      conforming,
      current,
      detail: conforming
        ? `${current.map((s) => s.name).join(", ")} déjà présents`
        : `manquants\u00a0: ${current.filter((s) => !s.existed).map((s) => s.name).join(", ")}`,
    };
  },

  async apply(config: Config) {
    const managed = managedShares(config);
    if (managed.length === 0) return;
    await runRemoteChecked(config.ssh, APPLY(managed, config.smb.user));
  },

  /**
   * Demonte cote Mac AVANT de retirer les partages cote PC. L'ordre n'est pas
   * une precaution de style : un volume dont le serveur vient de disparaitre
   * est exactement le Finder fige que le projet promet d'eviter. Le demontage
   * porte sur TOUS les partages configures, y compris ceux que cette etape n'a
   * pas crees — une session tuee peut en avoir laisse n'importe lequel monte —
   * et unmountShare ne leve jamais quand rien ne l'est.
   */
  async restore(config: Config, previous: ShareState[]) {
    for (const share of config.smb.shares) {
      await unmountShare(share);
    }

    const toRemove = previous.filter((s) => !s.existed).map((s) => s.name);
    if (toRemove.length === 0) return;
    await runRemoteChecked(config.ssh, RESTORE(toRemove));
  },
};
