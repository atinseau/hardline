import { caskInfo, installCask, uninstallCask } from "../lib/brew";
import type { MoonlightState } from "../lib/brew";
import type { Config } from "../config";
import type { Step } from "./types";

export type { MoonlightState } from "../lib/brew";

/**
 * Le code de retour de brew ne doit jamais etre ignore : sans cette
 * verification l'etape se declare accomplie meme quand l'operation a echoue,
 * et l'orchestrateur enregistre une convergence qui n'a pas eu lieu.
 *
 * Le code seul ne suffit pas non plus. « code 1 » a longtemps ete tout ce que
 * l'operateur voyait la ou brew disait precisement ce qui le genait.
 */
function ensureAccepted(
  result: { exitCode: number; stderr?: string },
  action: string,
  cask: string,
): void {
  if (result.exitCode === 0) return;
  const cause = result.stderr?.trim();
  throw new Error(
    `Homebrew a refusé de ${action} le cask «\u00a0${cask}\u00a0» (code ${result.exitCode})` +
      (cause ? `\u00a0: ${cause}` : "."),
  );
}

export const moonlightInstallStep: Step<MoonlightState> = {
  name: "moonlight-install",
  label: "Client Moonlight installé (Mac)",

  async inspect(config: Config) {
    const current = await caskInfo(config.moonlight.cask);
    return {
      conforming:
        current.installed && current.version === config.moonlight.version,
      current,
      detail: current.installed
        ? `${config.moonlight.cask} ${current.version ?? "version inconnue"}`
        : `${config.moonlight.cask} absent`,
    };
  },

  async apply(config: Config) {
    ensureAccepted(await installCask(config.moonlight), "poser", config.moonlight.cask);
    const installed = await caskInfo(config.moonlight.cask);
    if (!installed.installed || installed.version !== config.moonlight.version) {
      throw new Error(
        `Moonlight ${config.moonlight.version} etait attendu apres l'installation, version observee : ${installed.version ?? "absente"}.`,
      );
    }
  },

  async restore(config: Config) {
    ensureAccepted(
      await uninstallCask(config.moonlight.cask),
      "retirer",
      config.moonlight.cask,
    );
  },
};
