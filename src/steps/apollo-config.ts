import { psDoubleQuote, psQuote } from "../lib/powershell";
import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import { deleteSecret, generatePassword, setSecret } from "../lib/keychain";
import { REQUIRED_CONF, confConforms, patchConf } from "../lib/apollo-conf";
import { normalizeRemoteState } from "../lib/apollo-state";
import type { Config } from "../config";
import type { RestoreContext, Step } from "./types";

export type ApolloConfState = { conf: string | null; hadCredentials: boolean };

type RemoteConfState = ApolloConfState;

type RemoteApplyState = ApolloConfState & { serviceRunning: boolean };

const CONFIG_PATH_EXPR = (installDirQ: string) =>
  `(Join-Path ${installDirQ} (Join-Path 'config' 'sunshine.conf'))`;

const STATE_PATH_EXPR = (installDirQ: string) =>
  `(Join-Path ${installDirQ} (Join-Path 'config' 'sunshine_state.json'))`;

/**
 * hadCredentials est lu dans sunshine_state.json : le meme fichier
 * qu'apollo-install.ts utilise pour pairedClients, mais lu ici
 * independamment, comme network-windows.ts et bootstrap-windows.ts
 * n'utilisent jamais le meme script d'inspection malgre leur ressemblance.
 *
 * Le champ est `username` A LA RACINE, pas `root.username` : c'est la forme
 * que sunshine.exe --creds ecrit, verifiee sur la machine. Chercher dans root
 * ne trouvait JAMAIS rien — l'etape se croyait donc eternellement non
 * conforme, regenerait un mot de passe a chaque `hardline install`, et
 * remplacait au trousseau un secret qui fonctionnait. root.username reste
 * accepte en second, au cas ou une autre version d'Apollo le rangerait la.
 */
const READ_STATE = (installDir: string) => {
  const installDirQ = psQuote(installDir, "répertoire d'installation");
  return `
$confPath = ${CONFIG_PATH_EXPR(installDirQ)}
$statePath = ${STATE_PATH_EXPR(installDirQ)}
# Get-Content -Raw rend une chaine decoree des proprietes que le fournisseur
# de systeme de fichiers attache (PSPath, PSParentPath, PSChildName, PSDrive,
# PSProvider, ReadCount) : ConvertTo-Json les serialise alors toutes, et conf
# arrive cote Mac comme un objet au lieu d'une chaine. Le cast [string] force
# le type et doit rester DANS la branche Test-Path : caster l'expression
# entiere transformerait $null en "", et confondrait "fichier absent" avec
# "fichier vide" - distinction dont restore() depend (previous.conf === null).
$conf = if (Test-Path $confPath) { [string](Get-Content -Path $confPath -Raw) } else { $null }
$hadCredentials = $false
if (Test-Path $statePath) {
  try {
    $state = Get-Content -Path $statePath -Raw | ConvertFrom-Json
    if ($state.username -or ($state.root -and $state.root.username)) { $hadCredentials = $true }
  } catch {}
}
[pscustomobject]@{ conf = $conf; hadCredentials = [bool]$hadCredentials }`;
};

/**
 * Ajoute le releve du service a READ_STATE, dans le meme aller-retour SSH que
 * la lecture de la configuration : --creds n'a besoin d'un redemarrage que si
 * le service tournait deja, et cette information n'est utile qu'a apply().
 */
const READ_STATE_FOR_APPLY = (installDir: string, serviceName: string) => {
  const installDirQ = psQuote(installDir, "répertoire d'installation");
  const serviceNameQ = psQuote(serviceName, "nom du service");
  return `
$confPath = ${CONFIG_PATH_EXPR(installDirQ)}
$statePath = ${STATE_PATH_EXPR(installDirQ)}
# Meme cause qu'en lecture seule (voir READ_STATE) : le cast [string] doit
# rester DANS la branche Test-Path, sinon [string]$null devient "" et efface
# la distinction "fichier absent" / "fichier vide" dont restore() depend.
$conf = if (Test-Path $confPath) { [string](Get-Content -Path $confPath -Raw) } else { $null }
$hadCredentials = $false
if (Test-Path $statePath) {
  try {
    $state = Get-Content -Path $statePath -Raw | ConvertFrom-Json
    if ($state.username -or ($state.root -and $state.root.username)) { $hadCredentials = $true }
  } catch {}
}
$service = Get-Service -Name ${serviceNameQ} -ErrorAction SilentlyContinue
[pscustomobject]@{
  conf           = $conf
  hadCredentials = [bool]$hadCredentials
  serviceRunning = [bool]($service -and $service.Status -eq 'Running')
}`;
};

