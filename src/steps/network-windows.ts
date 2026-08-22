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
 * l'un sans l'autre ne serait pas rendre l'etat anterieur.
 *
 * Les adresses enregistrees sont reposees AVANT de toucher au client DHCP :
 * l'ordre inverse ferait reposer tout l'invariant sur une affirmation non
 * verifiee — que `-Dhcp Enabled` laisse les adresses `Manual` en place. Reposer
 * d'abord ne coute rien et supprime l'hypothese.
 *
 * Le prefixe est traite comme dans APPLY : une adresse presente avec le mauvais
 * prefixe est corrigee sur place, jamais retiree puis reposee.
 */
function restoreAddressing(
  alias: string,
  previous: WindowsNetworkState,
): string[] {
  const lines: string[] = [];

  for (const entry of previous.manualAddresses) {
    const [address, prefix] = entry.split("/");
    lines.push(
      `$prev = Get-NetIPAddress -InterfaceAlias '${alias}' -AddressFamily IPv4 -IPAddress '${address}' -ErrorAction SilentlyContinue`,
      `if ($prev) {`,
      `  if ($prev.PrefixLength -ne ${prefix}) {`,
      `    Set-NetIPAddress -InterfaceAlias '${alias}' -IPAddress '${address}' -PrefixLength ${prefix} | Out-Null`,
      `  }`,
      `} else {`,
      `  New-NetIPAddress -InterfaceAlias '${alias}' -IPAddress '${address}' -PrefixLength ${prefix} | Out-Null`,
      `}`,
    );
  }

  if (previous.dhcpEnabled) {
    lines.push(`Set-NetIPInterface -InterfaceAlias '${alias}' -Dhcp Enabled`);
  }

  return lines;
}

/**
 * `Set-NetConnectionProfile -NetworkCategory` n'accepte que Public et Private.
 * DomainAuthenticated est une valeur que Windows s'attribue lui-meme quand un
 * controleur de domaine est joignable ; la lui passer est une erreur de liaison
 * de parametre, que -ErrorAction SilentlyContinue ne peut pas etouffer. Sur un
 * PC joint a un domaine, uninstall echouait donc a tous les coups.
 *
 * La seule restitution correcte est de ne rien ecrire et de laisser Windows
 * reclasser l'interface. L'etape ne pretend rien restituer dans ce cas : elle
 * n'emet aucune instruction de profil.
 */
const ASSIGNABLE_CATEGORIES = new Set(["Public", "Private"]);

function setProfileStatement(
  alias: string,
  category: WindowsNetworkState["category"],
): string | null {
  if (!category || !ASSIGNABLE_CATEGORIES.has(category)) return null;
  return `Set-NetConnectionProfile -InterfaceAlias '${alias}' -NetworkCategory ${category} -ErrorAction SilentlyContinue`;
}

const removeStatement = (alias: string, ip: string): string =>
  `Remove-NetIPAddress -InterfaceAlias '${alias}' -IPAddress '${ip}' -Confirm:$false -ErrorAction SilentlyContinue`;

/**
 * Un processus detache qui survit a la fermeture de la session SSH. Les `$` du
 * script confie doivent etre echappes en `` `$ `` : sans cet echappement, le
 * shell appelant developpe $false en chaine vide et Remove-NetIPAddress
 * reclame une confirmation interactive que personne ne donnera jamais.
 */
const detachTail = (statements: string[]): string =>
  "Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-Command'," +
  `"Start-Sleep -Seconds 2; ${statements.join("; ").replaceAll("$", "`$")}"`;

/**
 * Tout ce qui peut couper le canal part ensemble, en dernier.
 *
 * Deux instructions coupent la session : le retrait de l'adresse qui la porte,
 * et le retour du profil a Public — la regle de pare-feu qui ouvre le port 22
 * est portee sur le profil Private, et la tache de maintien du profil a deja
 * ete supprimee par l'etape precedente de l'uninstall. Les separer, en
 * particulier flipper le profil avant de retirer l'adresse, tue la session au
 * milieu du script : le retrait n'a jamais lieu et 10.10.10.1 reste orpheline
 * sur un PC devenu injoignable.
 *
 * Les deux forment donc une queue indivisible, executee en ligne quand la
 * session ne roule pas sur l'adresse visee, et deleguee a un processus detache
 * quand elle y roule — pour qu'une restauration reussie ne remonte pas en echec
 * et que l'orchestrateur n'ait pas a conserver une entree de manifeste pour une
 * etape deja restauree. Dans la queue, le retrait precede le profil : si le
 * processus detache mourait entre les deux, mieux vaut une adresse rendue et un
 * profil de trop qu'une adresse orpheline.
 */
const RESTORE = (
  alias: string,
  ip: string,
  previous: WindowsNetworkState,
): string => {
  const lines = restoreAddressing(alias, previous);

  const tail: string[] = [];

  // Si le PC portait deja cette adresse avant hardline, la retirer serait
  // detruire l'etat anterieur au lieu de le rendre.
  const preexisting = previous.addresses.some(
    (entry) => entry.split("/")[0] === ip,
  );
  if (!preexisting) tail.push(removeStatement(alias, ip));

  const profile = setProfileStatement(alias, previous.category);
  if (profile) tail.push(profile);

  if (tail.length > 0) {
    lines.push(
      SSH_LOCAL_ADDRESS,
      `if ($sshLocal -eq '${ip}') {`,
      `  ${detachTail(tail)}`,
      `} else {`,
      ...tail.map((statement) => `  ${statement}`),
      `}`,
    );
  }

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
