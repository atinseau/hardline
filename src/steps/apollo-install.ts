import { psQuote } from "../lib/powershell";
import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import type { Config } from "../config";
import type { RestoreContext, Step } from "./types";

/** Ce que hardline sait d'une installation d'Apollo, avant de la toucher. */
export type ApolloInstallState = {
  installed: boolean;
  version: string | null;
  ours: boolean;
  backupPath: string | null;
  pairedClients: number;
};

/**
 * Fichier marqueur depose dans installDir a l'installation par hardline.
 * Seule source de verite pour "ours" : aucune heuristique de date, de
 * version ou de configuration ne remplace ce fichier.
 */
export const MARKER_FILE = ".hardline";

type RemoteApolloState = {
  installed: boolean;
  version: string | null;
  ours: boolean;
  pairedClients: number;
  hasConfig: boolean;
};

const CONFIG_PATH_EXPR = (installDirQ: string) =>
  `(Join-Path ${installDirQ} (Join-Path 'config' 'sunshine.conf'))`;

const STATE_PATH_EXPR = (installDirQ: string) =>
  `(Join-Path ${installDirQ} (Join-Path 'config' 'sunshine_state.json'))`;

/**
 * Le nombre de clients apparies est lu dans sunshine_state.json, le fichier
 * ou Apollo persiste ses certificats client apparies (root.named_certs) :
 * aucune requete HTTP n'est necessaire, ce qui laisse ce releve fonctionner
 * meme quand les identifiants web d'un Apollo etranger sont inconnus de
 * hardline. Format interne d'Apollo 0.4.6, a confirmer sur la machine de
 * reference.
 */
const INSPECT = (installDir: string) => {
  const installDirQ = psQuote(installDir, "répertoire d'installation");
  return `
$installDir = ${installDirQ}
$exePath = Join-Path $installDir 'sunshine.exe'
$markerPath = Join-Path $installDir '${MARKER_FILE}'
$statePath = ${STATE_PATH_EXPR("$installDir")}
$confPath = ${CONFIG_PATH_EXPR("$installDir")}
$installed = Test-Path $exePath
$version = $null
if ($installed) { $version = (Get-Item $exePath).VersionInfo.ProductVersion }
$pairedClients = 0
if (Test-Path $statePath) {
  try {
    $state = Get-Content -Path $statePath -Raw | ConvertFrom-Json
    if ($state.root -and $state.root.named_certs) { $pairedClients = @($state.root.named_certs).Count }
  } catch {}
}
[pscustomobject]@{
  installed     = [bool]$installed
  version       = $version
  ours          = [bool](Test-Path $markerPath)
  pairedClients = [int]$pairedClients
  hasConfig     = [bool](Test-Path $confPath)
}`;
};

async function readRemote(config: Config): Promise<RemoteApolloState> {
  const rows = await runRemoteJson<RemoteApolloState>(
    config.ssh,
    INSPECT(config.apollo.installDir),
  );
  const current = rows[0];
  if (!current) {
    throw new Error(
      "Le PC n'a renvoyé aucun état d'Apollo. Vérifier la liaison SSH.",
    );
  }
  return current;
}

function toState(remote: RemoteApolloState): ApolloInstallState {
  return {
    installed: remote.installed,
    version: remote.version,
    ours: remote.ours,
    backupPath: null,
    pairedClients: remote.pairedClients,
  };
}

/**
 * L'installateur d'Apollo est un binaire NSIS, donc un executable GUI
 * (Subsystem=2 dans son en-tete PE). PowerShell N'ATTEND PAS un executable GUI
 * lance par l'operateur d'appel `&` : il rend la main aussitot et ne met meme
 * pas $LASTEXITCODE a jour. Le controle qui suivait `& $tempPath` relisait donc
 * le code de la commande PRECEDENTE, pendant que l'installation tournait encore
 * et que la suite du script - suppression du telechargement, depot du marqueur -
 * s'executait par-dessus elle.
 *
 * Start-Process -Wait -PassThru est le seul idiome qui attende vraiment et qui
 * rende le code de sortie reel, par .ExitCode de l'objet processus.
 *
 * Citation des arguments : -ArgumentList concatene ses elements par des espaces
 * SANS les reciter (verifie sur le PC, PowerShell 5.1). Les apostrophes de
 * psQuote sont donc consommees par PowerShell et n'atteignent pas
 * l'installateur, ce qui est exactement ce qu'il faut : `/D=` prend tout le
 * reste de la ligne de commande brute, espaces compris, et refuse les
 * guillemets - un guillemet ajoute ici ferait partie du chemin. `/D=` doit
 * pour la meme raison rester le DERNIER element.
 */