/**
 * --creds ecrit sur disque mais ne recharge pas un service deja en memoire :
 * pose avant le premier demarrage dans le deroulement normal (apollo-config
 * s'applique avant qu'apollo-service ne demarre le service pour la premiere
 * fois), ou suivie d'un redemarrage explicite si le service tournait deja
 * (reexecution partielle). password passe TOUJOURS par psQuote : jamais
 * d'interpolation directe d'un secret dans le script distant.
 *
 * Le mot de passe cite est affecte a une variable sur SA PROPRE ligne, avant
 * l'appel a sunshine.exe : une affectation n'echoue pas et n'a donc pas de
 * PositionMessage a montrer. Si l'appel echoue autrement que par un code de
 * retour (executable absent, execution refusee), PowerShell reimprime le
 * texte SOURCE de la ligne en cause dans son PositionMessage, et
 * runRemoteChecked (src/lib/ssh.ts) recopie stderr tel quel dans le message
 * d'erreur remonte : si le mot de passe etait cousu en litteral dans cette
 * ligne d'appel, il y reapparaitrait. La ligne d'appel ne contient donc que
 * $applyWebPassword, jamais le secret lui-meme ; 2>$null ecarte en plus tout
 * bruit que l'executable ecrirait lui-meme sur son flux d'erreur.
 */
function buildApplyScript(
  config: Config,
  password: string | null,
  patchedConf: string,
  serviceWasRunning: boolean,
): string {
  const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
  const serviceNameQ = psQuote(config.apollo.serviceName, "nom du service");
  const lines: string[] = [];

  if (password !== null) {
    const userQ = psQuote(config.apollo.webUser, "compte web Apollo");
    const passwordQ = psQuote(password, "mot de passe web Apollo");
    lines.push(
      `$applyWebPassword = ${passwordQ}`,
      `& (Join-Path ${installDirQ} 'sunshine.exe') '--creds' ${userQ} $applyWebPassword 2>$null`,
      `if ($LASTEXITCODE -ne 0) { throw "Echec de sunshine.exe --creds (code $LASTEXITCODE)" }`,
    );
  }

  lines.push(
    `New-Item -ItemType Directory -Path (Join-Path ${installDirQ} 'config') -Force -ErrorAction SilentlyContinue | Out-Null`,
    `[System.IO.File]::WriteAllText(${CONFIG_PATH_EXPR(installDirQ)}, ${psDoubleQuote(patchedConf)}, (New-Object System.Text.UTF8Encoding($false)))`,
  );

  if (serviceWasRunning) {
    lines.push(`Restart-Service -Name ${serviceNameQ} -Force -ErrorAction SilentlyContinue`);
  }

  return lines.join("\n");
}

/**
 * runRemoteJson ne verifie rien au runtime : un script PowerShell de releve
 * modifie par erreur (par exemple un Get-Content -Raw sans cast [string],
 * qui serialise l'objet decore par le fournisseur de systeme de fichiers -
 * PSPath, PSChildName, etc.) peut rendre pour conf un objet plutot qu'une
 * chaine ou null. Sans ce garde, cette valeur explose plus loin dans
 * parseConf (text.split n'est pas une fonction), avec un message qui ne
 * nomme ni l'etape ni le champ en cause. Ici, le diagnostic nomme les deux.
 */
function assertConfShape(conf: unknown): string | null {
  if (conf === null || typeof conf === "string") return conf;
  throw new Error(
    "apollo-config\u00a0: le PC a renvoyé, pour la configuration Apollo (conf), une valeur qui n'est ni une chaîne ni l'absence de fichier. Vérifier le script PowerShell de relevé.",
  );
}

