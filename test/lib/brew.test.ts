import { test, expect, describe, mock } from "bun:test";
import { INSTALLATION_CATALOG } from "../../src/installation-catalog";
import {
  caskInfo,
  installCask,
  parseCaskInfo,
  parseCaskOffer,
  uninstallCask,
} from "../../src/lib/brew";

const INSTALLED = JSON.stringify({
  casks: [{ token: "moonlight", installed: "6.1.0" }],
});

const ABSENT = JSON.stringify({
  casks: [{ token: "moonlight", installed: null }],
});

/** Ce que `brew info --json=v2` annonce d'un cask avant installation. */
const offer = (version: string, sha256: string): string =>
  JSON.stringify({ casks: [{ token: "moonlight", version, sha256 }] });

const CATALOGUE = INSTALLATION_CATALOG.moonlight;

describe("parseCaskInfo", () => {
  test("lit un cask installe et sa version", () => {
    expect(parseCaskInfo(INSTALLED, "moonlight")).toEqual({
      installed: true,
      version: "6.1.0",
    });
  });

  test("rend non installe quand la valeur installed est nulle", () => {
    expect(parseCaskInfo(ABSENT, "moonlight")).toEqual({
      installed: false,
      version: null,
    });
  });

  test("rend non installe sur une sortie vide", () => {
    expect(parseCaskInfo("", "moonlight")).toEqual({
      installed: false,
      version: null,
    });
  });

  test("rend non installe sur un JSON illisible plutot que de lever", () => {
    expect(parseCaskInfo("{ceci n'est pas du json", "moonlight")).toEqual({
      installed: false,
      version: null,
    });
  });

  test("ignore les entrees d'un autre cask", () => {
    const other = JSON.stringify({
      casks: [{ token: "autre-app", installed: "1.0" }],
    });
    expect(parseCaskInfo(other, "moonlight")).toEqual({
      installed: false,
      version: null,
    });
  });
});

describe("installCask", () => {
  /** Un brew qui annonce `offered`, puis accepte l'installation. */
  function brewOffering(offered: string) {
    return mock(async (argv: readonly string[]) => ({
      exitCode: 0,
      stdout: argv[1] === "info" ? offered : "",
      stderr: "",
    }));
  }

  test("pose le cask du tap quand il porte exactement ce que le catalogue epingle", async () => {
    const run = brewOffering(offer(CATALOGUE.version, CATALOGUE.artifactSha256));

    await expect(installCask(CATALOGUE, run)).resolves.toMatchObject({ exitCode: 0 });

    expect(run.mock.calls.map(([argv]) => argv)).toEqual([
      ["brew", "info", "--cask", "--json=v2", "moonlight"],
      ["brew", "install", "--cask", "moonlight"],
    ]);
  });

  test("n'installe rien quand le tap propose une autre version", async () => {
    const run = brewOffering(offer("6.2.0", CATALOGUE.artifactSha256));

    await expect(installCask(CATALOGUE, run)).rejects.toThrow(/6\.2\.0/);
    expect(run.mock.calls).toHaveLength(1);
  });

  test("n'installe rien quand l'artefact a ete republie sous la meme version", async () => {
    // Meme numero, autre contenu : c'est precisement ce que l'empreinte est la
    // pour voir, et la version seule ne le verrait pas.
    const run = brewOffering(offer(CATALOGUE.version, "f".repeat(64)));

    await expect(installCask(CATALOGUE, run)).rejects.toThrow(/empreinte/);
    expect(run.mock.calls).toHaveLength(1);
  });

  test("n'installe rien quand brew ne dit rien de lisible", async () => {
    const run = brewOffering("{ceci n'est pas du json");

    await expect(installCask(CATALOGUE, run)).rejects.toThrow(/inconnue/);
    expect(run.mock.calls).toHaveLength(1);
  });
});

describe("parseCaskOffer", () => {
  test("lit la version et l'empreinte proposees", () => {
    expect(parseCaskOffer(offer("6.1.0", "a".repeat(64)), "moonlight")).toEqual({
      version: "6.1.0",
      artifactSha256: "a".repeat(64),
    });
  });

  test("ne rend rien pour un autre cask ou une sortie illisible", () => {
    const rien = { version: null, artifactSha256: null };
    expect(parseCaskOffer(offer("6.1.0", "a".repeat(64)), "autre")).toEqual(rien);
    expect(parseCaskOffer("", "moonlight")).toEqual(rien);
  });
});

test("les autres commandes brew utilisent aussi des argv explicites", async () => {
  const run = mock(async (argv: readonly string[]) => ({
    exitCode: 0,
    stdout: argv[1] === "info" ? INSTALLED : "",
  }));

  await expect(caskInfo("moonlight", run)).resolves.toEqual({
    installed: true,
    version: "6.1.0",
  });
  await expect(uninstallCask("moonlight", run)).resolves.toMatchObject({ exitCode: 0 });

  expect(run.mock.calls.map(([argv]) => argv)).toEqual([
    ["brew", "info", "--cask", "--json=v2", "moonlight"],
    ["brew", "uninstall", "--cask", "moonlight"],
  ]);
});
