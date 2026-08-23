import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  parseHosts,
  containsHost,
  rawHostIndex,
  forgetHostArgs,
  forgetHostAtIndex,
  forgetHostFromJson,
} from "../../src/lib/moonlight-plist";

const WITH_HOST = JSON.stringify({
  hosts: [{ address: "10.10.10.1", name: "PC" }],
});

const EMPTY = JSON.stringify({ hosts: [] });

describe("parseHosts", () => {
  test("lit les hotes connus", () => {
    expect(parseHosts(WITH_HOST)).toEqual([{ address: "10.10.10.1" }]);
  });

  test("rend un tableau vide sans cle hosts", () => {
    expect(parseHosts(JSON.stringify({}))).toEqual([]);
  });

  test("rend un tableau vide sur une sortie vide", () => {
    expect(parseHosts("")).toEqual([]);
  });

  test("rend un tableau vide sur un JSON illisible plutot que de lever", () => {
    expect(parseHosts("pas du json")).toEqual([]);
  });

  test("ignore une entree sans adresse exploitable", () => {
    const withGap = JSON.stringify({ hosts: [{ name: "sans adresse" }] });
    expect(parseHosts(withGap)).toEqual([]);
  });
});

describe("containsHost", () => {
  test("trouve un hote present", () => {
    expect(containsHost([{ address: "10.10.10.1" }], "10.10.10.1")).toBe(true);
  });

  test("rend faux pour un hote absent", () => {
    expect(containsHost(parseHosts(EMPTY), "10.10.10.1")).toBe(false);
  });
});

describe("rawHostIndex", () => {
  test("trouve l'index brut d'une entree, meme apres une entree mal formee", () => {
    // La propriete a proteger : une entree mal formee AVANT la notre ne doit
    // jamais decaler l'index. Si l'implementation calculait cet index sur
    // une liste filtree (comme parseHosts le fait), l'entree mal formee
    // serait retiree avant le calcul et l'index rendu vaudrait 0 au lieu de
    // 1 -- ce qui viserait la mauvaise entree du tableau reel.
    const withGapBefore = JSON.stringify({
      hosts: [{ name: "sans adresse" }, { address: "10.10.10.1" }],
    });
    expect(rawHostIndex(withGapBefore, "10.10.10.1")).toBe(1);
  });

  test("trouve l'index brut quand l'hote est la premiere entree", () => {
    const single = JSON.stringify({ hosts: [{ address: "10.10.10.1" }] });
    expect(rawHostIndex(single, "10.10.10.1")).toBe(0);
  });

  test("rend null si l'hote est absent", () => {
    expect(rawHostIndex(EMPTY, "10.10.10.1")).toBeNull();
  });

  test("rend null sans cle hosts", () => {
    expect(rawHostIndex(JSON.stringify({}), "10.10.10.1")).toBeNull();
  });

  test("rend null sur un JSON illisible plutot que de lever", () => {
    expect(rawHostIndex("pas du json", "10.10.10.1")).toBeNull();
  });

  test("rend null sur une sortie vide", () => {
    expect(rawHostIndex("", "10.10.10.1")).toBeNull();
  });
});

describe("forgetHostArgs", () => {
  test("compose la commande PlistBuddy avec l'index donne", () => {
    const args = forgetHostArgs(2);
    expect(args[0]).toBe("/usr/libexec/PlistBuddy");
    expect(args[1]).toBe("-c");
    expect(args[2]).toBe("Delete :hosts:2");
    expect(args[3]).toMatch(/Library\/Preferences\/com\.moonlight-stream\.Moonlight\.plist$/);
  });

  test("l'index donne se retrouve tel quel dans l'instruction -c", () => {
    expect(forgetHostArgs(0)[2]).toBe("Delete :hosts:0");
    expect(forgetHostArgs(7)[2]).toBe("Delete :hosts:7");
  });
});

describe("forgetHostAtIndex, frontiere systeme", () => {
  type SpawnCall = { cmd: string[] };

  let spawnCalls: SpawnCall[];
  let exitCodes: number[];
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    spawnCalls = [];
    exitCodes = [0, 0];
    originalSpawn = Bun.spawn;
    Bun.spawn = ((cmd: string[]) => {
      const exitCode = exitCodes[spawnCalls.length] ?? 0;
      spawnCalls.push({ cmd });
      return { exited: Promise.resolve(exitCode) };
    }) as unknown as typeof Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  test("emet la commande PlistBuddy avec l'index brut recu, jamais defaults delete", () => {
    void forgetHostAtIndex(3);
    expect(spawnCalls[0]!.cmd).toEqual(forgetHostArgs(3));
  });

  test("tue cfprefsd apres une suppression confirmee", async () => {
    await forgetHostAtIndex(1);
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]!.cmd[0]).toBe("killall");
    expect(spawnCalls[1]!.cmd).toContain("cfprefsd");
  });

  test("rend true quand PlistBuddy confirme par un code de sortie nul", async () => {
    exitCodes = [0, 0];
    await expect(forgetHostAtIndex(0)).resolves.toBe(true);
  });

  test("rend false et ne tue pas cfprefsd quand PlistBuddy echoue", async () => {
    exitCodes = [1];
    await expect(forgetHostAtIndex(0)).resolves.toBe(false);
    expect(spawnCalls).toHaveLength(1);
  });
});

describe("forgetHostFromJson, integration bout en bout", () => {
  // Le point precis que la revue signale : rawHostIndex est juste en
  // isolation, mais rien ne prouvait que forgetHost() -- celle que
  // restore() appelle reellement -- s'en sert correctement. Ces tests
  // passent par forgetHostFromJson, qui EST le corps de forgetHost() prive
  // du seul appel non simulable ($ de Bun) : le chemin exerce ici est
  // exactement celui que restore() emprunte en production.
  type SpawnCall = { cmd: string[] };

  let spawnCalls: SpawnCall[];
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    spawnCalls = [];
    originalSpawn = Bun.spawn;
    Bun.spawn = ((cmd: string[]) => {
      spawnCalls.push({ cmd });
      return { exited: Promise.resolve(0) };
    }) as unknown as typeof Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  test("vise l'index brut du JSON quand une entree mal formee precede l'hote", async () => {
    // Les deux index DOIVENT differer : filtre, notre hote serait le
    // premier element (index 0) puisque parseHosts retire l'entree cassee ;
    // brut, il est le second (index 1). Le contraste est le test.
    const withGapBefore = JSON.stringify({
      hosts: [{ name: "sans adresse" }, { address: "10.10.10.1" }],
    });
    const filteredIndex = parseHosts(withGapBefore).findIndex(
      (h) => h.address === "10.10.10.1",
    );
    const rawIndex = rawHostIndex(withGapBefore, "10.10.10.1");
    expect(rawIndex).not.toBe(filteredIndex);
    expect(rawIndex).toBe(1);
    expect(filteredIndex).toBe(0);

    await forgetHostFromJson(withGapBefore, "10.10.10.1");

    expect(spawnCalls[0]!.cmd).toEqual(forgetHostArgs(1));
    expect(spawnCalls[0]!.cmd).not.toEqual(forgetHostArgs(0));
  });

  test("n'emet aucune commande de suppression quand l'hote est absent du plist", async () => {
    const withoutOurHost = JSON.stringify({ hosts: [{ address: "10.10.10.99" }] });

    const forgotten = await forgetHostFromJson(withoutOurHost, "10.10.10.1");

    expect(spawnCalls).toHaveLength(0);
    expect(forgotten).toBe(true);
  });
});
