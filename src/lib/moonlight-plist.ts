import { $ } from "bun";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const DOMAIN = "com.moonlight-stream.Moonlight";
const PLIST_PATH = join(homedir(), "Library", "Preferences", `${DOMAIN}.plist`);

export type MoonlightHost = { address: string };

/**
 * Moonlight n'ecrit PAS un tableau `hosts`. Qt serialise ses reglages en cles
 * PLATES — `hosts.2.localaddress`, `hosts.size` — et le point n'y est qu'un
 * caractere du nom. Tout ce module a longtemps suppose un tableau : la lecture
 * rendait donc toujours zero hote, et la suppression visait `:hosts:2`, un
 * chemin qui n'existe pas. La desinstallation laissait ses entrees derriere
 * elle, une de plus a chaque appairage.
 *
 * La lecture se fait en XML et non en JSON : `plutil -convert json` ECHOUE sur
 * ce plist — « Invalid object in plist for JSON format » — parce que Moonlight
 * y range les certificats des serveurs en binaire, que JSON ne represente pas.
 */
const HOST_KEY = /^hosts\.(\d+)\.(.+)$/;

/** Fonction pure. Toutes les cles d'hote de l'export, avec leur index Qt. */
export function hostKeys(xml: string): { index: number; field: string; key: string }[] {
  const keys: { index: number; field: string; key: string }[] = [];
  for (const match of xml.matchAll(/<key>([^<]+)<\/key>/g)) {
    const key = match[1]!;
    const parts = HOST_KEY.exec(key);
    if (parts) keys.push({ index: Number(parts[1]), field: parts[2]!, key });
  }
  return keys;
}

