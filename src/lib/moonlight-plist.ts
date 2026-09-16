import { $ } from "bun";
import { homedir, tmpdir } from "node:os";
import { unlink } from "node:fs/promises";
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
 * Ou commence et finit la valeur qui suit une cle, en lignes.
 *
 * Une valeur tient sur une ligne (`<string>..</string>`, `<true/>`) ou s'etend
 * sur plusieurs (`<data>`, et un `<dict>` ou un `<array>` imbrique). Sans
 * suivre cette etendue, retirer une cle laisserait sa valeur orpheline et
 * produirait un plist que plus rien ne sait lire.
 */
function valueSpan(lines: string[], start: number): number {
  const open = /<(data|dict|array)>\s*$/.exec(lines[start] ?? "");
  if (!open) return start;
  const tag = open[1]!;
  let depth = 1;
  for (let line = start + 1; line < lines.length; line += 1) {
    if (new RegExp(`<${tag}>\\s*$`).test(lines[line]!)) depth += 1;
    if (new RegExp(`</${tag}>`).test(lines[line]!)) {
      depth -= 1;
      if (depth === 0) return line;
    }
  }
  return lines.length - 1;
}

/**
 * Fonction pure. L'export XML prive de l'entree d'index donne.
 *
 * Retirer ne suffit pas : Qt lit ses entrees de 1 a `hosts.size`, donc un trou
 * au milieu lui cacherait tout ce qui suit. Les suivantes descendent d'un cran,
 * par leur seul NOM : leur valeur n'est jamais touchee, certificats binaires
 * compris.
 *
 * La reecriture se fait ici plutot que par PlistBuddy, qui ne connait pas
 * `Rename` et qui ABANDONNE (SIGABRT) sur les donnees binaires de ce plist —
 * verifie sur une vraie installation. Le resultat repart par `defaults import`,
 * donc par cfprefsd, qui sert ces preferences : editer le fichier dans son dos
 * laisse son cache les reecrire.
 */
export function rewriteWithoutHost(xml: string, index: number): string {
  const lines = xml.split("\n");
  const size = Math.max(0, ...hostKeys(xml).map((k) => k.index));
  const kept: string[] = [];

  for (let line = 0; line < lines.length; line += 1) {
    const key = /<key>([^<]+)<\/key>/.exec(lines[line]!)?.[1];
    if (key === undefined) {
      kept.push(lines[line]!);
      continue;
    }

    const end = valueSpan(lines, line + 1);
    const value = lines.slice(line + 1, end + 1);

    if (key === "hosts.size") {
      kept.push(lines[line]!, `\t<integer>${Math.max(0, size - 1)}</integer>`);
      line = end;
      continue;
    }

    const parts = HOST_KEY.exec(key);
    if (parts === null) {
      kept.push(lines[line]!, ...value);
      line = end;
      continue;
    }

    const rank = Number(parts[1]);
    if (rank === index) {
      line = end;
      continue;
    }
    const renamed = rank > index ? `hosts.${rank - 1}.${parts[2]}` : key;
    kept.push(lines[line]!.replace(`<key>${key}</key>`, `<key>${renamed}</key>`), ...value);
    line = end;
  }

  return kept.join("\n");
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
  const path = join(tmpdir(), `hardline-moonlight-${process.pid}.plist`);
  await Bun.write(path, rewriteWithoutHost(xml, index));

  const importProc = Bun.spawn(["defaults", "import", DOMAIN, path], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await importProc.exited;
  await unlink(path).catch(() => {});
  if (exitCode !== 0) return false;

  // `defaults import` FUSIONNE, il ne remplace pas : il pose les entrees
  // descendues d'un cran et la nouvelle taille, mais laisse en place le dernier
  // rang, desormais en trop. C'est ce rang-la qu'il reste a retirer, cle par
  // cle, seule facon de supprimer par `defaults`.
  //
  // Surtout pas de `killall cfprefsd` au bout : il etait la du temps ou l'on
  // ecrivait le fichier dans le dos du cache ; maintenant que tout PASSE par
  // cfprefsd, le tuer lui fait recharger un fichier perime et annule le
  // travail — constate sur la machine.
  const last = Math.max(0, ...hostKeys(xml).map((k) => k.index));
  for (const key of hostKeys(xml).filter((k) => k.index === last)) {
    const removal = Bun.spawn(["defaults", "delete", DOMAIN, key.key], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await removal.exited) !== 0) return false;
  }
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
