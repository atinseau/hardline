import { test, expect, describe } from "bun:test";
import { parseCaskInfo } from "../../src/lib/brew";

const INSTALLED = JSON.stringify({
  casks: [{ token: "moonlight", installed: "6.1.0" }],
});

const ABSENT = JSON.stringify({
  casks: [{ token: "moonlight", installed: null }],
});

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
