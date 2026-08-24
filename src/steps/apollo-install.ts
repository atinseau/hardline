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
export type ApolloRescueMetadata = {
  readonly version: string | null;
  readonly explanation: string;
};

export async function backupApolloConfig(
  config: Config,
  metadata: ApolloRescueMetadata = {
    version: config.apollo.version,
    explanation:
      "This backup describes the Apollo installation removed by Hardline. Hardline does not reinstall it automatically.",
  },
): Promise<string | null> {
  const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
  const versionLineQ = psQuote(
    `Detected version: ${metadata.version ?? "unknown"}`,
    "version Apollo relevée",
  );
  const explanationQ = psQuote(metadata.explanation, "explication de la sauvegarde Apollo");
  const script = `
$confPath = ${CONFIG_PATH_EXPR(installDirQ)}
$dir = Join-Path $env:ProgramData 'hardline'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$backupPath = Join-Path $dir "apollo-rescue-$stamp"
New-Item -ItemType Directory -Path $backupPath -Force | Out-Null
if (Test-Path $confPath) {
  Copy-Item -Path $confPath -Destination (Join-Path $backupPath 'sunshine.conf') -Force
}
$readme = @(
  'Apollo Rescue Backup'
  ${versionLineQ}
  ${explanationQ}
)
Set-Content -Path (Join-Path $backupPath 'README.txt') -Value $readme -Encoding UTF8
[pscustomobject]@{ backupPath = $backupPath }`;
  const rows = await runRemoteJson<{ backupPath: string | null }>(config.ssh, script);
  return rows[0]?.backupPath ?? null;
}

/** Cf. section 10 de la spec : identifiant materiel du pilote SudoVDA. */
const SUDOVDA_HARDWARE_ID = "root\\sudomaker\\sudovda";

/**
 * Le SUJET des deux certificats deposes par le pilote SudoVDA, dans root et
 * dans TrustedPublisher. `sudovda.cer` est le nom du FICHIER livre par Apollo,
 * jamais un sujet : sur le PC, `certutil -store root sudovda.cer` rend
 * NTE_NOT_FOUND alors que `certutil -store root sudovda@su.mk` trouve le
 * certificat. L'ancienne valeur n'aurait donc jamais rien retire.
 */
const SUDOVDA_CERT_SUBJECT = "sudovda@su.mk";

/**
 * Prefixe des lignes par lesquelles le script distant dit ce qu'il n'a PAS pu
 * faire. Meme usage que les marqueurs de network-windows : le PC ecrit, le Mac
 * relit, et rien d'inaccompli ne se perd en chemin.
 */
export const UNINSTALL_WARN_MARK = "hardline-uninstall-warn:";

/**
 * Desinstallation complete. Reutilisee par apply() (remplacement d'une
 * installation posee par hardline dans une version differente) et par
 * restore() (desinstallation d'une installation posee par hardline). AUCUNE
 * queue detachee : contrairement au reseau ou a l'amorcage, rien ici ne touche
 * a l'interface qui porte la session SSH, donc rien ne la coupe.
 *
 * L'ORDRE est la substance de cette fonction, et il a une seule regle :
 * TOUT CE QUI DEPEND D'UN FICHIER FOURNI PAR APOLLO PASSE AVANT Uninstall.exe.
 * Uninstall.exe supprime tools\, scripts\ et update-path.bat ; les appeler
 * apres lui, c'est appeler des fichiers qui n'existent plus - l'echec observe
 * au deuxieme essai reel, « Le terme ...\tools\nefconc.exe n'est pas reconnu ».
 *
 * Chaque geste de nettoyage tolere ensuite l'absence de sa cible, et NOMME ce
 * qu'il n'a pas pu faire dans $warnings : une installation a demi demontee doit
 * pouvoir etre nettoyee jusqu'au bout par une nouvelle execution, sans qu'un
 * script manquant ne fasse tout echouer, et sans qu'un manque soit tu.
 */