function installScript(config: Config): string {
  const urlQ = psQuote(config.apollo.installerUrl, "URL de l'installateur");
  const sha256Q = psQuote(config.apollo.installerSha256, "empreinte SHA-256 attendue");
  const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
  const installArgQ = psQuote(`/D=${config.apollo.installDir}`, "argument d'installation");

  return `
$tempPath = Join-Path $env:TEMP 'apollo-installer.exe'
Invoke-WebRequest -Uri ${urlQ} -OutFile $tempPath -UseBasicParsing
$actual = (Get-FileHash -Path $tempPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne ${sha256Q}) {
  Remove-Item -Path $tempPath -Force -ErrorAction SilentlyContinue
  throw "Empreinte SHA-256 invalide pour l'installateur Apollo (obtenu $actual)"
}
$install = Start-Process -FilePath $tempPath -ArgumentList '/S', ${installArgQ} -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "Echec de l'installateur Apollo (code $($install.ExitCode))" }
Remove-Item -Path $tempPath -Force -ErrorAction SilentlyContinue
New-Item -ItemType File -Path (Join-Path ${installDirQ} '${MARKER_FILE}') -Force | Out-Null`;
}

/**
 * Sauvegarde sunshine.conf HORS de installDir, avant une desinstallation qui
 * va supprimer tout le dossier. Rend le chemin de la sauvegarde, ou null
 * quand il n'y avait rien a sauvegarder.
 */
export async function backupApolloConfig(config: Config): Promise<string | null> {
  const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
  const script = `
$confPath = ${CONFIG_PATH_EXPR(installDirQ)}
$backupPath = $null
if (Test-Path $confPath) {
  $dir = Join-Path $env:ProgramData 'hardline'
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $backupPath = Join-Path $dir "apollo-backup-$stamp.conf"
  Copy-Item -Path $confPath -Destination $backupPath -Force
}
[pscustomobject]@{ backupPath = $backupPath }`;
  const rows = await runRemoteJson<{ backupPath: string | null }>(config.ssh, script);
  return rows[0]?.backupPath ?? null;
}

/** Cf. section 10 de la spec : identifiants du pilote SudoVDA que Windows attribue. */
const SUDOVDA_HARDWARE_ID = "root\\sudomaker\\sudovda";
const SUDOVDA_CLASS_GUID = "4D36E968-E325-11CE-BFC1-08002BE10318";

/**
 * Desinstallation complete, dans l'ordre exact de la section 10 de la spec.
 * Reutilisee par apply() (remplacement d'une installation posee par
 * hardline dans une version differente) et par restore() (desinstallation
 * d'une installation posee par hardline). AUCUNE queue detachee :
 * contrairement au reseau ou a l'amorcage, rien ici ne touche a l'interface
 * qui porte la session SSH, donc rien ne la coupe.
 */
