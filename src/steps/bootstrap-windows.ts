import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import type { Config } from "../config";
import { detachTail } from "./detach";
import type { Step } from "./types";

/**
 * L'amorcage tourne AVANT que hardline sache parler au PC : rien de ce qu'il
 * modifie n'est observable apres coup. Le seul releve honnete est celui que
 * bootstrap.ps1 ecrit lui-meme sur le PC, avant de toucher a quoi que ce soit.
 * Cette etape ne fait que rapatrier ce releve dans le manifeste, puis s'en
 * servir pour defaire — et uniquement ce dont l'amorcage se declare l'auteur.
 */
export const STATE_DIR = "(Join-Path $env:ProgramData 'hardline')";
export const STATE_FILE = "bootstrap-state.json";
/**
 * L'accuse de reception est un fichier voisin plutot qu'un champ du releve :
 * le releve doit rester rigoureusement immuable une fois ecrit, et une
 * relecture-reecriture JSON introduirait une fenetre ou une coupure le
 * laisserait tronque. Un marqueur separe ne peut rien abimer.
 */
export const ACK_FILE = "bootstrap-state.acknowledged";

const statePath = `(Join-Path ${STATE_DIR} '${STATE_FILE}')`;
const ackPath = `(Join-Path ${STATE_DIR} '${ACK_FILE}')`;

/** Le releve ecrit par bootstrap.ps1. Les `changed` disent ce dont il est l'auteur. */
export type BootstrapCapture = {
  version: number;
  capturedAt: string;
  interfaceAlias: string;
  capability: { name: string | null; state: string | null; changed: boolean };
  sshd: {
    present: boolean;
    startupType: string | null;
    status: string | null;
    startupChanged: boolean;
    statusChanged: boolean;
  };
  firewall: { name: string; existed: boolean; changed: boolean };
  authorizedKeys: {
    path: string;
    publicKey: string;
    fileExisted: boolean;
    keyPresent: boolean;
    aclSddl: string | null;
    changed: boolean;
    aclChanged: boolean;
  };
  network: {
    /** Toutes les adresses IPv4 d'avant amorcage, au format "adresse/prefixe". */
    addresses: string[];
    /** Celles de PrefixOrigin 'Manual' : les seules a reposer. */
    manualAddresses: string[];
    dhcp: string | null;
    category: string | null;
    addressingChanged: boolean;
    categoryChanged: boolean;
  };
};

export type BootstrapState = {
  /** null quand le PC ne porte aucun releve : on ne l'invente pas. */
  capture: BootstrapCapture | null;
  acknowledged: boolean;
};

const INSPECT = `
$path = ${statePath}
$capture = $null
if (Test-Path $path) {
  $raw = Get-Content -Path $path -Raw -ErrorAction SilentlyContinue
  if ($raw) { $capture = $raw | ConvertFrom-Json }
}
[pscustomobject]@{
  capture      = $capture
  acknowledged = [bool](Test-Path ${ackPath})
}`;

/**
 * `apply` ne modifie rien du PC : il accuse reception du releve, maintenant que
 * le manifeste du Mac en detient une copie. Sans cet accuse, `inspect` rendrait
 * toujours « non conforme » et l'etape serait reappliquee a chaque install ;
 * avec lui, elle devient conforme et le reste.
 */
const APPLY = `
$dir = ${STATE_DIR}
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
Set-Content -Path ${ackPath} -Value (Get-Date).ToString('s') -Encoding ascii`;

// --- Restauration. -------------------------------------------------------

const ASSIGNABLE_CATEGORIES = new Set(["Public", "Private"]);

/**
 * Repose l'adressage d'avant amorcage. Meme discipline que l'etape reseau :
 * seules les adresses posees a la main sont reposees — celles obtenues par
 * DHCP reviennent avec le client DHCP — et un prefixe errone est corrige sur
 * place plutot que retire puis repose.
 */
function restoreAddressing(alias: string, capture: BootstrapCapture): string[] {
  const lines: string[] = [];

  for (const entry of capture.network.manualAddresses ?? []) {
    const [address, prefix] = entry.split("/");
    lines.push(
      `$prev = Get-NetIPAddress -InterfaceAlias '${alias}' -AddressFamily IPv4 -IPAddress '${address}' -ErrorAction SilentlyContinue`,
      `if ($prev) { if ($prev.PrefixLength -ne ${prefix}) { Set-NetIPAddress -InterfaceAlias '${alias}' -IPAddress '${address}' -PrefixLength ${prefix} | Out-Null } } else { New-NetIPAddress -InterfaceAlias '${alias}' -IPAddress '${address}' -PrefixLength ${prefix} | Out-Null }`,
    );
  }

  if (capture.network.dhcp === "Enabled") {
    lines.push(`Set-NetIPInterface -InterfaceAlias '${alias}' -Dhcp Enabled -ErrorAction SilentlyContinue`);
  }

  return lines;
}

