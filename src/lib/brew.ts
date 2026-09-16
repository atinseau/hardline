/** Etat d'un cask Homebrew : installe ou non, et sa version le cas echeant. */
export type MoonlightState = {
  installed: boolean;
  version: string | null;
};

export type PinnedCaskRecipe = {
  cask: string;
  version: string;
  artifactSha256: string;
};

type CaskInfoJson = {
  casks?: Array<{
    token?: string;
    installed?: string | null;
    version?: string | null;
    sha256?: string | null;
  }>;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  /** Ce que la commande a dit en echouant. Sans lui, un refus n'a pas de cause. */
  stderr?: string;
};

export type BrewCommandRunner = (
  argv: readonly string[],
) => Promise<CommandResult>;

/**
 * Homebrew est-il installe sur ce Mac ?
 *
 * La question se pose AVANT l'amorcage, pas pendant la convergence : le client
 * Moonlight s'installe par Homebrew, et l'amorcage modifie le PC. Sans cette
 * porte, un Mac sans Homebrew faisait coller la commande PowerShell, laissait
 * l'amorcage s'executer, puis echouait chez lui sur un prerequis qu'une ligne
 * suffisait a constater.
 */
export function brewInstalled(): boolean {
  return Bun.which("brew", { PATH: process.env.PATH ?? "" }) !== null;
}

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

async function runCommand(argv: readonly string[]): Promise<CommandResult> {
  const process = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
}

export async function caskInfo(
  cask: string,
  run: BrewCommandRunner = runCommand,
): Promise<MoonlightState> {
  const result = await run(["brew", "info", "--cask", "--json=v2", cask]);
  return parseCaskInfo(result.stdout, cask);
}

/**
 * Fonction pure. Lit ce que Homebrew PROPOSE pour un cask : la version et
 * l'empreinte de l'artefact, avant toute installation.
 */
export function parseCaskOffer(
  stdout: string,
  cask: string,
): { version: string | null; artifactSha256: string | null } {
  try {
    const parsed = JSON.parse(stdout.trim()) as CaskInfoJson;
    const entry = parsed.casks?.find((c) => c.token === cask);
    return {
      version: entry?.version ?? null,
      artifactSha256: entry?.sha256 ?? null,
    };
  } catch {
    return { version: null, artifactSha256: null };
  }
}

/**
 * Pose le cask du tap Homebrew, apres avoir verifie qu'il porte EXACTEMENT ce
 * que le catalogue epingle.
 *
 * Hardline posait auparavant une recette telechargee dans un fichier
 * temporaire, ce qui fixait la version quoi qu'il arrive en amont. Homebrew a
 * ferme ce chemin : « Homebrew requires casks to be in a tap ». L'epinglage ne
 * peut donc plus imposer une version, seulement la CONSTATER : on lit ce que le
 * tap propose, on refuse si cela s'ecarte du catalogue, et on n'installe que du
 * connu. Un artefact republie sous la meme version est refuse par l'empreinte.
 */
export async function installCask(
  recipe: PinnedCaskRecipe,
  run: BrewCommandRunner = runCommand,
): Promise<CommandResult> {
  const info = await run(["brew", "info", "--cask", "--json=v2", recipe.cask]);
  const offer = parseCaskOffer(info.stdout, recipe.cask);

  if (
    offer.version !== recipe.version ||
    offer.artifactSha256 !== recipe.artifactSha256
  ) {
    throw new Error(
      `Homebrew propose ${recipe.cask} ${offer.version ?? "de version inconnue"} ` +
        `(empreinte ${offer.artifactSha256 ?? "inconnue"}), le catalogue Hardline attend ` +
        `${recipe.version} (${recipe.artifactSha256}). Rien n'a ete installe : mettre le ` +
        `catalogue a jour, ou 'brew update' si le tap est en retard.`,
    );
  }

  return run(["brew", "install", "--cask", recipe.cask]);
}

export async function uninstallCask(
  cask: string,
  run: BrewCommandRunner = runCommand,
): Promise<CommandResult> {
  return run(["brew", "uninstall", "--cask", cask]);
}
