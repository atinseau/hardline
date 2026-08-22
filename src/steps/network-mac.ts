import {
  getServiceInfo,
  setServiceDHCP,
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
    // DHCP comme dans le cas "off" : c'est l'etat par defaut d'un service macOS,
    // et le seul qui ne laisse pas une adresse morte derriere lui.
    await setServiceDHCP(config.mac.serviceName);
  },
};
