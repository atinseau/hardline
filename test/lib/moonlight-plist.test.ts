import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  parseHosts,
  containsHost,
  rawHostIndex,
  forgetHostArgs,
  forgetHostAtIndex,
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