/**
 * Le retrait de la cle du Mac. Le fichier est reecrit sans la ligne plutot que
 * supprime : un compte administrateur peut y avoir d'autres cles, et les
 * emporter serait couper l'acces de quelqu'un d'autre. En ascii et non en
 * utf8, car PowerShell 5.1 pose une marque d'ordre des octets en utf8 qui rend
 * le fichier silencieusement illisible pour OpenSSH.
 */
function restoreAuthorizedKeys(capture: BootstrapCapture): string[] {
  const keys = capture.authorizedKeys;
  const lines: string[] = [];

  // Le fichier n'existait pas : l'amorcage l'a cree, donc il repart entier et
  // il n'y a aucun descripteur de securite d'origine a rendre.
  if (!keys.fileExisted) {
    if (keys.changed) {
      lines.push(
        `Remove-Item -Path '${keys.path}' -Force -ErrorAction SilentlyContinue`,
      );
    }
    return lines;
  }

  if (keys.changed) {
    lines.push(
      `$kept = @(Get-Content -Path '${keys.path}' -ErrorAction SilentlyContinue | Where-Object { $_.Trim() -ne '${keys.publicKey}' })`,
      `Set-Content -Path '${keys.path}' -Value $kept -Encoding ascii -ErrorAction SilentlyContinue`,
    );
  }

  // icacls /inheritance:r a reecrit les droits d'un fichier qui existait deja,
  // que la cle y ait ete ajoutee ou non. Le descripteur de securite d'origine a
  // ete releve : le rendre est la seule facon de ne pas laisser un fichier
  // commun avec des droits que hardline lui a imposes.
  if (keys.aclChanged && keys.aclSddl) {
    lines.push(
      `$acl = Get-Acl -Path '${keys.path}'`,
      `$acl.SetSecurityDescriptorSddlForm('${keys.aclSddl}')`,
      `Set-Acl -Path '${keys.path}' -AclObject $acl -ErrorAction SilentlyContinue`,
    );
  }

  return lines;
}

/**
 * Ce que l'amorcage a fait et qui coupe le canal en le defaisant. Tout y passe :
 * l'adresse qui porte la session, le profil qui autorise la regle de pare-feu,
 * la regle elle-meme, la cle qui a authentifie la session, et sshd. Contrairement
 * a l'etape reseau, il n'y a rien a conditionner : la session roule TOUJOURS sur
 * au moins un de ces elements, quelle que soit son adresse locale. La queue part
 * donc toujours detachee.
 *
 * L'ordre est celui du degat decroissant si le processus detache mourait en
 * cours de route. Chaque prefixe laisse le PC sur un reseau qu'il connaissait
 * deja, et ce sont les moyens d'acces — cle, regle, service — qui tombent en
 * dernier :
 *
 *   1-3. l'adressage d'origine revient, puis seulement apres, celui de hardline
 *        s'en va : a aucun instant l'interface n'est sans adresse ;
 *   4.   le profil reseau d'origine revient ;
 *   5-6. la cle du Mac et les droits du fichier ;
 *   7-8. la regle de pare-feu puis sshd.
 */
