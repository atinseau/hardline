import { psInteger, psKeyword, psQuote } from "../lib/powershell";
import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import type { Config } from "../config";
import { BOOTSTRAP_STEP_NAME } from "./bootstrap-name";
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

/** La seule version de releve que cette version de hardline sait lire. */
export const CAPTURE_VERSION = 1;

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

/** Pourquoi il n'y a pas de releve exploitable. Sert a le dire, pas a deviner. */
export type CaptureDefect = "absent" | "illisible" | "version";

export type BootstrapState = {
  /** null quand le PC ne porte aucun releve exploitable : on ne l'invente pas. */
  capture: BootstrapCapture | null;
  acknowledged: boolean;
  /** Rempli par le PC : le fichier existe mais n'a pas pu etre relu. */
  unreadable?: boolean;
};

/**
 * Le `try/catch` n'est pas une decoration : le script tourne sous
 * $ErrorActionPreference = 'Stop', prependu par runRemoteJson. Sans lui, un
 * bootstrap-state.json corrompu — edite a la main, abime par un secteur mort,
 * ecrit par une version future — fait sortir powershell en 1, et TOUTE la
 * convergence distante s'arrete a la premiere etape. Un fichier dont l'unique
 * raison d'etre est d'aider plus tard ne doit jamais empecher une installation.
 */