function uninstallScript(config: Config): string {
  const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
  const serviceNameQ = psQuote(config.apollo.serviceName, "nom du service");
  const uninstallArgQ = psQuote(
    `_?=${config.apollo.installDir}`,
    "argument de désinstallation",
  );

  return [
    // 1. Le service ne doit plus tourner pendant que Uninstall.exe retire
    //    les fichiers qu'il tient ouverts.
    `sc.exe stop ${serviceNameQ} | Out-Null`,
    //    1062 est ERROR_SERVICE_NOT_ACTIVE : le service etait deja arrete,
    //    ce qui est le cas NOMINAL apres un plantage et non un echec. 1060 est
    //    ERROR_SERVICE_DOES_NOT_EXIST : il n'y a plus rien a arreter, ce qui
    //    n'en est pas un davantage. Tout autre code est un vrai probleme -
    //    un acces refuse, par exemple - et la desinstallation ne doit pas
    //    continuer dessus.
    //    La remise a zero qui suit n'est pas cosmetique : `| Out-Null` ne
    //    reinitialise PAS $LASTEXITCODE, et c'est cette valeur survivante qui
    //    etait relue plus bas a la place du code d'Uninstall.exe.
    `if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1062 -and $LASTEXITCODE -ne 1060) { throw "Echec de l'arrêt du service Apollo (code $LASTEXITCODE)" }`,
    `$LASTEXITCODE = 0`,
    // 2. DEUX garanties distinctes, qu'on a longtemps confondues.
    //    _?= est OBLIGATOIRE cote NSIS : sans lui, Uninstall.exe se recopie
    //    dans un dossier temporaire et se DETACHE, si bien qu'il n'y a meme
    //    plus de processus a attendre. _?= le force a s'executer EN PLACE.
    //    Mais _?= ne fait pas attendre POWERSHELL : Uninstall.exe est un
    //    binaire GUI (Subsystem=2), et l'operateur `&` rend la main aussitot
    //    sans mettre $LASTEXITCODE a jour. Le controle qui suivait relisait
    //    donc le code de sc.exe stop, et le reste du script - nefconc,
    //    certutil, Remove-Item - s'executait PENDANT la desinstallation.
    //    Start-Process -Wait -PassThru attend reellement et rend le code par
    //    .ExitCode. Les deux sont necessaires ; aucune ne remplace l'autre.
    //    _?= reste le DERNIER element : comme /D=, NSIS lit tout le reste de
    //    la ligne de commande brute, et -ArgumentList ne recite rien.
    `$uninstall = Start-Process -FilePath (Join-Path ${installDirQ} 'Uninstall.exe') -ArgumentList '/S', ${uninstallArgQ} -Wait -PassThru`,
    `if ($uninstall.ExitCode -ne 0) { throw "Echec de Uninstall.exe (code $($uninstall.ExitCode))" }`,
    // 3. Le pilote SudoVDA n'est PAS retire par Uninstall.exe /S : c'est une
    //    des trois boites de dialogue que le mode silencieux refuse par
    //    defaut. nefconc.exe est appele EN DIRECT, jamais par uninstall.bat :
    //    ce script fourni par Apollo se termine par un `pause`, qui
    //    attendrait pour toujours un appui clavier sur un tube qui n'en
    //    fournira jamais, et figerait la session SSH de facon definitive.
    `& (Join-Path ${installDirQ} (Join-Path 'tools' 'nefconc.exe')) '--remove-device-node' '--hardware-id' '${SUDOVDA_HARDWARE_ID}' '--class-guid' '${SUDOVDA_CLASS_GUID}'`,
    // 4. Aucun script d'Apollo ne retire les certificats du pilote : sans
    //    ces deux lignes, deux certificats restent dans les magasins de
    //    confiance.
    `certutil.exe -delstore root sudovda.cer`,
    `certutil.exe -delstore TrustedPublisher sudovda.cer`,
    // 5. ViGEmBus est retire systematiquement (risque assume : pilote
    //    partage, voir section 10 de la spec).
    `& (Join-Path ${installDirQ} (Join-Path 'scripts' 'uninstall-gamepad.ps1'))`,
    // 6. Nettoyage du PATH puis du dossier, dans cet ordre : update-path.bat
    //    vit dans le dossier qu'il faut ensuite supprimer.
    `& (Join-Path ${installDirQ} 'update-path.bat') 'remove'`,
    `Remove-Item -Path ${installDirQ} -Recurse -Force -ErrorAction SilentlyContinue`,
    // 7. Filets de securite : rien de ce qui precede ne doit laisser un
    //    service fantome ou une regle de pare-feu ouverte si une etape a
    //    echoue en silence.
    `sc.exe delete ${serviceNameQ} | Out-Null`,
    `netsh.exe advfirewall firewall delete rule name=Apollo | Out-Null`,
    // netsh sort en code non nul quand aucune regle ne correspond deja - le
    // cas normal apres une desinstallation propre - et runRemoteChecked leve
    // sur tout code non nul : une restauration reussie serait rapportee en
    // echec sans cette remise a zero explicite.
    `$LASTEXITCODE = 0`,
  ].join("\n");
}

/**
 * Exportee au-dela du besoin strict de cette etape : c'est ce que la tache
 * 12 appelle apres confirmation de l'utilisateur, pour effacer une
 * installation etrangere. inspect() ne verra plus alors qu'une machine sans
 * Apollo, et apply() empruntera son chemin d'installation neuve.
 */