function cuttingTail(
  alias: string,
  ip: string,
  capture: BootstrapCapture,
): string[] {
  const tail: string[] = [];

  if (capture.network.addressingChanged) {
    tail.push(...restoreAddressing(alias, capture));
    // L'adresse posee par l'amorcage. Si le PC la portait deja avant, le releve
    // dit addressingChanged = false et on n'arrive jamais ici : la retirer
    // serait detruire l'etat anterieur au lieu de le rendre.
    tail.push(
      `Remove-NetIPAddress -InterfaceAlias '${alias}' -IPAddress '${ip}' -Confirm:$false -ErrorAction SilentlyContinue`,
    );
  }

  const category = capture.network.category;
  if (
    capture.network.categoryChanged &&
    category &&
    ASSIGNABLE_CATEGORIES.has(category)
  ) {
    // Set-NetConnectionProfile n'accepte que Public et Private :
    // DomainAuthenticated est une erreur de liaison de parametre qu'aucun
    // -ErrorAction ne peut etouffer. On n'ecrit alors rien et on laisse
    // Windows reclasser l'interface lui-meme.
    tail.push(
      `Set-NetConnectionProfile -InterfaceAlias '${alias}' -NetworkCategory ${category} -ErrorAction SilentlyContinue`,
    );
  }

  tail.push(...restoreAuthorizedKeys(capture));

  if (capture.firewall.changed) {
    tail.push(
      `Remove-NetFirewallRule -Name '${capture.firewall.name}' -ErrorAction SilentlyContinue`,
    );
  }

  // La capacite Windows OpenSSH.Server n'est jamais desinstallee : le retrait
  // d'une capacite est invasif, peut exiger un redemarrage, et l'utilisateur
  // peut legitimement vouloir garder un serveur SSH. On rend le service a son
  // demarrage d'origine, rien de plus.
  //
  // Quand sshd n'existait pas du tout avant l'amorcage, le releve n'a pas de
  // demarrage d'origine a rendre. Le laisser en Automatic reviendrait a laisser
  // en ecoute permanente un service que la machine n'avait pas : on le desactive,
  // et l'uninstall le dit.
  if (capture.sshd.startupChanged) {
    const startupType = capture.sshd.present
      ? (capture.sshd.startupType ?? "Disabled")
      : "Disabled";
    tail.push(
      `Set-Service -Name sshd -StartupType ${startupType} -ErrorAction SilentlyContinue`,
    );
  }
  if (capture.sshd.statusChanged) {
    tail.push("Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue");
  }

  return tail;
}

/**
 * Le releve lui-meme n'est PAS supprime. Il reste la seule trace de l'etat
 * d'avant amorcage, et la queue est detachee : son echec n'est pas observable
 * depuis le Mac, qui aura pourtant deja oublie l'entree du manifeste. Le
 * laisser sur le PC, c'est garder de quoi recommencer.
 *
 * L'accuse de reception, lui, part : une installation ulterieure retrouvera
 * alors le releve non acquitte, donc non conforme, donc reenregistre.
 */
const RESTORE = (
  alias: string,
  ip: string,
  capture: BootstrapCapture,
): string => {
  const tail = cuttingTail(alias, ip, capture);
  const lines = [`Remove-Item -Path ${ackPath} -Force -ErrorAction SilentlyContinue`];
  if (tail.length > 0) lines.push(detachTail(tail));
  return lines.join("\n");
};

// --- L'etape. ------------------------------------------------------------

export const bootstrapWindowsStep: Step<BootstrapState> = {
  name: "bootstrap-windows",
  label: "Amorçage du PC : OpenSSH, pare-feu, clé et adressage (PC)",

  async inspect(config: Config) {
    const rows = await runRemoteJson<BootstrapState>(config.ssh, INSPECT);
    const current = rows[0];

    if (!current) {
      throw new Error(
        "Le PC n'a renvoyé aucun état d'amorçage. Vérifier la liaison SSH.",
      );
    }

    const capture = current.capture ?? null;

    // Un PC amorcé par une version antérieure de hardline n'a pas de relevé.
    // On ne bloque pas l'installation pour autant, et on n'invente surtout pas
    // un état antérieur : on le dit, et on ne promet rien.
    if (!capture) {
      return {
        conforming: true,
        current: { capture: null, acknowledged: current.acknowledged },
        detail:
          "aucun relevé d'amorçage sur le PC : ce que l'amorçage a modifié ne pourra pas être défait",
      };
    }

    return {
      conforming: current.acknowledged,
      current: { capture, acknowledged: current.acknowledged },
      detail: current.acknowledged
        ? `relevé d'amorçage du ${capture.capturedAt} déjà enregistré`
        : `relevé d'amorçage du ${capture.capturedAt} à enregistrer`,
    };
  },

  async apply(config: Config) {
    await runRemoteChecked(config.ssh, APPLY);
  },

  async restore(config: Config, previous: BootstrapState) {
    // Rien de connu, donc rien a defaire. Ne pas confondre avec « rien a
    // faire » : le detail d'inspect l'a dit, et l'entree n'existe pas.
    if (!previous.capture) return;

    await runRemoteChecked(
      config.ssh,
      RESTORE(config.windows.interfaceAlias, config.windows.ip, previous.capture),
    );
  },
};
