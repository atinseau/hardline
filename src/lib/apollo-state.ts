/**
 * Le contournement d'un defaut d'Apollo 0.4.6, mesure sur la machine.
 *
 * Apollo ecrit trois champs de chaque client appaire comme des CHAINES JSON
 * ("false" / "true") dans config\sunshine_state.json, puis les relit au
 * demarrage suivant comme des BOOLEENS. Le chargeur leve, la CRT appelle
 * abort(), et Sunshine.exe meurt en boucle : journal d'evenements Windows
 * `Sunshine.exe / ucrtbase.dll / 0xc0000409`, toujours au meme point — juste
 * apres « Found AV1 encoder », au moment d'ouvrir l'interface web. Aucun port
 * n'ecoute, donc plus rien ne repond : ni l'API, ni le flux.
 *
 * Le defaut n'est PAS celui de hardline. src/steps/pairing.ts poste
 * {pin, name} sur /api/pin, exactement le corps que l'interface web d'Apollo
 * envoie elle-meme (registerDevice(), dans assets\web\assets\pin-*.js). Tout
 * appairage, y compris depuis l'interface officielle, produit un etat qui tue
 * Apollo au demarrage suivant. hardline le contourne parce qu'il promet un PC
 * qui survit a un redemarrage, pas parce qu'il l'a provoque.
 *
 * Table de decision etablie en onze essais sur le PC, service arrete et
 * journal vide entre chaque, verdict = processus vivant ET port 47990 en
 * ecoute apres 45-60 s :
 *
 *   etat plat (username/salt/password)          VIVANT
 *   + root.uniqueid seul                        VIVANT
 *   + entree named_devices d'origine            CRASH
 *   entree sans display_mode                    CRASH
 *   entree + do/undo vides                      CRASH
 *   entree SANS cert                            CRASH
 *   entree name/uuid/cert/perm                  VIVANT
 *   la meme + allow_client_commands "false"     CRASH
 *   la meme + always_use_virtual_display "false" CRASH
 *   la meme + enable_legacy_ordering "true"     CRASH
 *   la meme + les trois en BOOLEENS JSON        VIVANT
 *
 * D'ou les deux faits que ce module tient pour acquis : ces trois champs, et
 * eux seuls, doivent etre des booleens ; `cert` doit survivre a l'operation,
 * puisque son absence plante aussi.
 */

import { psDoubleQuote, psQuote } from "./powershell";
import { runRemoteChecked, runRemoteJson } from "./ssh";
import type { Config } from "../config";

/** Les trois champs mesures coupables. Rien d'autre n'est touche. */
export const BOOLEAN_DEVICE_FIELDS = [
  "allow_client_commands",
  "always_use_virtual_display",
  "enable_legacy_ordering",
] as const;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Fonction pure. Rend le texte du fichier avec les trois champs convertis en
 * booleens, ou null quand il n'y a rien a changer — etat deja conforme, ou
 * aucun client appaire. Ce null n'est pas une commodite : il evite de
 * reecrire un fichier qu'Apollo tient ouvert, et rend l'etape idempotente
 * sans qu'elle ait a comparer elle-meme deux textes.
 *
 * La sortie est reserialisee, donc non verbatim — contrairement a patchConf
 * (src/lib/apollo-conf.ts), qui preserve commentaires et ordre parce que
 * sunshine.conf appartient a l'utilisateur. Ici le fichier appartient a
 * Apollo, qui le reecrit entierement a chaque appairage : preserver sa mise
 * en forme n'aurait aucun lecteur.
 */
export function normalizeState(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `sunshine_state.json illisible : ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isObject(parsed)) return null;

  const root = parsed.root;
  if (!isObject(root)) return null;

  const devices = root.named_devices;
  if (!Array.isArray(devices)) return null;

  let changed = false;

  for (const device of devices) {
    if (!isObject(device)) continue;

    for (const field of BOOLEAN_DEVICE_FIELDS) {
      const value = device[field];
      if (typeof value !== "string") continue;

      // Une valeur qu'on ne sait pas interpreter reste telle quelle. La
      // convertir en `false` par defaut changerait une permission — perm et
      // allow_client_commands decident de ce qu'un client a le droit de
      // faire — au nom d'une supposition, et sans que personne le voie.
      if (value !== "true" && value !== "false") continue;

      device[field] = value === "true";
      changed = true;
    }
  }

  return changed ? JSON.stringify(parsed, null, 4) : null;
}

/**
 * Le releve PowerShell du fichier d'etat, et sa reecriture desamorcee.
 *
 * Ces deux-la vivent ici et non dans une etape parce que DEUX etapes
 * empoisonnent ce fichier, chacune a sa maniere : apollo-config quand
 * sunshine.exe --creds le REECRIT ENTIEREMENT (mesure : les trois champs y
 * repassent en chaines, meme quand ils venaient d'etre corriges), et pairing
 * quand Apollo y ajoute le client appaire. Un desamorcage pose au seul
 * appairage laisserait apollo-config tuer Apollo juste avant, et l'appairage
 * suivant echouerait sur un serveur mort — c'est exactement ce qui s'est
 * produit sur la machine.
 */
const STATE_PATH_EXPR = (installDirQ: string) =>
  `(Join-Path ${installDirQ} (Join-Path 'config' 'sunshine_state.json'))`;

/**
 * Le fichier tel qu'il est sur le PC, ou null s'il n'existe pas.
 *
 * Se lit par SSH et non par l'API : quand cet etat est toxique, Apollo est
 * mort et l'API ne repond plus du tout. Un diagnostic qui passerait par elle
 * ne pourrait jamais nommer la cause de sa propre panne. Le cast [string]
 * reste DANS la branche Test-Path, pour la meme raison que dans
 * src/steps/apollo-config.ts : [string]$null vaut "" et confondrait « fichier
 * absent » avec « fichier vide ».
 */
export async function readRemoteState(config: Config): Promise<string | null> {
  const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
  const rows = await runRemoteJson<{ state: string | null }>(
    config.ssh,
    `
$statePath = ${STATE_PATH_EXPR(installDirQ)}
$state = if (Test-Path $statePath) { [string](Get-Content -Path $statePath -Raw) } else { $null }
[pscustomobject]@{ state = $state }`,
  );
  const value = rows[0]?.state ?? null;
  return typeof value === "string" ? value : null;
}

/**
 * Desamorce le fichier d'etat. Rend true quand une correction a ete posee,
 * false quand il n'y avait rien a corriger.
 *
 * Ne redemarre PAS le service : Apollo tourne deja avec cet etat en memoire,
 * et c'est SON PROCHAIN demarrage que la correction sauve. Le relancer ici
 * lui offrirait au contraire l'occasion de reecrire le fichier.
 */
export async function normalizeRemoteState(config: Config): Promise<boolean> {
  const text = await readRemoteState(config);
  if (text === null) return false;

  const patched = normalizeState(text);
  if (patched === null) return false;

  const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
  await runRemoteChecked(
    config.ssh,
    `[System.IO.File]::WriteAllText(${STATE_PATH_EXPR(installDirQ)}, ${psDoubleQuote(patched)}, (New-Object System.Text.UTF8Encoding($false)))`,
  );
  return true;
}
