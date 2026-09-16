import {
  getServiceInfo,
  setServiceDHCP,
  setServiceIPv4Off,
  setServiceManualIP,
  type ServiceIPConfig,
} from "../lib/shell";
import type { Config } from "../config";
import type { Step } from "./types";

/**
 * Le code de retour de networksetup ne doit jamais etre ignore : sans cette
 * verification l'etape se declare accomplie meme quand sudo a refuse, et
 * l'orchestrateur enregistre une convergence — ou une restauration — qui n'a
 * pas eu lieu. Cote restauration c'est le pire cas possible : l'orchestrateur
 * appelle forgetStep et efface la seule trace de l'etat anterieur.
 */
function ensureAccepted(
  exitCode: number,
  action: string,
  service: string,
): void {
  if (exitCode === 0) return;
  throw new Error(
    `networksetup a refusé de ${action} sur «\u00a0${service}\u00a0» (code ${exitCode}). Droits administrateur\u00a0?`,
  );
}

/**
 * Le service releve fait partie de l'etat, au meme titre que l'adressage.
 *
 * Le projet applique deja cette regle a l'amorcage : « le releve est l'autorite
 * sur l'interface qu'il decrit ». Elle vaut ici pour la meme raison, et le jour
 * ou le lien change d'adaptateur elle devient la seule chose qui empeche une
 * desinstallation de rendre le DHCP au mauvais service — celui du lien actuel
 * plutot que celui qu'on avait modifie. Absent, on retombe sur la
 * configuration : les anciens manifestes n'ont pas ce champ, et ils decrivent
 * un temps ou le lien ne pouvait pas changer.
 */
export type MacNetworkState = ServiceIPConfig & { serviceName?: string };

export const macNetworkStep: Step<MacNetworkState> = {
  name: "network-mac",
  label: "Adresse fixe sur le lien direct (Mac)",

  async inspect(config: Config) {
    const current = await getServiceInfo(config.mac.serviceName);

    const conforming =
      current.mode === "manual" &&
      current.ip === config.mac.ip &&
      current.subnetMask === config.mac.subnetMask &&
      current.router === null;

    return {
      conforming,
      current: { ...current, serviceName: config.mac.serviceName },
      detail: conforming
        ? `${config.mac.serviceName} déjà en ${config.mac.ip}`
        : `${config.mac.serviceName} en ${current.mode}${current.ip ? ` (${current.ip})` : ""}`,
    };
  },

  async apply(config: Config) {
    const exitCode = await setServiceManualIP(
      config.mac.serviceName,
      config.mac.ip,
      config.mac.subnetMask,
    );

    ensureAccepted(exitCode, `poser ${config.mac.ip}`, config.mac.serviceName);
  },

  async restore(config: Config, previous: MacNetworkState) {
    const service = previous.serviceName ?? config.mac.serviceName;
    if (previous.mode === "manual" && previous.ip && previous.subnetMask) {
      const exitCode = await setServiceManualIP(
        service,
        previous.ip,
        previous.subnetMask,
      );
      ensureAccepted(
        exitCode,
        `rendre ${previous.ip}`,
        service,
      );
      return;
    }
    if (previous.mode === "off") {
      // Restaurer en DHCP un service que l'utilisateur avait desactive serait
      // deviner a sa place : la spec exige de rendre l'etat anterieur, pas un
      // etat plausible.
      const exitCode = await setServiceIPv4Off(service);
      ensureAccepted(exitCode, "redésactiver IPv4", service);
      return;
    }

    const exitCode = await setServiceDHCP(service);
    ensureAccepted(exitCode, "rendre le DHCP", service);
  },
};
