import {
  getServiceInfo,
  setServiceDHCP,
  setServiceIPv4Off,
  setServiceManualIP,
  type ServiceIPConfig,
} from "../lib/shell";
import type { Config } from "../config";
import type { Step } from "./types";

export const macNetworkStep: Step<ServiceIPConfig> = {
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
      current,
      detail: conforming
        ? `${config.mac.serviceName} deja en ${config.mac.ip}`
        : `${config.mac.serviceName} en ${current.mode}${current.ip ? ` (${current.ip})` : ""}`,
    };
  },

  async apply(config: Config) {
    await setServiceManualIP(
      config.mac.serviceName,
      config.mac.ip,
      config.mac.subnetMask,
    );
  },

  async restore(config: Config, previous: ServiceIPConfig) {
    if (previous.mode === "manual" && previous.ip && previous.subnetMask) {
      await setServiceManualIP(
        config.mac.serviceName,
        previous.ip,
        previous.subnetMask,
      );
      return;
    }
    if (previous.mode === "off") {
      // Restaurer en DHCP un service que l'utilisateur avait desactive serait
      // deviner a sa place : la spec exige de rendre l'etat anterieur, pas un
      // etat plausible.
      await setServiceIPv4Off(config.mac.serviceName);
      return;
    }

    await setServiceDHCP(config.mac.serviceName);
  },
};
