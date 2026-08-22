import { runRemote, runRemoteJson } from "../lib/ssh";
import type { Config } from "../config";
import type { Step } from "./types";

export type WindowsNetworkState = {
  adapterPresent: boolean;
  adapterStatus: string | null;
  addresses: string[];
  category: "Public" | "Private" | "DomainAuthenticated" | null;
};

const INSPECT = (alias: string) => `
$adapter = Get-NetAdapter -Name '${alias}' -ErrorAction SilentlyContinue
$addresses = Get-NetIPAddress -InterfaceAlias '${alias}' -AddressFamily IPv4 -ErrorAction SilentlyContinue
$profile = Get-NetConnectionProfile -InterfaceAlias '${alias}' -ErrorAction SilentlyContinue
[pscustomobject]@{
  adapterPresent = [bool]$adapter
  adapterStatus  = if ($adapter) { [string]$adapter.Status } else { $null }
  addresses      = @($addresses | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
  category       = if ($profile) { [string]$profile.NetworkCategory } else { $null }
}`;

const APPLY = (alias: string, ip: string, prefix: number) => `
Get-NetIPAddress -InterfaceAlias '${alias}' -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
New-NetIPAddress -InterfaceAlias '${alias}' -IPAddress '${ip}' -PrefixLength ${prefix} | Out-Null
Set-NetConnectionProfile -InterfaceAlias '${alias}' -NetworkCategory Private`;

const RESTORE = (alias: string, category: string | null) => `
Get-NetIPAddress -InterfaceAlias '${alias}' -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
Set-NetIPInterface -InterfaceAlias '${alias}' -Dhcp Enabled -ErrorAction SilentlyContinue
${category ? `Set-NetConnectionProfile -InterfaceAlias '${alias}' -NetworkCategory ${category} -ErrorAction SilentlyContinue` : ""}`;

export const windowsNetworkStep: Step<WindowsNetworkState> = {
  name: "network-windows",
  label: "Adresse fixe et profil prive sur le lien direct (PC)",

  async inspect(config: Config) {
    const rows = await runRemoteJson<WindowsNetworkState>(
      config.ssh,
      INSPECT(config.windows.interfaceAlias),
    );
    const current = rows[0];

    if (!current) {
      throw new Error(
        "Le PC n'a renvoye aucun etat reseau. Verifier la liaison SSH.",
      );
    }
    if (!current.adapterPresent) {
      throw new Error(
        `L'interface "${config.windows.interfaceAlias}" n'existe pas sur le PC. Verifier le nom ou le branchement du cable.`,
      );
    }

    const target = `${config.windows.ip}/${config.windows.prefixLength}`;
    const hasAddress = current.addresses.includes(target);
    const isPrivate = current.category === "Private";
    const conforming = hasAddress && isPrivate;

    return {
      conforming,
      current,
      detail: conforming
        ? `${config.windows.interfaceAlias} deja en ${target}, profil prive`
        : `adresse ${hasAddress ? "correcte" : "absente"}, profil ${current.category ?? "inconnu"}`,
    };
  },

  async apply(config: Config) {
    await runRemote(
      config.ssh,
      APPLY(
        config.windows.interfaceAlias,
        config.windows.ip,
        config.windows.prefixLength,
      ),
    );
  },

  async restore(config: Config, previous: WindowsNetworkState) {
    await runRemote(
      config.ssh,
      RESTORE(config.windows.interfaceAlias, previous.category),
    );
  },
};