export const apolloConfigStep: Step<ApolloConfState> = {
  name: "apollo-config",
  label: "Configuration et identifiants Apollo (PC)",

  async inspect(config: Config) {
    const rows = await runRemoteJson<RemoteConfState>(
      config.ssh,
      READ_STATE(config.apollo.installDir),
    );
    const current = rows[0];
    if (!current) {
      throw new Error(
        "Le PC n'a renvoyé aucun état de configuration Apollo. Vérifier la liaison SSH.",
      );
    }
    const conf = assertConfShape(current.conf);
    const conforming = current.hadCredentials && confConforms(conf ?? "", REQUIRED_CONF);
    return {
      conforming,
      current,
      detail: conforming
        ? "identifiants et configuration déjà en place"
        : !current.hadCredentials
          ? "identifiants web absents"
          : "configuration incomplète",
    };
  },

  async apply(config: Config) {
    const rows = await runRemoteJson<RemoteApplyState>(
      config.ssh,
      READ_STATE_FOR_APPLY(config.apollo.installDir, config.apollo.serviceName),
    );
    const current = rows[0];
    if (!current) {
      throw new Error(
        "Le PC n'a renvoyé aucun état de configuration Apollo. Vérifier la liaison SSH.",
      );
    }

    const conf = assertConfShape(current.conf);
    const patched = patchConf(conf ?? "", REQUIRED_CONF);

    // Un identifiant deja present n'est jamais regenere : cela romprait un
    // mot de passe deja en service et deja au trousseau, pour une etape qui
    // ne serait non conforme que sur les six cles de configuration.
    let password: string | null = null;
    if (!current.hadCredentials) {
      password = generatePassword();
      await setSecret("apollo-web", password);
    }

    await runRemoteChecked(
      config.ssh,
      buildApplyScript(config, password, patched, current.serviceRunning),
    );

    // sunshine.exe --creds ne se contente pas d'ajouter les identifiants : il
    // REECRIT le fichier d'etat en entier, et y remet en chaines les trois
    // booleens du client appaire — meme quand ils venaient d'etre corriges.
    // Sans ce desamorcage, l'etape suivante demarre un Apollo qui meurt aux
    // premieres secondes, et l'appairage echoue sur un serveur qui ne repond
    // plus. Voir src/lib/apollo-state.ts pour le defaut contourne.
    if (password !== null) {
      await normalizeRemoteState(config);
    }
  },

  /**
   * Rend le contenu exact d'avant, verbatim, octet pour octet. hadCredentials
   * decrit l'etat AVANT apply() : s'il etait false, c'est hardline qui a cree
   * ce secret, et lui seul est retire. La restitution du fichier n'implique
   * aucune hypothese sur ce qu'apollo-install fera ensuite (dans l'ordre
   * inverse, apollo-install.restore s'execute apres) : ce cas compte
   * precisement quand Apollo est etranger et qu'apollo-install.restore cede
   * sa place.
   *
   * [System.IO.File]::WriteAllText ecrit en UTF-8 sans marque d'ordre des
   * octets (le troisieme argument) et n'ajoute RIEN a la fin du fichier :
   * Set-Content -Encoding ascii remplacait tout accent par '?', et
   * Set-Content -Value ajoutait un saut de ligne meme quand le contenu relu
   * par Get-Content -Raw en portait deja un. Les deux defauts auraient rompu
   * la promesse "verbatim" au premier accent ou au premier saut de ligne de
   * fin de fichier.
   */
  async restore(config: Config, previous: ApolloConfState, _context: RestoreContext) {
    const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
    const script =
      previous.conf === null
        ? `Remove-Item -Path ${CONFIG_PATH_EXPR(installDirQ)} -Force -ErrorAction SilentlyContinue`
        : `[System.IO.File]::WriteAllText(${CONFIG_PATH_EXPR(installDirQ)}, ${psDoubleQuote(previous.conf)}, (New-Object System.Text.UTF8Encoding($false)))`;

    await runRemoteChecked(config.ssh, script);

    if (!previous.hadCredentials) {
      await deleteSecret("apollo-web");
    }
  },
};
