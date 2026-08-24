import { createHash, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Etat d'un cask Homebrew : installe ou non, et sa version le cas echeant. */
export type MoonlightState = {
  installed: boolean;
  version: string | null;
};

export type PinnedCaskRecipe = {
  cask: string;
  version: string;
  recipeUrl: string;
  recipeSha256: string;
  artifactSha256: string;
};

type CaskInfoJson = {
  casks?: Array<{ token?: string; installed?: string | null }>;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
};

export type BrewCommandRunner = (
  argv: readonly string[],
) => Promise<CommandResult>;

type InstallCaskDependencies = {
  fetch: (url: string) => Promise<Response>;
  mkdtemp: (prefix: string) => Promise<string>;
  writeFile: (
    path: string,
    contents: Uint8Array,
    options: { mode: number },
  ) => Promise<void>;
  rm: (
    path: string,
    options: { recursive: true; force: true },
  ) => Promise<void>;
  run: BrewCommandRunner;
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

async function runCommand(argv: readonly string[]): Promise<CommandResult> {
  const process = Bun.spawn([...argv], { stdout: "pipe", stderr: "ignore" });
  const [stdout, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  return { exitCode, stdout };
}

export async function caskInfo(
  cask: string,
  run: BrewCommandRunner = runCommand,
): Promise<MoonlightState> {
  const result = await run(["brew", "info", "--cask", "--json=v2", cask]);
  return parseCaskInfo(result.stdout, cask);
}

function validSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function hashesMatch(actual: string, expected: string): boolean {
  return validSha256(expected) && timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex"),
  );
}

function verifyRecipeFacts(contents: Uint8Array, recipe: PinnedCaskRecipe): void {
  const text = new TextDecoder().decode(contents);
  const declaredVersion = /^\s*version\s+"([^"]+)"\s*$/m.exec(text)?.[1];
  const declaredArtifactSha256 = /^\s*sha256\s+"([a-f0-9]{64})"\s*$/m.exec(text)?.[1];

  if (declaredVersion !== recipe.version) {
    throw new Error(
      `La recette Moonlight declare la version ${declaredVersion ?? "inconnue"}, pas ${recipe.version}.`,
    );
  }
  if (declaredArtifactSha256 !== recipe.artifactSha256) {
    throw new Error("L'empreinte de l'artefact Moonlight ne correspond pas au catalogue.");
  }
}

export async function installCask(
  recipe: PinnedCaskRecipe,
  dependencies: Partial<InstallCaskDependencies> = {},
): Promise<number> {
  const url = new URL(recipe.recipeUrl);
  if (url.protocol !== "https:") {
    throw new Error("La recette Moonlight doit etre telechargee via HTTPS.");
  }

  const io: InstallCaskDependencies = {
    fetch: async (input) => fetch(input),
    mkdtemp,
    writeFile,
    rm,
    run: runCommand,
    ...dependencies,
  };
  const directory = await io.mkdtemp(join(tmpdir(), "hardline-moonlight-"));
  const recipePath = join(directory, `${recipe.cask}.rb`);

  try {
    const response = await io.fetch(recipe.recipeUrl);
    if (!response.ok) {
      throw new Error(
        `Impossible de telecharger la recette Moonlight (HTTP ${response.status}).`,
      );
    }
    const contents = new Uint8Array(await response.arrayBuffer());
    await io.writeFile(recipePath, contents, { mode: 0o600 });

    const actualSha256 = createHash("sha256").update(contents).digest("hex");
    if (!hashesMatch(actualSha256, recipe.recipeSha256)) {
      throw new Error("L'empreinte de la recette Moonlight ne correspond pas au catalogue.");
    }
    verifyRecipeFacts(contents, recipe);

    const result = await io.run(["brew", "install", "--cask", recipePath]);
    return result.exitCode;
  } finally {
    await io.rm(directory, { recursive: true, force: true });
  }
}

export async function uninstallCask(
  cask: string,
  run: BrewCommandRunner = runCommand,
): Promise<number> {
  const result = await run(["brew", "uninstall", "--cask", cask]);
  return result.exitCode;
}