function uninstallScript(config: Config): string {
  const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
  const serviceNameQ = psQuote(config.apollo.serviceName, "nom du service");
  const hardwareIdQ = psQuote(
    SUDOVDA_HARDWARE_ID,
    "identifiant matériel du pilote SudoVDA",
  );
  const certSubjectQ = psQuote(
    SUDOVDA_CERT_SUBJECT,
    "sujet des certificats SudoVDA",
  );
  const uninstallArgQ = psQuote(
    `_?=${config.apollo.installDir}`,
    "argument de désinstallation",
  );

  return [
    `$warnings = @()`,
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
    // 2. Le pilote SudoVDA n'est PAS retire par Uninstall.exe /S : c'est une
    //    des trois boites de dialogue que le mode silencieux refuse par
    //    defaut. pnputil, outil natif de Windows, remplace ici nefconc.exe
    //    d'Apollo pour trois raisons : il ne disparait pas avec le dossier
    //    d'Apollo ; il sait nettoyer une installation DEJA demontee, ou plus
    //    aucun nefconc n'existe pour retirer un pilote devenu orphelin ; et il
    //    evite d'executer un binaire tiers avec des privileges.
    //    Le pilote est retrouve par Win32_PnPSignedDriver, qui rend InfName et
    //    HardWareID en clair : la sortie de `pnputil /enum-drivers`, elle, a
    //    ses intitules TRADUITS et ne se lit pas de facon portable.
    `$sudovda = @(Get-CimInstance -ClassName Win32_PnPSignedDriver -ErrorAction SilentlyContinue | Where-Object { $_.HardWareID -eq ${hardwareIdQ} })`,
    `if ($sudovda.Count -eq 0) { $warnings += "Pilote SudoVDA introuvable\u00a0: rien à retirer, ou son identifiant matériel a changé." }`,
    `foreach ($device in $sudovda) {`,
    //    Le peripherique d'abord, le paquet de pilote ensuite : supprimer le
    //    paquet d'un peripherique encore present le laisserait se reinstaller.
    `  pnputil.exe /remove-device $device.DeviceID | Out-Null`,
    `  if ($LASTEXITCODE -ne 0) { $warnings += "Périphérique SudoVDA $($device.DeviceID) non retiré par pnputil (code $LASTEXITCODE)." }`,
    `  $LASTEXITCODE = 0`,
    `  if ($device.InfName) {`,
    `    pnputil.exe /delete-driver $device.InfName /uninstall /force | Out-Null`,
    `    if ($LASTEXITCODE -ne 0) { $warnings += "Pilote SudoVDA $($device.InfName) non supprimé du magasin de pilotes par pnputil (code $LASTEXITCODE)." }`,
    `    $LASTEXITCODE = 0`,
    `  } else {`,
    `    $warnings += "Pilote SudoVDA sans fichier INF connu\u00a0: le paquet reste dans le magasin de pilotes."`,
    `  }`,
    `}`,
    // 3. ViGEmBus est retire systematiquement (risque assume : pilote
    //    partage, voir section 10 de la spec). Son script vit sous scripts\,
    //    que Uninstall.exe supprime : il passe donc AVANT lui.
    `$gamepadScript = Join-Path ${installDirQ} (Join-Path 'scripts' 'uninstall-gamepad.ps1')`,
    `if (Test-Path $gamepadScript) {`,
    `  try { & $gamepadScript } catch { $warnings += "Désinstallation de ViGEmBus en échec\u00a0: $($_.Exception.Message)" }`,
    `} else {`,
    `  $warnings += "Script de désinstallation de ViGEmBus absent\u00a0: ViGEmBus peut rester installé sur le PC."`,
    `}`,
    // 4. Nettoyage du PATH. update-path.bat vit a la racine du dossier
    //    d'Apollo : la precaution avait ete pensee contre le Remove-Item
    //    final, alors que c'est Uninstall.exe qui l'efface, bien plus tot.
    `$updatePath = Join-Path ${installDirQ} 'update-path.bat'`,
    `if (Test-Path $updatePath) {`,
    `  & $updatePath 'remove' | Out-Null`,
    `  if ($LASTEXITCODE -ne 0) { $warnings += "Nettoyage du PATH par update-path.bat en échec (code $LASTEXITCODE)." }`,
    `  $LASTEXITCODE = 0`,
    `} else {`,
    `  $warnings += "update-path.bat absent\u00a0: le PATH du PC peut garder l'entrée d'Apollo."`,
    `}`,
    // 5. DEUX garanties distinctes, qu'on a longtemps confondues.
    //    _?= est OBLIGATOIRE cote NSIS : sans lui, Uninstall.exe se recopie
    //    dans un dossier temporaire et se DETACHE, si bien qu'il n'y a meme
    //    plus de processus a attendre. _?= le force a s'executer EN PLACE.
    //    Mais _?= ne fait pas attendre POWERSHELL : Uninstall.exe est un
    //    binaire GUI (Subsystem=2), et l'operateur `&` rend la main aussitot
    //    sans mettre $LASTEXITCODE a jour. Le controle qui suivait relisait
    //    donc le code de sc.exe stop, et la suite du script s'executait
    //    PENDANT la desinstallation.
    //    Start-Process -Wait -PassThru attend reellement et rend le code par
    //    .ExitCode. Les deux sont necessaires ; aucune ne remplace l'autre.
    //    _?= reste le DERNIER element : comme /D=, NSIS lit tout le reste de
    //    la ligne de commande brute, et -ArgumentList ne recite rien.
    //    Son absence n'est pas un echec : c'est l'etat d'une installation deja
    //    demontee, que le reste du nettoyage doit pouvoir finir.
    `$uninstallExe = Join-Path ${installDirQ} 'Uninstall.exe'`,
    `if (Test-Path $uninstallExe) {`,
    `  $uninstall = Start-Process -FilePath $uninstallExe -ArgumentList '/S', ${uninstallArgQ} -Wait -PassThru`,
    `  if ($uninstall.ExitCode -ne 0) { throw "Echec de Uninstall.exe (code $($uninstall.ExitCode))" }`,
    `} else {`,
    `  $warnings += "Uninstall.exe absent\u00a0: Apollo était déjà démonté, le nettoyage continue sans lui."`,
    `}`,
    // 6. Aucun script d'Apollo ne retire les certificats du pilote : sans ces
    //    deux lignes, deux certificats restent dans les magasins de confiance.
    //    Le sujet, et non le nom du fichier livre : voir SUDOVDA_CERT_SUBJECT.
    //    certutil sort en NTE_NOT_FOUND quand le magasin ne contient rien de
    //    tel - le cas normal d'un second passage - et cela se dit plutot que
    //    de faire echouer la desinstallation entiere.
    `certutil.exe -delstore root ${certSubjectQ} | Out-Null`,
    `if ($LASTEXITCODE -ne 0) { $warnings += "Certificat ${SUDOVDA_CERT_SUBJECT} non retiré du magasin root (code $LASTEXITCODE)." }`,
    `$LASTEXITCODE = 0`,
    `certutil.exe -delstore TrustedPublisher ${certSubjectQ} | Out-Null`,
    `if ($LASTEXITCODE -ne 0) { $warnings += "Certificat ${SUDOVDA_CERT_SUBJECT} non retiré du magasin TrustedPublisher (code $LASTEXITCODE)." }`,
    `$LASTEXITCODE = 0`,
    // 7. Le dossier residuel. Uninstall.exe laisse derriere lui config\ et
    //    lui-meme ; ce qui resiste encore a Remove-Item est nomme.
    `Remove-Item -Path ${installDirQ} -Recurse -Force -ErrorAction SilentlyContinue`,
    `if (Test-Path ${installDirQ}) { $warnings += "Dossier ${config.apollo.installDir} encore présent\u00a0: des fichiers y sont peut-être verrouillés." }`,
    // 8. Filets de securite : rien de ce qui precede ne doit laisser un
    //    service fantome ou une regle de pare-feu ouverte si une etape a
    //    echoue en silence.
    `sc.exe delete ${serviceNameQ} | Out-Null`,
    `netsh.exe advfirewall firewall delete rule name=Apollo | Out-Null`,
    // netsh sort en code non nul quand aucune regle ne correspond deja - le
    // cas normal apres une desinstallation propre - et runRemoteChecked leve
    // sur tout code non nul : une restauration reussie serait rapportee en
    // echec sans cette remise a zero explicite.
    `$LASTEXITCODE = 0`,
    // 9. Ce que le PC n'a pas pu faire remonte au Mac par ce seul canal.
    `foreach ($warning in $warnings) { Write-Output "${UNINSTALL_WARN_MARK} $warning" }`,
  ].join("\n");
}

