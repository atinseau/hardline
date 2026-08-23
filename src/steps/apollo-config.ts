import { psDoubleQuote, psQuote } from "../lib/powershell";
import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import { deleteSecret, generatePassword, setSecret } from "../lib/keychain";
import { REQUIRED_CONF, confConforms, patchConf } from "../lib/apollo-conf";
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
 * hadCredentials est lu dans sunshine_state.json, champ root.username : le
 * meme fichier qu'apollo-install.ts utilise pour pairedClients, mais lu ici
 * independamment, comme network-windows.ts et bootstrap-windows.ts
 * n'utilisent jamais le meme script d'inspection malgre leur ressemblance.
 */
const READ_STATE = (installDir: string) => {
  const installDirQ = psQuote(installDir, "répertoire d'installation");
  return `
$confPath = ${CONFIG_PATH_EXPR(installDirQ)}
$statePath = ${STATE_PATH_EXPR(installDirQ)}
$conf = if (Test-Path $confPath) { Get-Content -Path $confPath -Raw } else { $null }
$hadCredentials = $false
if (Test-Path $statePath) {
  try {
    $state = Get-Content -Path $statePath -Raw | ConvertFrom-Json
    if ($state.root -and $state.root.username) { $hadCredentials = $true }
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
$conf = if (Test-Path $confPath) { Get-Content -Path $confPath -Raw } else { $null }
$hadCredentials = $false
if (Test-Path $statePath) {
  try {
    $state = Get-Content -Path $statePath -Raw | ConvertFrom-Json
    if ($state.root -and $state.root.username) { $hadCredentials = $true }
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
      `& (Join-Path ${installDirQ} 'sunshine.exe') '--creds' ${userQ} ${passwordQ}`,
      `if ($LASTEXITCODE -ne 0) { throw "Echec de sunshine.exe --creds (code $LASTEXITCODE)" }`,
    );
  }

  lines.push(
    `New-Item -ItemType Directory -Path (Join-Path ${installDirQ} 'config') -Force -ErrorAction SilentlyContinue | Out-Null`,
    `Set-Content -Path ${CONFIG_PATH_EXPR(installDirQ)} -Value ${psDoubleQuote(patchedConf)} -Encoding ascii`,
  );

  if (serviceWasRunning) {
    lines.push(`Restart-Service -Name ${serviceNameQ} -Force -ErrorAction SilentlyContinue`);
  }

  return lines.join("\n");
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
    const conforming = current.hadCredentials && confConforms(current.conf ?? "", REQUIRED_CONF);
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

    const patched = patchConf(current.conf ?? "", REQUIRED_CONF);

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
  },

  /**
   * Rend le contenu exact d'avant, verbatim. hadCredentials decrit l'etat
   * AVANT apply() : s'il etait false, c'est hardline qui a cree ce secret,
   * et lui seul est retire. La restitution du fichier n'implique aucune
   * hypothese sur ce qu'apollo-install fera ensuite (dans l'ordre inverse,
   * apollo-install.restore s'execute apres) : ce cas compte precisement
   * quand Apollo est etranger et qu'apollo-install.restore cede sa place.
   */
  async restore(config: Config, previous: ApolloConfState, _context: RestoreContext) {
    const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
    const script =
      previous.conf === null
        ? `Remove-Item -Path ${CONFIG_PATH_EXPR(installDirQ)} -Force -ErrorAction SilentlyContinue`
        : `Set-Content -Path ${CONFIG_PATH_EXPR(installDirQ)} -Value ${psDoubleQuote(previous.conf)} -Encoding ascii`;

    await runRemoteChecked(config.ssh, script);

    if (!previous.hadCredentials) {
      await deleteSecret("apollo-web");
    }
  },
};