export async function uninstallApollo(config: Config): Promise<void> {
  await runRemoteChecked(config.ssh, uninstallScript(config));
}

/**
 * Levee par apply() quand une installation d'Apollo non posee par hardline
 * est trouvee. L'etape ne dialogue jamais : elle nomme ce qu'elle a constate
 * et s'arrete la, sans rien executer d'autre. La confirmation et
 * l'effacement, une fois confirmes, sont du ressort de la commande (tache
 * 12), qui peut appeler uninstallApollo() puis relancer la convergence :
 * inspect() ne verra alors plus qu'une machine sans Apollo, et apply()
 * empruntera son chemin d'installation neuve.
 */
export class ForeignApolloError extends Error {
  constructor(
    message: string,
    readonly state: ApolloInstallState,
    readonly hasConfig: boolean,
  ) {
    super(message);
    this.name = "ForeignApolloError";
  }
}

export const apolloInstallStep: Step<ApolloInstallState> = {
  name: "apollo-install",
  label: "Serveur Apollo installé (PC)",

  async inspect(config: Config) {
    const remote = await readRemote(config);
    const conforming =
      remote.installed && remote.ours && remote.version === config.apollo.version;

    return {
      conforming,
      current: toState(remote),
      detail: !remote.installed
        ? "Apollo absent du PC"
        : !remote.ours
          ? `Apollo étranger détecté (version ${remote.version ?? "inconnue"}, ${remote.pairedClients} client(s) appairé(s))`
          : conforming
            ? `Apollo ${config.apollo.version} déjà installé par hardline`
            : `Apollo ${remote.version ?? "inconnu"} installé par hardline, version ${config.apollo.version} attendue`,
    };
  },

  async apply(config: Config) {
    const remote = await readRemote(config);

    if (remote.installed && !remote.ours) {
      throw new ForeignApolloError(
        `Apollo étranger trouvé (version ${remote.version ?? "inconnue"}, ` +
          `${remote.pairedClients} client(s) appairé(s), ` +
          `${remote.hasConfig ? "une configuration existe" : "aucune configuration"})` +
          `\u00a0: confirmation requise avant de l'effacer.`,
        toState(remote),
        remote.hasConfig,
      );
    }

    if (remote.installed) {
      // Ours, mais d'une version differente de la cible : la meme rigueur
      // que pour un etranger confirme par la commande, en une seule passe.
      await backupApolloConfig(config);
      await uninstallApollo(config);
    }

    await runRemoteChecked(config.ssh, installScript(config));
  },

  /**
   * Le releve du manifeste (previous) decrit l'etat d'AVANT apply, jamais ce
   * qui est installe au moment de rendre : applySteps enregistre state.current
   * avant d'appeler apply (src/lib/orchestrator.ts). Dans le cas nominal,
   * previous vaut { installed: false, ours: false } alors qu'Apollo, pose par
   * hardline, tourne bel et bien sur le PC. Ce que hardline a pose part donc
   * TOUJOURS, sans jamais se fier a previous.ours pour decider de le faire.
   *
   * previous ne sert plus qu'a un seul usage : dire, en plus, qu'un Apollo
   * etranger existait avant l'intervention de hardline et que celui-la n'est
   * pas remis - hardline ne sait pas le reinstaller a l'identique. C'est le
   * cas de l'etranger efface apres consentement de l'utilisateur (tache 12) :
   * previous porte encore { installed: true, ours: false } issu du releve
   * d'origine, alors que c'est desormais le notre qui tourne et qui doit etre
   * retire comme le reste.
   */
  async restore(config: Config, previous: ApolloInstallState, _context: RestoreContext) {
    await backupApolloConfig(config);
    await uninstallApollo(config);

    if (previous.installed && !previous.ours) {
      return {
        yielded:
          `Apollo étranger qui existait avant hardline (version ${previous.version ?? "inconnue"}, ` +
          `${previous.pairedClients} client(s) appairé(s) au moment du constat) ` +
          `retiré avec l'accord de l'utilisateur en même temps que l'Apollo de hardline` +
          `\u00a0: hardline ne sait pas le remettre.`,
      };
    }
  },
};