function stringValue(xml: string, key: string): string | null {
  const escaped = key.replaceAll(".", "\\.");
  const match = new RegExp(`<key>${escaped}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return match?.[1] ?? null;
}

/**
 * Fonction pure. Les hotes connus de Moonlight, lus dans un export XML du
 * domaine. Toute forme inattendue — domaine absent, export vide, aucune cle
 * d'hote — rend un tableau vide plutot que de lever : n'avoir aucun hote connu
 * est un etat normal, pas une erreur.
 */
export function parseHosts(xml: string): MoonlightHost[] {
  const indexes = [...new Set(hostKeys(xml).map((k) => k.index))].sort((a, b) => a - b);
  const hosts: MoonlightHost[] = [];
  for (const index of indexes) {
    const address =
      stringValue(xml, `hosts.${index}.manualaddress`) ??
      stringValue(xml, `hosts.${index}.localaddress`);
    if (address) hosts.push({ address });
  }
  return hosts;
}

/** Fonction pure. Vrai si l'hote figure deja parmi les entrees connues. */
export function containsHost(hosts: MoonlightHost[], host: string): boolean {
  return hosts.some((h) => h.address === host);
}

/**
 * Fonction pure. L'index Qt de la premiere entree portant cette adresse, ou
 * null. C'est cet index — celui des cles plates, pas celui d'une liste filtree
 * — qui commande la suppression : une entree sans adresse avant la notre
 * decalerait une liste filtree et ferait supprimer la mauvaise.
 */
export function hostIndex(xml: string, host: string): number | null {
  const indexes = [...new Set(hostKeys(xml).map((k) => k.index))].sort((a, b) => a - b);
  for (const index of indexes) {
    const manual = stringValue(xml, `hosts.${index}.manualaddress`);
    const local = stringValue(xml, `hosts.${index}.localaddress`);
    if (manual === host || local === host) return index;
  }
  return null;
}

/**
 * Fonction pure. Les commandes PlistBuddy qui retirent l'entree d'index donne.
 *
 * Retirer ne suffit pas : Qt lit ses entrees de 1 a `hosts.size`, donc un trou
 * au milieu lui cacherait tout ce qui suit. Les entrees suivantes sont donc
 * RENOMMEES d'un cran — ce qui preserve type et valeur, y compris les
 * certificats binaires — et la taille est mise a jour en dernier.
 */
export function forgetHostCommands(xml: string, index: number): string[] {
  const keys = hostKeys(xml);
  const size = Math.max(0, ...keys.map((k) => k.index));
  const commands: string[] = [];

  for (const key of keys.filter((k) => k.index === index)) {
    commands.push(`Delete :${key.key}`);
  }
  for (let source = index + 1; source <= size; source += 1) {
    for (const key of keys.filter((k) => k.index === source)) {
      commands.push(`Rename :${key.key} :hosts.${source - 1}.${key.field}`);
    }
  }
  commands.push(`Set :hosts.size ${Math.max(0, size - 1)}`);
  return commands;
}

/** Fonction pure. L'invocation complete de PlistBuddy pour ces commandes. */
export function forgetHostArgs(commands: string[]): string[] {
  return [
    "/usr/libexec/PlistBuddy",
    ...commands.flatMap((command) => ["-c", command]),
    PLIST_PATH,
  ];
}

// --- Frontiere systeme. ---

/** Lit le plist de Moonlight. Tableau vide s'il n'existe pas ou est vide. */
export async function readHosts(): Promise<MoonlightHost[]> {
  const { stdout } = await $`defaults export ${DOMAIN} -`.quiet().nothrow();
  return parseHosts(stdout.toString());
}

/**
 * Retire l'entree a l'index BRUT donne, puis tue cfprefsd pour que son cache
 * cesse de servir l'ancien contenu du plist. Isolee de la lecture du plist
 * pour que la commande emise reste observable en test par substitution de
 * Bun.spawn, sans jamais executer PlistBuddy pour de vrai. Rend true
 * seulement si PlistBuddy a confirme la suppression par un code de sortie
 * nul ; ce code de sortie fait foi ici, verifie a la main sur une vraie
 * installation.
 */
export async function forgetHostAtIndex(
  xml: string,
  index: number,
): Promise<boolean> {
  const deleteProc = Bun.spawn(forgetHostArgs(forgetHostCommands(xml, index)), {
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await deleteProc.exited;
  if (exitCode !== 0) return false;

  const killProc = Bun.spawn(["killall", "-u", userInfo().username, "cfprefsd"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await killProc.exited;
  return true;
}

/**
 * Le corps entier de forgetHost, prive du seul appel que rien ne peut
 * intercepter en test : le `$` de Bun echappe a mock.module (verifie
 * empiriquement, voir test/lib/display.test.ts), donc cette fonction recoit
 * le JSON en parametre plutot que de le lire elle-meme. C'est elle qui
 * calcule l'index -- via rawHostIndex, jamais une liste filtree par
 * parseHosts -- et la transmet a forgetHostAtIndex. forgetHost() ci-dessous
 * n'est qu'un branchement sur la lecture reelle : tester cette fonction,
 * c'est tester exactement le chemin que restore() emprunte.
 *
 * Rend true si l'hote est absent apres l'appel : soit il ne figurait pas
 * dans le JSON, soit la suppression a ete confirmee. Rend false s'il y
 * figurait et que la suppression a echoue -- ce cas ne doit jamais etre pris
 * pour un succes silencieux par l'appelant.
 */
export async function forgetHostFromExport(xml: string, host: string): Promise<boolean> {
  const index = hostIndex(xml, host);
  if (index === null) return true;
  return forgetHostAtIndex(xml, index);
}

/** Retire l'entree d'hote du plist. Voir forgetHostFromExport pour la logique. */
export async function forgetHost(host: string): Promise<boolean> {
  // Oublier un hote, c'est n'en laisser AUCUNE entree. Le meme PC peut en
  // porter plusieurs : un appairage par installation, et rien ne les fusionne.
  // La relecture entre deux suppressions n'est pas une precaution de style :
  // la renumerotation deplace les entrees restantes.
  for (let passe = 0; passe < 16; passe += 1) {
    const { stdout } = await $`defaults export ${DOMAIN} -`.quiet().nothrow();
    const xml = stdout.toString();
    if (hostIndex(xml, host) === null) return true;
    if (!(await forgetHostFromExport(xml, host))) return false;
  }
  return false;
}
