import { $ } from "bun";

/** Etat d'un cask Homebrew : installe ou non, et sa version le cas echeant. */
export type MoonlightState = {
  installed: boolean;
  version: string | null;
};

type CaskInfoJson = {
  casks?: Array<{ token?: string; installed?: string | null }>;
};

/**
 * Fonction pure. Lit la sortie de `brew info --cask --json=v2 <cask>`.
 * Un cask absent du catalogue, jamais installe, ou une sortie illisible
 * rendent tous le meme etat : rien n'est installe. Une erreur de lecture ne
 * doit jamais faire echouer inspect() sur un simple JSON malforme.
 */
export function parseCaskInfo(stdout: string, cask: string): MoonlightState {
  const trimmed = stdout.trim();
  if (trimmed === "") return { installed: false, version: null };

  let parsed: CaskInfoJson;
  try {
    parsed = JSON.parse(trimmed) as CaskInfoJson;
  } catch {
    return { installed: false, version: null };
  }

  const entry = parsed.casks?.find((c) => c.token === cask);
  if (!entry || !entry.installed) return { installed: false, version: null };
  return { installed: true, version: entry.installed };
}

// --- Frontiere systeme. ---

export async function caskInfo(cask: string): Promise<MoonlightState> {
  const { stdout } = await $`brew info --cask --json=v2 ${cask}`.quiet().nothrow();
  return parseCaskInfo(stdout.toString(), cask);
}

export async function installCask(cask: string): Promise<number> {
  const { exitCode } = await $`brew install --cask ${cask}`.quiet().nothrow();
  return exitCode;
}

export async function uninstallCask(cask: string): Promise<number> {
  const { exitCode } = await $`brew uninstall --cask ${cask}`.quiet().nothrow();
  return exitCode;
}
