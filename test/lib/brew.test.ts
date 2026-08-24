import { test, expect, describe, mock } from "bun:test";
import { INSTALLATION_CATALOG } from "../../src/installation-catalog";
import {
  caskInfo,
  installCask,
  parseCaskInfo,
  uninstallCask,
} from "../../src/lib/brew";

const INSTALLED = JSON.stringify({
  casks: [{ token: "moonlight", installed: "6.1.0" }],
});

const ABSENT = JSON.stringify({
  casks: [{ token: "moonlight", installed: null }],
});

const RECIPE = `cask "moonlight" do
  version "6.1.0"
  sha256 "d494740eead8ad4e620cdc8feedb56083bc29cabbbeef34cb82585fd87725fa2"

  url "https://github.com/moonlight-stream/moonlight-qt/releases/download/v#{version}/Moonlight-#{version}.dmg",
      verified: "github.com/moonlight-stream/moonlight-qt/"
  name "Moonlight"
  desc "GameStream client"
  homepage "https://moonlight-stream.org/"

  depends_on macos: ">= :mojave"

  app "Moonlight.app"

  zap trash: [
    "~/Library/Caches/Moonlight Game Streaming Project",
    "~/Library/Preferences/com.moonlight-stream.Moonlight.plist",
    "~/Library/Saved Application State/com.moonlight-stream.Moonlight.savedState",
  ]
end
`;

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
  function dependencies(contents = RECIPE) {
    const files = new Map<string, Uint8Array>();
    const run = mock(async (argv: readonly string[]) => {
      const recipePath = argv.at(-1)!;
      expect(new TextDecoder().decode(files.get(recipePath))).toBe(contents);
      return { exitCode: 0, stdout: "" };
    });
    const rm = mock(async (..._args: unknown[]) => {});

    return {
      files,
      run,
      rm,
      io: {
        fetch: async () => new Response(contents),
        mkdtemp: async () => "/tmp/hardline-moonlight-test",
        writeFile: async (path: string, data: Uint8Array) => {
          files.set(path, data);
        },
        rm,
        run,
      },
    };
  }

  test("installe la recette locale authentifiee avec un argv explicite puis la nettoie", async () => {
    const { io, run, rm } = dependencies();

    await expect(installCask(INSTALLATION_CATALOG.moonlight, io)).resolves.toBe(0);

    expect(run).toHaveBeenCalledWith([
      "brew",
      "install",
      "--cask",
      "/tmp/hardline-moonlight-test/moonlight.rb",
    ]);
    expect(rm).toHaveBeenCalledWith("/tmp/hardline-moonlight-test", {
      recursive: true,
      force: true,
    });
  });

  test("refuse une empreinte de recette incorrecte sans invoquer brew et nettoie", async () => {
    const { io, run, rm } = dependencies(`${RECIPE}# altered\n`);

    await expect(installCask(INSTALLATION_CATALOG.moonlight, io)).rejects.toThrow(
      /empreinte de la recette Moonlight/,
    );

    expect(run).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith("/tmp/hardline-moonlight-test", {
      recursive: true,
      force: true,
    });
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
  await expect(uninstallCask("moonlight", run)).resolves.toBe(0);

  expect(run.mock.calls.map(([argv]) => argv)).toEqual([
    ["brew", "info", "--cask", "--json=v2", "moonlight"],
    ["brew", "uninstall", "--cask", "moonlight"],
  ]);
});
