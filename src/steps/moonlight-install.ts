import { caskInfo, installCask, uninstallCask } from "../lib/brew";
import type { MoonlightState } from "../lib/brew";
import type { Config } from "../config";
import type { Step } from "./types";

export type { MoonlightState } from "../lib/brew";

/**
 * Le code de retour de brew ne doit jamais etre ignore : sans cette
 * verification l'etape se declare accomplie meme quand l'operation a echoue,
 * et l'orchestrateur enregistre une convergence qui n'a pas eu lieu.
 */
function ensureAccepted(exitCode: number, action: string, cask: string): void {
  if (exitCode === 0) return;
  throw new Error(
    `Homebrew a refusé de ${action} le cask «\u00a0${cask}\u00a0» (code ${exitCode}).`,
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
    const exitCode = await installCask(config.moonlight);
    ensureAccepted(exitCode, "poser", config.moonlight.cask);
    const installed = await caskInfo(config.moonlight.cask);
    if (!installed.installed || installed.version !== config.moonlight.version) {
      throw new Error(
        `Moonlight ${config.moonlight.version} etait attendu apres l'installation, version observee : ${installed.version ?? "absente"}.`,
      );
    }
  },

  async restore(config: Config) {
    const exitCode = await uninstallCask(config.moonlight.cask);
    ensureAccepted(exitCode, "retirer", config.moonlight.cask);
  },
};
