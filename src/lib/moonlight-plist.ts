import { $ } from "bun";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const DOMAIN = "com.moonlight-stream.Moonlight";
const PLIST_PATH = join(homedir(), "Library", "Preferences", `${DOMAIN}.plist`);

export type MoonlightHost = { address: string };

/**
 * Fonction pure. Lit le JSON rendu par `plutil -convert json -o -` applique a
 * un export du domaine de preferences de Moonlight. Toute forme inattendue —
 * domaine absent, JSON illisible, cle "hosts" manquante — rend un tableau
 * vide plutot que de lever : l'absence d'hote connu est un etat normal, pas
 * une erreur.
 */
export function parseHosts(json: string): MoonlightHost[] {
  const trimmed = json.trim();
  if (trimmed === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (typeof parsed !== "object" || parsed === null) return [];
  const hosts = (parsed as Record<string, unknown>)["hosts"];
  if (!Array.isArray(hosts)) return [];

  return hosts
    .filter((h): h is Record<string, unknown> => typeof h === "object" && h !== null)
    .map((h) => ({
      address: typeof h["address"] === "string" ? h["address"] : "",
    }))
    .filter((h) => h.address !== "");
}

/** Fonction pure. Vrai si l'hote figure deja parmi les entrees connues. */
export function containsHost(hosts: MoonlightHost[], host: string): boolean {
  return hosts.some((h) => h.address === host);
}

/**
 * Fonction pure. Comme parseHosts, mais SANS filtrer les entrees mal
 * formees : rend l'index de la premiere entree dont l'adresse correspond,
 * dans le tableau BRUT tel qu'il apparait dans le JSON. C'est cet index, et
 * non celui d'une liste filtree, qui doit etre transmis a PlistBuddy : une
 * entree mal formee AVANT la notre decale l'index d'une liste filtree par
 * rapport a l'index reel du tableau, et ferait supprimer la mauvaise entree.
 * null si le domaine est absent, le JSON illisible, ou l'hote non trouve.
 */
export function rawHostIndex(json: string, host: string): number | null {
  const trimmed = json.trim();
  if (trimmed === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const hosts = (parsed as Record<string, unknown>)["hosts"];
  if (!Array.isArray(hosts)) return null;

  for (let i = 0; i < hosts.length; i++) {
    const entry = hosts[i];
    if (
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>)["address"] === host
    ) {
      return i;
    }
  }
  return null;
}

/**
 * Fonction pure. Compose la commande PlistBuddy qui retire l'hote a l'index
 * BRUT donne. `defaults delete <domaine> hosts.<index>` n'a pas de syntaxe
 * de chemin indexe pour un tableau et sort en erreur sans rien modifier --
 * verifie sur une vraie installation. PlistBuddy est le seul des deux outils
 * qui cible reellement l'entree.
 */
export function forgetHostArgs(index: number): string[] {
  return ["/usr/libexec/PlistBuddy", "-c", `Delete :hosts:${index}`, PLIST_PATH];
}

// --- Frontiere systeme. ---

/** Lit le plist de Moonlight. Tableau vide s'il n'existe pas ou est vide. */
export async function readHosts(): Promise<MoonlightHost[]> {
  const { stdout } = await $`defaults export ${DOMAIN} - | plutil -convert json -o - -`
    .quiet()
    .nothrow();
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
export async function forgetHostAtIndex(index: number): Promise<boolean> {
  const deleteProc = Bun.spawn(forgetHostArgs(index), { stdout: "ignore", stderr: "ignore" });
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
 * Retire l'entree d'hote du plist. L'index vise le tableau BRUT du JSON
 * (rawHostIndex), jamais une liste filtree par parseHosts.
 *
 * Rend true si l'hote est absent apres l'appel : soit il ne s'y trouvait
 * pas, soit la suppression a ete confirmee. Rend false s'il y figurait et
 * que la suppression a echoue -- ce cas ne doit jamais etre pris pour un
 * succes silencieux par l'appelant.
 */
export async function forgetHost(host: string): Promise<boolean> {
  const { stdout } = await $`defaults export ${DOMAIN} - | plutil -convert json -o - -`
    .quiet()
    .nothrow();
  const index = rawHostIndex(stdout.toString(), host);
  if (index === null) return true;
  return forgetHostAtIndex(index);
}
