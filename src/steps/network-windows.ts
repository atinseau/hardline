import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import type { Config } from "../config";
import { BOOTSTRAP_STEP_NAME } from "./bootstrap-name";
import { SSH_LOCAL_ADDRESS, detachTail } from "./detach";
import type { RestoreContext, Step } from "./types";

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
 * Les adresses enregistrees sont reposees AVANT de toucher au client DHCP.
 * Cet ordre ne supprime pas l'hypothese que `-Dhcp Enabled` laisse les adresses
 * `Manual` en place — si elle etait fausse, l'activation effacerait aussi celle
 * qu'on vient de reposer. Il garantit seulement que la repose est TENTEE en
 * premier, donc qu'une repose qui echoue interrompt le script apres l'essai et
 * non avant. L'hypothese elle-meme tient : le decoupage `addresses` /
 * `manualAddresses` que renvoie INSPECT presuppose deja la coexistence.
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
 * Le profil peut ne rien restituer, et cela ne peut pas etre observe. Le dire
 * ici est la seule honnetete disponible.
 *
 * Si le retrait de l'adresse laisse l'interface sans aucune adresse IPv4 (aucune
 * adresse manuelle au releve, ou un bail DHCP pas encore obtenu a l'instant ou
 * la queue s'execute) Windows ne lui associe plus aucun profil reseau, et
 * Set-NetConnectionProfile echoue sans bruit sous -ErrorAction SilentlyContinue.
 *
 * Rendre cet echec observable depuis le Mac est impossible, et ce n'est pas une
 * negligence : la queue est detachee PRECISEMENT parce qu'elle coupe le seul
 * canal qui mene ici. Quand elle s'execute, l'adresse est partie et le profil
 * Public a referme la regle de pare-feu ; plus rien ne peut remonter. Un journal
 * ecrit sur le PC ne serait lisible que depuis le clavier du PC, ou
 * Get-NetConnectionProfile repond deja la question plus surement qu'un fichier
 * ne le ferait, et ce fichier survivrait a une desinstallation qui promet de ne
 * rien laisser derriere elle.
 *
 * Ce qui borne le degat : le cas ne survient que sur une interface qui n'avait
 * pas d'adressage propre avant hardline, et Windows reclasse l'interface de
 * lui-meme des qu'elle en retrouve un.
 *
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

  /**
   * Une seule queue detachee coupante par desinstallation, et elle appartient a
   * la DERNIERE restauration qui passe.
   *
   * `revertSteps` enchaine les restaurations sans attendre : celle-ci rend la
   * main des que Start-Process est lance, sa charge dort deux secondes, puis
   * retire l'adresse et repose le profil. Or l'etape d'amorcage, restauree
   * apres, doit d'abord OUVRIR une session SSH neuve — connexion plus demarrage
   * de powershell, souvent plus de deux secondes a froid. Les deux comptes a
   * rebours se recouvraient : la charge d'ici tuait la session de la-bas au
   * milieu de son travail, et le PC restait injoignable avec son adressage
   * d'origine jamais repose. C'est exactement le degat que la vague 3 existe
   * pour supprimer, deplace de l'installation vers la desinstallation.
   *
   * Quand l'amorcage suit, cette etape n'a de toute facon rien d'utile a
   * rendre : son « etat anterieur » est l'etat d'APRES amorcage, tandis que le
   * releve d'amorcage decrit le PC d'avant hardline. Elle s'efface entierement,
   * plutot que de n'omettre que sa queue — la moitie non coupante ne ferait que
   * reposer des adresses que l'amorcage s'apprete a defaire.
   */
  async restore(
    config: Config,
    previous: WindowsNetworkState,
    context: RestoreContext,
  ) {
    if (context.pending.includes(BOOTSTRAP_STEP_NAME)) {
      return {
        yielded:
          "restauration cédée au relevé d'amorçage, seul à décrire le PC d'avant hardline",
      };
    }

    await runRemoteChecked(
      config.ssh,
      RESTORE(config.windows.interfaceAlias, config.windows.ip, previous),
    );
  },
};
