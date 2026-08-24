import { expect, test } from "bun:test";
import {
  getInstallationCatalog,
  INSTALLATION_CATALOG,
  UnsupportedInstallationCatalogVersionError,
} from "../src/installation-catalog";

test("the fixed Installation Catalog preserves the compiled product facts", () => {
  expect(INSTALLATION_CATALOG).toEqual({
    schemaVersion: 1,
    version: "2026.08.24",
    apollo: {
      version: "0.4.6",
      installerUrl:
        "https://github.com/ClassicOldSong/Apollo/releases/download/v0.4.6/Apollo-0.4.6.exe",
      installerSha256:
        "42b2aefaacb3474511517a56b96ee9f0517f30ac38b5dd2fda9fd5b478f5021a",
      installDir: "C:\\Program Files\\Apollo",
      serviceName: "ApolloService",
      apiPort: 47990,
      webUser: "hardline",
    },
    moonlight: {
      version: "6.1.0",
      cask: "moonlight",
      recipeUrl:
        "https://raw.githubusercontent.com/Homebrew/homebrew-cask/b3aa32a45349e4e62e4ba3a33a98d380d50e9152/Casks/m/moonlight.rb",
      recipeSha256:
        "453205f2822696919c2aa553e556b20312a0f1adb65c11b7fabf138d0b696479",
      artifactSha256:
        "d494740eead8ad4e620cdc8feedb56083bc29cabbbeef34cb82585fd87725fa2",
      binary: "/Applications/Moonlight.app/Contents/MacOS/Moonlight",
      clientName: "hardline-mac",
      app: "Desktop",
    },
  });
});

test("the Installation Catalog is immutable by construction", () => {
  expect(Object.isFrozen(INSTALLATION_CATALOG)).toBe(true);
  expect(Object.isFrozen(INSTALLATION_CATALOG.apollo)).toBe(true);
  expect(Object.isFrozen(INSTALLATION_CATALOG.moonlight)).toBe(true);
});

test("catalog lookup returns the fixed supported version", () => {
  expect(getInstallationCatalog("2026.08.24")).toBe(INSTALLATION_CATALOG);
});

test("catalog lookup rejects unsupported versions with a typed error", () => {
  const lookup = () => getInstallationCatalog("2026.08.25");

  expect(lookup).toThrow(UnsupportedInstallationCatalogVersionError);
  expect(lookup).toThrow("Unsupported Installation Catalog version: 2026.08.25");
});
