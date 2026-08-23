import { psQuote } from "../lib/powershell";
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

  async restore(config: Config, previous: ShareState[]) {
    const toRemove = previous.filter((s) => !s.existed).map((s) => s.name);
    if (toRemove.length === 0) return;
    await runRemoteChecked(config.ssh, RESTORE(toRemove));
  },
};
