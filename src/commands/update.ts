import { access, constants, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";
import type { CommandOutput, CommandResult, CommandRun } from "../command-run";
import { runCommand } from "../command-run";
import { errorMessage } from "../lib/errors";
import { VERSION } from "../version";

const REPOSITORY = "atinseau/hardline";
const LATEST_RELEASE = `https://github.com/${REPOSITORY}/releases/latest`;
const LATEST_BINARY = `https://github.com/${REPOSITORY}/releases/latest/download/hardline`;

type UpdateFact = {
  id:
    | "title"
    | "look-up"
    | "download"
    | "replace"
    | "current"
    | "ahead"
    | "updated"
    | "not-installed"
    | "not-writable"
    | "failed";
  values?: Record<string, unknown>;
};

const fact = (id: UpdateFact["id"], values?: Record<string, unknown>): UpdateFact => ({
  id,
  ...(values ? { values } : {}),
});

export function renderUpdateFact(value: UpdateFact): string {
  switch (value.id) {
    case "title": return "Update Hardline";
    case "look-up": return "Look Up the Latest Release";
    case "download": return "Download the Release Binary";
    case "replace": return "Replace the Installed Binary";
    case "current": return `Hardline is already at the latest release (${value.values?.version}).`;
    case "ahead":
      return `Hardline is at ${value.values?.version}, ahead of the latest release (${value.values?.latest}). Nothing to do.`;
    case "updated": return `Hardline updated from ${value.values?.from} to ${value.values?.to}.`;
    case "not-installed":
      return "Update replaces the installed executable, and this Hardline is running from source. Build it with 'bun run build' instead, or run the installed 'hardline update'.";
    case "not-writable":
      return `Replacing ${value.values?.path} needs administrator rights, because that directory belongs to root. Run 'sudo hardline update', or move Hardline once into a directory you own and never need sudo again: 'sudo mv ${value.values?.path} "$(brew --prefix)/bin/hardline"'.`;
    case "failed": return `Could not update Hardline: ${value.values?.error}`;
  }
}

/** Le tag d'une publication porte un `v` que la version du binaire n'a pas. */
function versionOfTag(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/**
 * Une version est-elle plus recente qu'une autre ? Comparer par egalite suffit
 * a savoir s'il y a quelque chose a faire, mais pas dans quel sens : un binaire
 * construit localement, en avance sur la derniere publication, se faisait
 * remplacer par une version plus ancienne sans un mot.
 *
 * Ce qui n'est pas trois nombres n'est jamais plus recent : une etiquette de
 * pre-publication ne declenche donc aucun remplacement.
 */
export function isNewer(candidate: string, current: string): boolean {
  const numbers = (version: string): number[] => version.split(".").map(Number);
  const [left, right] = [numbers(candidate), numbers(current)];
  // Avant toute comparaison : un seul champ illisible suffit a ne plus rien
  // savoir. Juger sur les champs qui precedent reviendrait a traiter
  // "0.2.0-beta" comme la version publiee 0.2.0.
  if ([...left, ...right].some(Number.isNaN)) return false;
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

/** Le tag que designe la redirection de /releases/latest, s'il y en a un. */
export function tagFromRedirect(location: string | null): string | null {
  const tag = location?.split("/tag/")[1];
  return tag ? decodeURIComponent(tag) : null;
}

export type UpdateEnvironment = {
  /** Chemin de l'executable a remplacer, ou `null` hors binaire compile. */
  installedPath: () => string | null;
  latestTag: () => Promise<string>;
  download: (destination: string) => Promise<void>;
  /** Ce que le binaire telecharge dit de lui-meme, avant d'ecraser quoi que ce soit. */
  versionOf: (path: string) => Promise<string>;
  writable: (directory: string) => Promise<boolean>;
  replace: (source: string, destination: string) => Promise<void>;
};

export const liveUpdateEnvironment: UpdateEnvironment = {
  // Un binaire compile par Bun sert ses sources depuis un systeme de fichiers
  // virtuel. Lance depuis les sources, `process.execPath` est bun lui-meme :
  // ecraser ce chemin detruirait l'installation de Bun de l'utilisateur.
  installedPath: () => (Bun.main.startsWith("/$bunfs") ? process.execPath : null),

  latestTag: async () => {
    // La page publique redirige vers la derniere publication. L'API REST le
    // dirait aussi, mais elle n'accorde que soixante appels anonymes par heure
    // et par adresse : un quota epuise refuserait la mise a jour avec un 403
    // que personne ne peut relier a ce qu'il a demande.
    const response = await fetch(LATEST_RELEASE, { redirect: "manual" });
    const tag = tagFromRedirect(response.headers.get("location"));
    if (!tag) {
      throw new Error(
        `GitHub did not point at a latest release (HTTP ${response.status}). The repository may carry no published release yet.`,
      );
    }
    return tag;
  },

  download: async (destination) => {
    const response = await fetch(LATEST_BINARY);
    if (!response.ok) {
      throw new Error(`Downloading the release binary failed with ${response.status}.`);
    }
    await Bun.write(destination, response);
    await $`chmod 0755 ${destination}`.quiet();
  },

  versionOf: async (path) => {
    const { exitCode, stdout } = await $`${path} --version`.quiet().nothrow();
    if (exitCode !== 0) throw new Error("The downloaded binary does not run on this machine.");
    return stdout.toString().trim();
  },

  writable: (directory) =>
    access(directory, constants.W_OK).then(() => true, () => false),

  replace: async (source, destination) => {
    // `install` remplace en une etape et traverse les systemes de fichiers, ce
    // qu'un `rename` depuis /tmp ne fait pas.
    const { exitCode, stderr } = await $`install -m 0755 ${source} ${destination}`
      .quiet()
      .nothrow();
    if (exitCode !== 0) throw new Error(stderr.toString().trim() || "install failed.");
  },
};

export function updateCommand(options: {
  output: CommandOutput;
  environment?: UpdateEnvironment;
  currentVersion?: string;
}): Promise<CommandResult<UpdateFact>> {
  const environment = options.environment ?? liveUpdateEnvironment;
  const current = options.currentVersion ?? VERSION;

  return runCommand<UpdateFact>({
    title: fact("title"),
    render: renderUpdateFact,
    output: options.output,
    unexpected: (error) => fact("failed", { error: errorMessage(error) }),
    execute: async (run: CommandRun<UpdateFact>) => {
      const installed = environment.installedPath();
      if (installed === null) {
        return { status: "failed", summary: fact("not-installed") };
      }

      const tag = await run.phase(fact("look-up"), () => environment.latestTag());
      const latest = versionOfTag(tag);
      if (latest === current) {
        return { status: "succeeded", summary: fact("current", { version: current }) };
      }
      if (!isNewer(latest, current)) {
        return {
          status: "succeeded",
          summary: fact("ahead", { version: current, latest }),
        };
      }

      if (!(await environment.writable(dirname(installed)))) {
        return { status: "failed", summary: fact("not-writable", { path: installed }) };
      }

      const staged = join(tmpdir(), `hardline-${tag}`);
      try {
        await run.phase(fact("download"), async () => {
          await environment.download(staged);
          const reported = await environment.versionOf(staged);
          if (!reported.includes(latest)) {
            throw new Error(
              `The downloaded binary reports ${reported} instead of ${latest}; nothing was replaced.`,
            );
          }
        });
        await run.phase(fact("replace"), () => environment.replace(staged, installed));
      } finally {
        await rm(staged, { force: true });
      }

      return {
        status: "succeeded",
        summary: fact("updated", { from: current, to: latest }),
      };
    },
  });
}
