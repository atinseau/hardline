import type { Config } from "../config";
import { getInstallationCatalog } from "../installation-catalog";
import { hardlineKnownHostsSettings } from "./hardline-identity";
import type { TargetProfile } from "./types";

export function projectTargetConfig(profile: TargetProfile): Config {
  if (profile.sshHostKey === null) {
    throw new Error("The Target Profile has no persisted SSH host key checkpoint.");
  }
  const catalog = getInstallationCatalog(profile.installationCatalogVersion);
  const user = profile.windows.administrator.split("\\").at(-1);
  const sshTrust = hardlineKnownHostsSettings(profile.hardlineIdentity.privateKeyPath);
  if (!user) {
    throw new Error("The Target Profile is missing a required Windows account.");
  }
  const prefixLength = profile.directLink.prefixLength ?? 30;

  return {
    linkKind: profile.linkKind ?? "direct",
    mac: {
      serviceName: profile.mac.ethernet.serviceName,
      ip: profile.directLink.macAddress,
      subnetMask: subnetMask(prefixLength),
    },
    windows: {
      interfaceAlias: profile.windows.ethernet.interfaceAlias,
      ip: profile.directLink.windowsAddress,
      prefixLength,
      macAddress: profile.windows.ethernet.macAddress,
      wireless: profile.windows.ethernet.wireless ?? false,
    },
    ssh: {
      host: profile.directLink.windowsAddress,
      user,
      identityFile: profile.hardlineIdentity.privateKeyPath,
      connectTimeoutSec: 8,
      ...sshTrust.target,
      sourceAddress: profile.directLink.macAddress,
      bindInterface: profile.mac.ethernet.interfaceId,
    },
    bootstrapPort: 0,
    apollo: catalog.apollo,
    moonlight: {
      version: catalog.moonlight.version,
      cask: catalog.moonlight.cask,
      recipeUrl: catalog.moonlight.recipeUrl,
      recipeSha256: catalog.moonlight.recipeSha256,
      artifactSha256: catalog.moonlight.artifactSha256,
      binary: catalog.moonlight.binary,
      clientName: catalog.moonlight.clientName,
      app: catalog.moonlight.app,
    },
  };
}

/** Le masque pointe est ce qu'attend networksetup ; le prefixe vient du profil. */
export function subnetMask(prefixLength: number): string {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (mask >>> shift) & 0xff).join(".");
}