const INSPECT = `
$path = ${statePath}
$capture = $null
$unreadable = $false
if (Test-Path $path) {
  $raw = Get-Content -Path $path -Raw -ErrorAction SilentlyContinue
  if ($raw) {
    try { $capture = $raw | ConvertFrom-Json } catch { $capture = $null; $unreadable = $true }
  } else {
    $unreadable = $true
  }
}
[pscustomobject]@{
  capture      = $capture
  acknowledged = [bool](Test-Path ${ackPath})
  unreadable   = [bool]$unreadable
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

// --- Validation du releve. -----------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Un cast sans verification laisserait la restauration coudre des champs dont
 * elle ignore la forme, ou dereferencer des champs absents. Le manifeste du
 * projet refuse deja franchement tout ce qui n'est pas `version === 1` : la
 * meme rigueur vaut pour ce que le PC renvoie.
 *
 * Rend `null` plutot que de lever : un releve inexploitable doit degrader
 * exactement comme un releve absent, jamais bloquer une installation.
 */
export function readCapture(
  value: unknown,
): { capture: BootstrapCapture } | { defect: CaptureDefect } {
  if (!isRecord(value)) return { defect: "absent" };
  if (value["version"] !== CAPTURE_VERSION) return { defect: "version" };

  for (const section of [
    "capability",
    "sshd",
    "firewall",
    "authorizedKeys",
    "network",
  ]) {
    if (!isRecord(value[section])) return { defect: "illisible" };
  }

  const network = value["network"] as Record<string, unknown>;
  if (
    !Array.isArray(network["addresses"]) ||
    !Array.isArray(network["manualAddresses"])
  ) {
    return { defect: "illisible" };
  }

  return { capture: value as unknown as BootstrapCapture };
}

// --- Restauration. -------------------------------------------------------

const ASSIGNABLE_CATEGORIES = ["Public", "Private"] as const;

/** Les seules valeurs que Get-Service peut rendre pour StartType. */
const STARTUP_TYPES = [
  "Automatic",
  "Manual",
  "Disabled",
  "Boot",
  "System",
] as const;

/**
 * Repose l'adressage d'avant amorcage. Meme discipline que l'etape reseau :
 * seules les adresses posees a la main sont reposees — celles obtenues par
 * DHCP reviennent avec le client DHCP — et un prefixe errone est corrige sur
 * place plutot que retire puis repose.
 */
function restoreAddressing(alias: string, capture: BootstrapCapture): string[] {
  const lines: string[] = [];
  const quotedAlias = psQuote(alias, "interfaceAlias");

  for (const entry of capture.network.manualAddresses ?? []) {
    const [address, prefix] = String(entry).split("/");
    const quoted = psQuote(address ?? "", `adresse relevée «\u00a0${entry}\u00a0»`);
    const length = psInteger(prefix, `préfixe de «\u00a0${entry}\u00a0»`, 32);
    lines.push(
      `$prev = Get-NetIPAddress -InterfaceAlias ${quotedAlias} -AddressFamily IPv4 -IPAddress ${quoted} -ErrorAction SilentlyContinue`,
      `if ($prev) { if ($prev.PrefixLength -ne ${length}) { Set-NetIPAddress -InterfaceAlias ${quotedAlias} -IPAddress ${quoted} -PrefixLength ${length} | Out-Null } } else { New-NetIPAddress -InterfaceAlias ${quotedAlias} -IPAddress ${quoted} -PrefixLength ${length} | Out-Null }`,
    );
  }

  if (capture.network.dhcp === "Enabled") {
    lines.push(
      `Set-NetIPInterface -InterfaceAlias ${quotedAlias} -Dhcp Enabled -ErrorAction SilentlyContinue`,
    );
  }

  return lines;
}

/**
 * Le retrait de la cle du Mac, en LISANT avant d'ecrire.
 *
 * C'etaient les deux seules instructions du lot a modifier sans regarder l'etat
 * courant, et c'est precisement la que l'argument « un drapeau leve pour une
 * modification qui n'a pas eu lieu reste sans effet » tombait :
 *
 * - `fileExisted: false` releve des semaines plus tot faisait supprimer le
 *   fichier ENTIER. Amorcage mort pendant Add-WindowsCapability, utilisateur
 *   qui installe OpenSSH et depose sa propre cle, relance de l'amorcage (le
 *   releve n'est jamais reecrit, par conception) : l'uninstall emportait la cle
 *   de l'utilisateur et coupait son propre acces.
 * - la reecriture partait des que `changed` etait vrai, meme si la ligne du Mac
 *   n'avait jamais ete ajoutee : les cles des autres administrateurs etaient
 *   re-encodees en ascii, et un `Get-Content` muet (fichier verrouille, chemin
 *   devenu faux) faisait ecrire `$kept` vide, donc un fichier a zero octet.
 *
 * La forme ci-dessous n'ecrit QUE si la ligne du Mac a reellement ete trouvee
 * — `$kept.Count -lt $lines.Count` est faux quand le fichier est illisible,
 * vide, ou ne contient pas la cle — et ne supprime le fichier que si l'amorcage
 * l'avait cree ET qu'il ne reste plus rien dedans. Toute autre ligne est laissee
 * telle quelle : ni retiree, ni re-encodee.
 *
 * En ascii et non en utf8 : PowerShell 5.1 pose une marque d'ordre des octets
 * en utf8 qui rend le fichier silencieusement illisible pour OpenSSH.
 */
function restoreAuthorizedKeys(capture: BootstrapCapture): string[] {
  const keys = capture.authorizedKeys;
  const lines: string[] = [];
  const path = psQuote(keys.path, "chemin du fichier de clés");
  const publicKey = psQuote(keys.publicKey, "clé publique relevée");

  if (keys.changed) {
    // Vide, le fichier repart si l'amorcage l'avait cree ; sinon il reste, vide.
    const emptied = keys.fileExisted
      ? `Clear-Content -Path ${path} -Force -ErrorAction SilentlyContinue`
      : `Remove-Item -Path ${path} -Force -ErrorAction SilentlyContinue`;

    lines.push(
      `$lines = @(Get-Content -Path ${path} -ErrorAction SilentlyContinue)`,
      `$kept = @($lines | Where-Object { $_.Trim() -ne ${publicKey} })`,
      `if ($kept.Count -lt $lines.Count) { if ($kept.Count -eq 0) { ${emptied} } else { Set-Content -Path ${path} -Value $kept -Encoding ascii -ErrorAction SilentlyContinue } }`,
    );
  }

  // icacls /inheritance:r a reecrit les droits d'un fichier qui existait deja,
  // que la cle y ait ete ajoutee ou non. Le descripteur de securite d'origine a
  // ete releve : le rendre est la seule facon de ne pas laisser un fichier
  // commun avec des droits que hardline lui a imposes.
  if (keys.aclChanged && keys.aclSddl) {
    const sddl = psQuote(keys.aclSddl, "descripteur de sécurité relevé");
    lines.push(
      `if (Test-Path ${path}) { $acl = Get-Acl -Path ${path}; $acl.SetSecurityDescriptorSddlForm(${sddl}); Set-Acl -Path ${path} -AclObject $acl -ErrorAction SilentlyContinue }`,
    );
  }

  return lines;
}

/**
 * Ce que l'amorcage a fait et qui coupe le canal en le defaisant. Tout y passe :
 * l'adresse qui porte la session, le profil qui autorise la regle de pare-feu,
 * la regle elle-meme, la cle qui a authentifie la session, et sshd. Contrairement
 * a l'etape reseau, il n'y a rien a conditionner sur l'adresse locale : la session
 * roule TOUJOURS sur au moins un de ces elements. La queue part donc toujours
 * detachee.
 *
 * L'ordre est celui du degat decroissant si le processus detache mourait en
 * cours de route. Chaque prefixe laisse le PC sur un reseau qu'il connaissait
 * deja, et ce sont les moyens d'acces qui tombent en dernier :
 *
 *   1-3. l'adressage d'origine revient, puis seulement apres, celui de hardline
 *        s'en va : a aucun instant l'interface n'est sans adresse ;
 *   4.   le profil reseau d'origine revient — c'est LUI qui ferme la porte, la
 *        regle hardline-sshd etant portee sur le profil Private ;
 *   5-6. la cle du Mac et les droits du fichier ;
 *   7-8. la regle de pare-feu puis sshd.
 */
function cuttingTail(
  alias: string,
  ip: string,
  capture: BootstrapCapture,
): string[] {
  const tail: string[] = [];
  const quotedAlias = psQuote(alias, "interfaceAlias");

  if (capture.network.addressingChanged) {
    tail.push(...restoreAddressing(alias, capture));
    // L'adresse posee par l'amorcage. Si le PC la portait deja avant, le releve
    // dit addressingChanged = false et on n'arrive jamais ici : la retirer
    // serait detruire l'etat anterieur au lieu de le rendre.
    tail.push(
      `Remove-NetIPAddress -InterfaceAlias ${quotedAlias} -IPAddress ${psQuote(ip, "adresse cible")} -Confirm:$false -ErrorAction SilentlyContinue`,
    );
  }

  const category = capture.network.category;
  if (
    capture.network.categoryChanged &&
    category &&
    (ASSIGNABLE_CATEGORIES as readonly string[]).includes(category)
  ) {
    // Deux gardes en une instruction.
    //
    // Set-NetConnectionProfile n'accepte que Public et Private :
    // DomainAuthenticated est une erreur de liaison de parametre qu'aucun
    // -ErrorAction ne peut etouffer. On n'ecrit alors rien et on laisse Windows
    // reclasser l'interface lui-meme.
    //
    // Et on ne repose la categorie que si l'interface porte encore celle que
    // l'amorcage y aurait mise. `categoryChanged` est une prevision : si
    // l'amorcage est mort avant Set-NetConnectionProfile, le profil n'a jamais
    // ete touche, et le reforcer serait defaire un geste de l'utilisateur.
    // Reste un cas indiscernable de l'exterieur — l'utilisateur qui bascule
    // lui-meme l'interface en Private apres un amorcage avorte — que rien ici
    // ne peut distinguer d'un profil pose par hardline.
    tail.push(
      `if ((Get-NetConnectionProfile -InterfaceAlias ${quotedAlias} -ErrorAction SilentlyContinue).NetworkCategory -eq 'Private') { Set-NetConnectionProfile -InterfaceAlias ${quotedAlias} -NetworkCategory ${psKeyword(category, "catégorie réseau relevée", ASSIGNABLE_CATEGORIES)} -ErrorAction SilentlyContinue }`,
    );
  }

  tail.push(...restoreAuthorizedKeys(capture));

  if (capture.firewall.changed) {
    tail.push(
      `Remove-NetFirewallRule -Name ${psQuote(capture.firewall.name, "nom de règle relevé")} -ErrorAction SilentlyContinue`,
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
  //
  // La garde `-eq 'Automatic'` a la meme raison d'etre que celle du profil : si
  // l'amorcage est mort avant Set-Service et que l'utilisateur a installe et
  // active OpenSSH lui-meme, il n'y a rien a defaire.
  if (capture.sshd.startupChanged) {
    const startupType = psKeyword(
      capture.sshd.present ? (capture.sshd.startupType ?? "Disabled") : "Disabled",
      "type de démarrage relevé",
      STARTUP_TYPES,
    );
    tail.push(
      `if ((Get-Service -Name sshd -ErrorAction SilentlyContinue).StartType -eq 'Automatic') { Set-Service -Name sshd -StartupType ${startupType} -ErrorAction SilentlyContinue }`,
    );
  }
  // Meme traitement pour l'etat du service : on relit avant d'ecrire. Un arret
  // inconditionnel etait la derniere instruction du lot a modifier sans
  // regarder, et c'est la plus lourde : elle ferme definitivement la porte.
  //
  // La garde ne distingue pas tout, et il faut le dire plutot que le taire :
  // `Status -eq 'Running'` est vrai aussi bien parce que l'amorcage a demarre
  // sshd que parce que l'utilisateur l'a demarre lui-meme apres un amorcage
  // avorte. Rien, vu d'ici, ne separe les deux : le releve dit ce que
  // l'amorcage COMPTAIT faire, pas ce qu'il a fait. La garde ferme le seul cas
  // observable (un sshd deja arrete, qu'on n'a pas a rearreter) et le cas
  // indiscernable reste ce qu'il est, nomme ici faute de pouvoir etre resolu.
  if (capture.sshd.statusChanged) {
    tail.push(
      "if ((Get-Service -Name sshd -ErrorAction SilentlyContinue).Status -eq 'Running') { Stop-Service -Name sshd -Force -ErrorAction SilentlyContinue }",
    );
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
  const lines = [
    `Remove-Item -Path ${ackPath} -Force -ErrorAction SilentlyContinue`,
  ];
  if (tail.length > 0) lines.push(detachTail(tail));
  return lines.join("\n");
};

/** Ce que le detail doit dire quand il n'y a rien d'exploitable a rapatrier. */
const DEFECT_DETAIL: Record<CaptureDefect, string> = {
  absent:
    "aucun relevé d'amorçage sur le PC\u00a0: ce que l'amorçage a modifié ne pourra pas être défait",
  illisible:
    "relevé d'amorçage illisible sur le PC\u00a0: ce que l'amorçage a modifié ne pourra pas être défait",
  version:
    "relevé d'amorçage d'une version inconnue\u00a0: ce que l'amorçage a modifié ne pourra pas être défait",
};

// --- L'etape. ------------------------------------------------------------

export const bootstrapWindowsStep: Step<BootstrapState> = {
  name: BOOTSTRAP_STEP_NAME,
  label: "Amorçage du PC\u00a0: OpenSSH, pare-feu, clé et adressage (PC)",

  async inspect(config: Config) {
    const rows = await runRemoteJson<BootstrapState>(config.ssh, INSPECT);
    const current = rows[0];

    if (!current) {
      throw new Error(
        "Le PC n'a renvoyé aucun état d'amorçage. Vérifier la liaison SSH.",
      );
    }

    const read = readCapture(current.capture);

    // Un PC amorcé par une version antérieure de hardline n'a pas de relevé ;
    // un relevé abîmé ou d'une autre version n'est pas exploitable non plus.
    // Aucun des trois ne bloque l'installation, et aucun n'invente un état
    // antérieur : on le dit, et on ne promet rien.
    if (!("capture" in read)) {
      const defect = current.unreadable ? "illisible" : read.defect;
      return {
        conforming: true,
        current: { capture: null, acknowledged: current.acknowledged },
        detail: DEFECT_DETAIL[defect],
      };
    }

    const { capture } = read;

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

    // Le releve est l'autorite sur l'interface qu'il decrit : c'est celle-la
    // que l'amorcage a modifiee. Si CONFIG a change entre l'installation et la
    // desinstallation, reposer l'adressage d'origine sur l'interface courante
    // serait le reposer au mauvais endroit.
    const alias =
      previous.capture.interfaceAlias || config.windows.interfaceAlias;

    await runRemoteChecked(
      config.ssh,
      RESTORE(alias, config.windows.ip, previous.capture),
    );
  },
};
