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

/**
 * L'adresse locale qui porte la session SSH en cours. Tout ce que hardline
 * execute sur le PC transite par elle : la supprimer coupe la connexion, tue
 * le processus enfant cote sshd, et le reste du script n'est jamais execute.
 * C'est exactement ainsi qu'on laisse un PC sans aucune adresse sur le lien
 * direct, donc sans aucun moyen d'y revenir sans acces physique.
 */
const SSH_LOCAL_ADDRESS =
  "$sshLocal = (Get-NetTCPConnection -LocalPort 22 -State Established -ErrorAction SilentlyContinue | Select-Object -First 1).LocalAddress";

/**
 * L'adresse cible d'abord, le menage ensuite. Tant que New-NetIPAddress n'a
 * pas reussi, la session roule encore sur l'ancienne configuration ; une fois
 * qu'il a reussi, l'interface porte deja la configuration cible et une
 * interruption a n'importe quel point suivant laisse le PC joignable.
 */
const APPLY = (alias: string, ip: string, prefix: number) => `
${SSH_LOCAL_ADDRESS}
$target = Get-NetIPAddress -InterfaceAlias '${alias}' -AddressFamily IPv4 -IPAddress '${ip}' -ErrorAction SilentlyContinue
if ($target) {
  if ($target.PrefixLength -ne ${prefix}) {
    Set-NetIPAddress -InterfaceAlias '${alias}' -IPAddress '${ip}' -PrefixLength ${prefix} | Out-Null
  }
} else {
  New-NetIPAddress -InterfaceAlias '${alias}' -IPAddress '${ip}' -PrefixLength ${prefix} | Out-Null
}
Get-NetIPAddress -InterfaceAlias '${alias}' -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -ne '${ip}' -and $_.IPAddress -ne $sshLocal } |
  Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
Set-NetIPInterface -InterfaceAlias '${alias}' -Dhcp Disabled -ErrorAction SilentlyContinue
Set-NetConnectionProfile -InterfaceAlias '${alias}' -NetworkCategory Private`;

/**
 * Windows accepte le client DHCP et des adresses fixes en meme temps : rendre
 * l'un sans l'autre ne serait pas rendre l'etat anterieur. Le DHCP est reactive
 * en premier pour que sa remise en route n'interfere pas avec les adresses
 * qu'on vient de reposer.
 */
function restoreAddressing(
  alias: string,
  previous: WindowsNetworkState,
): string[] {
  const lines: string[] = [];

  if (previous.dhcpEnabled) {
    lines.push(`Set-NetIPInterface -InterfaceAlias '${alias}' -Dhcp Enabled`);
  }

  for (const entry of previous.manualAddresses) {
    const [address, prefix] = entry.split("/");
    lines.push(
      `if (-not (Get-NetIPAddress -InterfaceAlias '${alias}' -AddressFamily IPv4 -IPAddress '${address}' -ErrorAction SilentlyContinue)) {`,
      `  New-NetIPAddress -InterfaceAlias '${alias}' -IPAddress '${address}' -PrefixLength ${prefix} | Out-Null`,
      `}`,
    );
  }

  return lines;
}

/**
 * Le retrait de l'adresse de hardline vient en dernier, une fois l'etat
 * anterieur reellement en place. S'il coupe la session — c'est le cas des que
 * la session roule sur cette adresse — la commande SSH doit quand meme rendre
 * la main proprement : le retrait est alors delegue a un processus detache qui
 * survit a la fermeture de la session. Sans ce detour, un retrait pourtant
 * reussi remonterait en echec et l'orchestrateur conserverait une entree de
 * manifeste pour une etape deja restauree.
 */
const dropOwnAddress = (alias: string, ip: string): string[] => [
  SSH_LOCAL_ADDRESS,
  `if ($sshLocal -eq '${ip}') {`,
  `  Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',"Start-Sleep -Seconds 2; Remove-NetIPAddress -InterfaceAlias '${alias}' -IPAddress '${ip}' -Confirm:\`$false -ErrorAction SilentlyContinue"`,
  `} else {`,
  `  Remove-NetIPAddress -InterfaceAlias '${alias}' -IPAddress '${ip}' -Confirm:$false -ErrorAction SilentlyContinue`,
  `}`,
];

const RESTORE = (
  alias: string,
  ip: string,
  previous: WindowsNetworkState,
): string => {
  const lines = restoreAddressing(alias, previous);

  if (previous.category) {
    lines.push(
      `Set-NetConnectionProfile -InterfaceAlias '${alias}' -NetworkCategory ${previous.category} -ErrorAction SilentlyContinue`,
    );
  }

  // Si le PC portait deja cette adresse avant hardline, la retirer serait
  // detruire l'etat anterieur au lieu de le rendre.
  const preexisting = previous.addresses.some(
    (entry) => entry.split("/")[0] === ip,
  );
  if (!preexisting) lines.push(...dropOwnAddress(alias, ip));

  return lines.join("\n");
};

export const windowsNetworkStep: Step<WindowsNetworkState> = {
  name: "network-windows",
  label: "Adresse fixe et profil privé sur le lien direct (PC)",

  async inspect(config: Config) {
    const rows = await runRemoteJson<WindowsNetworkState>(
      config.ssh,
      INSPECT(config.windows.interfaceAlias),
    );
    const current = rows[0];

    if (!current) {
      throw new Error(
        "Le PC n'a renvoyé aucun état réseau. Vérifier la liaison SSH.",
      );
    }
    if (!current.adapterPresent) {
      throw new Error(
        `L'interface «\u00a0${config.windows.interfaceAlias}\u00a0» n'existe pas sur le PC. Vérifier le nom ou le branchement du câble.`,
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
        ? `${config.windows.interfaceAlias} déjà en ${target}, profil privé`
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
      RESTORE(config.windows.interfaceAlias, config.windows.ip, previous),
    );
  },
};
