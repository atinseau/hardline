import { $ } from "bun";

const DOMAIN = "com.moonlight-stream.Moonlight";

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

// --- Frontiere systeme. ---

/** Lit le plist de Moonlight. Tableau vide s'il n'existe pas ou est vide. */
export async function readHosts(): Promise<MoonlightHost[]> {
  const { stdout } = await $`defaults export ${DOMAIN} - | plutil -convert json -o - -`
    .quiet()
    .nothrow();
  return parseHosts(stdout.toString());
}

/** Retire l'entree d'hote du plist. Ne leve jamais pour une absence. */
export async function forgetHost(host: string): Promise<void> {
  const hosts = await readHosts();
  const index = hosts.findIndex((h) => h.address === host);
  if (index === -1) return;
  await $`defaults delete ${DOMAIN} hosts.${index}`.quiet().nothrow();
}