/**
 * Exportee au-dela du besoin strict de cette etape : c'est ce que la tache
 * 12 appelle apres confirmation de l'utilisateur, pour effacer une
 * installation etrangere. inspect() ne verra plus alors qu'une machine sans
 * Apollo, et apply() empruntera son chemin d'installation neuve.
 *
 * Rend la liste de ce que le PC n'a PAS pu faire, dans l'ordre ou il l'a dit.
 * Une liste vide veut dire que tout le nettoyage a abouti ; elle n'est jamais
 * ignoree par ses appelants, sans quoi la tolerance aux cibles absentes
 * deviendrait du silence.
 */
export async function uninstallApollo(config: Config): Promise<string[]> {
  const result = await runRemoteChecked(config.ssh, uninstallScript(config));
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(UNINSTALL_WARN_MARK))
    .map((line) => line.slice(UNINSTALL_WARN_MARK.length).trim())
    .filter((line) => line.length > 0);
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
      // Ce chemin n'est emprunte que sur une installation ENTIERE - sunshine.exe
      // et le marqueur sont la, donc tools\, scripts\ et Uninstall.exe aussi -
      // et l'installation qui suit repose immediatement le pilote, les
      // certificats et le dossier. Ce que le demontage n'aurait pas su retirer
      // est donc recouvert dans la meme passe, et non tu : apply() n'a aucun
      // canal vers l'operateur, et en inventer un ici mentirait sur l'etat
      // final, qui est verifie par le releve suivant.
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
    // Ce que le PC n'a pas pu faire est NOMME, jamais tu : une installation a
    // demi demontee se nettoie jusqu'au bout, et ce qui manquait pour la
    // nettoyer entierement se dit a l'ecran. Meme usage que pairing.restore().
    const cedes = await uninstallApollo(config);

    if (previous.installed && !previous.ours) {
      cedes.push(
        `Apollo étranger qui existait avant hardline (version ${previous.version ?? "inconnue"}, ` +
          `${previous.pairedClients} client(s) appairé(s) au moment du constat) ` +
          `retiré avec l'accord de l'utilisateur en même temps que l'Apollo de hardline` +
          `\u00a0: hardline ne sait pas le remettre.`,
      );
    }

    if (cedes.length > 0) return { yielded: cedes.join(" ") };
  },
};
