export type InstallationCatalogVersion = "2026.08.24";

export type InstallationCatalog = Readonly<{
  schemaVersion: 1;
  version: InstallationCatalogVersion;
  apollo: Readonly<{
    version: "0.4.6";
    installerUrl: string;
    installerSha256: string;
    installDir: string;
    serviceName: string;
    apiPort: number;
    webUser: string;
  }>;
  moonlight: Readonly<{
    version: "6.1.0";
    cask: string;
    artifactSha256: string;
    binary: string;
    clientName: string;
    app: string;
  }>;
}>;

export const INSTALLATION_CATALOG = Object.freeze({
  schemaVersion: 1,
  version: "2026.08.24",
  apollo: Object.freeze({
    version: "0.4.6",
    installerUrl:
      "https://github.com/ClassicOldSong/Apollo/releases/download/v0.4.6/Apollo-0.4.6.exe",
    installerSha256:
      "42b2aefaacb3474511517a56b96ee9f0517f30ac38b5dd2fda9fd5b478f5021a",
    installDir: "C:\\Program Files\\Apollo",
    serviceName: "ApolloService",
    apiPort: 47990,
    webUser: "hardline",
  }),
  moonlight: Object.freeze({
    version: "6.1.0",
    cask: "moonlight",
    artifactSha256:
      "d494740eead8ad4e620cdc8feedb56083bc29cabbbeef34cb82585fd87725fa2",
    binary: "/Applications/Moonlight.app/Contents/MacOS/Moonlight",
    clientName: "hardline-mac",
    app: "Desktop",
  }),
}) satisfies InstallationCatalog;

export class UnsupportedInstallationCatalogVersionError extends Error {
  constructor(readonly version: string) {
    super(`Unsupported Installation Catalog version: ${version}`);
    this.name = "UnsupportedInstallationCatalogVersionError";
  }
}

export function getInstallationCatalog(version: string): InstallationCatalog {
  if (version !== INSTALLATION_CATALOG.version) {
    throw new UnsupportedInstallationCatalogVersionError(version);
  }

  return INSTALLATION_CATALOG;
}
