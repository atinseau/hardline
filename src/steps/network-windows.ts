import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import type { Config } from "../config";
import type { Step } from "./types";

export type WindowsNetworkState = {
  adapterPresent: boolean;
  adapterStatus: string | null;
  /** Toutes les adresses IPv4, au format "adresse/prefixe". */
  addresses: string[];
  /** Celles que quelqu'un a posees a la main : les seules a restaurer. */
  manualAddresses: string[];
  dhcpEnabled: boolean;
  category: "Public" | "Private" | "DomainAuthenticated" | null;
};

const INSPECT = (alias: string) => `
$adapter = Get-NetAdapter -Name '${alias}' -ErrorAction SilentlyContinue
$addresses = Get-NetIPAddress -InterfaceAlias '${alias}' -AddressFamily IPv4 -ErrorAction SilentlyContinue
$interface = Get-NetIPInterface -InterfaceAlias '${alias}' -AddressFamily IPv4 -ErrorAction SilentlyContinue
$connection = Get-NetConnectionProfile -InterfaceAlias '${alias}' -ErrorAction SilentlyContinue
[pscustomobject]@{
  adapterPresent  = [bool]$adapter
  adapterStatus   = if ($adapter) { [string]$adapter.Status } else { $null }
  addresses       = @($addresses | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
  manualAddresses = @($addresses | Where-Object { $_.PrefixOrigin -eq 'Manual' } | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
  dhcpEnabled     = if ($interface) { [bool]($interface.Dhcp -eq 'Enabled') } else { $false }
  category        = if ($connection) { [string]$connection.NetworkCategory } else { $null }
}`;

const clearAddresses = (alias: string) =>
  `Get-NetIPAddress -InterfaceAlias '${alias}' -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue`;

const APPLY = (alias: string, ip: string, prefix: number) => `
${clearAddresses(alias)}
Set-NetIPInterface -InterfaceAlias '${alias}' -Dhcp Disabled -ErrorAction SilentlyContinue
New-NetIPAddress -InterfaceAlias '${alias}' -IPAddress '${ip}' -PrefixLength ${prefix} | Out-Null
Set-NetConnectionProfile -InterfaceAlias '${alias}' -NetworkCategory Private`;

function restoreAddressing(alias: string, previous: WindowsNetworkState): string {
  if (previous.dhcpEnabled) {
    return `Set-NetIPInterface -InterfaceAlias '${alias}' -Dhcp Enabled`;
  }

  // Aucune adresse manuelle et pas de DHCP : l'interface n'avait rien, on la
  // laisse nue plutot que de lui inventer une configuration.
  return previous.manualAddresses
    .map((entry) => {
      const [address, prefix] = entry.split("/");
      return `New-NetIPAddress -InterfaceAlias '${alias}' -IPAddress '${address}' -PrefixLength ${prefix} | Out-Null`;
    })
    .join("\n");
}

const RESTORE = (alias: string, previous: WindowsNetworkState) =>
  [
    clearAddresses(alias),
    restoreAddressing(alias, previous),
    previous.category
      ? `Set-NetConnectionProfile -InterfaceAlias '${alias}' -NetworkCategory ${previous.category} -ErrorAction SilentlyContinue`
      : "",
  ]
    .filter((line) => line !== "")
    .join("\n");

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
    const conforming = hasAddress && isPrivate && !current.dhcpEnabled;

    return {
      conforming,
      current,
      detail: conforming
        ? `${config.windows.interfaceAlias} deja en ${target}, profil prive`
        : `adresse ${hasAddress ? "correcte" : "absente"}, profil ${current.category ?? "inconnu"}${current.dhcpEnabled ? ", DHCP actif" : ""}`,
    };
  },

  async apply(config: Config) {
    await runRemoteChecked(
      config.ssh,
      APPLY(
        config.windows.interfaceAlias,
        config.windows.ip,
        config.windows.prefixLength,
      ),
    );
  },

  async restore(config: Config, previous: WindowsNetworkState) {
    await runRemoteChecked(
      config.ssh,
      RESTORE(config.windows.interfaceAlias, previous),
    );
  },
};
