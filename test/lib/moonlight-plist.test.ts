import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  parseHosts,
  containsHost,
  hostKeys,
  hostIndex,
  forgetHostCommands,
  forgetHostArgs,
  forgetHostAtIndex,
  forgetHostFromExport,
} from "../../src/lib/moonlight-plist";

/**
 * Un export du domaine tel que `defaults export` le rend vraiment : des cles
 * PLATES, et une donnee binaire que la conversion JSON refusait de traduire.
 */
const EXPORT = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>bitrate</key>
	<integer>10000</integer>
	<key>certificate</key>
	<data>
	LS0tLS1CRUdJTiBDRVJU
	</data>
	<key>hosts.1.hostname</key>
	<string>DESKTOP-4FKFG3L</string>
	<key>hosts.1.localaddress</key>
	<string>10.10.10.1</string>
	<key>hosts.1.manualaddress</key>
	<string>10.10.10.1</string>
	<key>hosts.1.srvcert</key>
	<data>
	LS0tLS1CRUdJTiBDRVJU
	</data>
	<key>hosts.2.hostname</key>
	<string>DESKTOP-4FKFG3L</string>
	<key>hosts.2.localaddress</key>
	<string>192.168.1.48</string>
	<key>hosts.2.manualaddress</key>
	<string>192.168.1.48</string>
	<key>hosts.3.hostname</key>
	<string>AUTRE-PC</string>
	<key>hosts.3.localaddress</key>
	<string>192.168.1.70</string>
	<key>hosts.size</key>
	<integer>3</integer>
</dict>
</plist>`;

describe("parseHosts", () => {
  test("lit les cles plates que Qt ecrit, pas un tableau", () => {
    expect(parseHosts(EXPORT)).toEqual([
      { address: "10.10.10.1" },
      { address: "192.168.1.48" },
      { address: "192.168.1.70" },
    ]);
  });

  test("un export vide ou sans hote ne leve pas", () => {
    expect(parseHosts("")).toEqual([]);
    expect(parseHosts("<plist><dict><key>bitrate</key><integer>1</integer></dict></plist>")).toEqual([]);
  });

  test("hostKeys ignore tout ce qui n'est pas une entree d'hote", () => {
    const champs = hostKeys(EXPORT).map((k) => k.key);
    expect(champs).toContain("hosts.2.localaddress");
    expect(champs).not.toContain("bitrate");
    // `hosts.size` porte la taille, pas un hote : un index en ferait un.
    expect(champs).not.toContain("hosts.size");
  });
});

describe("containsHost", () => {
  test("reconnait une adresse connue et rejette les autres", () => {
    const hosts = parseHosts(EXPORT);
    expect(containsHost(hosts, "192.168.1.48")).toBe(true);
    expect(containsHost(hosts, "192.168.1.99")).toBe(false);
  });
});

describe("hostIndex", () => {
  test("rend l'index Qt de l'entree, pas sa position dans une liste filtree", () => {
    expect(hostIndex(EXPORT, "192.168.1.48")).toBe(2);
    expect(hostIndex(EXPORT, "10.10.10.1")).toBe(1);
  });

  test("rend null pour un hote absent ou un export vide", () => {
    expect(hostIndex(EXPORT, "192.168.1.99")).toBeNull();
    expect(hostIndex("", "10.10.10.1")).toBeNull();
  });
});

describe("forgetHostCommands", () => {
  test("supprime l'entree visee, y compris ses donnees binaires", () => {
    const commands = forgetHostCommands(EXPORT, 1);
    expect(commands).toContain("Delete :hosts.1.hostname");
    expect(commands).toContain("Delete :hosts.1.srvcert");
  });

  test("renumerote ce qui suit, sans quoi Qt cesserait de voir la fin", () => {
    // Qt lit de 1 a hosts.size : un trou au milieu cache tout ce qui suit.
    const commands = forgetHostCommands(EXPORT, 1);
    expect(commands).toContain("Rename :hosts.2.localaddress :hosts.1.localaddress");
    expect(commands).toContain("Rename :hosts.3.localaddress :hosts.2.localaddress");
    expect(commands.at(-1)).toBe("Set :hosts.size 2");
  });

  test("retirer la derniere entree ne renomme rien", () => {
    const commands = forgetHostCommands(EXPORT, 3);
    expect(commands.filter((c) => c.startsWith("Rename"))).toHaveLength(0);
    expect(commands.at(-1)).toBe("Set :hosts.size 2");
  });
});

describe("forgetHostArgs", () => {
  test("passe une instruction -c par commande, et finit par le plist", () => {
    const args = forgetHostArgs(["Delete :hosts.1.hostname", "Set :hosts.size 0"]);
    expect(args[0]).toBe("/usr/libexec/PlistBuddy");
    expect(args.slice(1, 5)).toEqual([
      "-c",
      "Delete :hosts.1.hostname",
      "-c",
      "Set :hosts.size 0",
    ]);
    expect(args.at(-1)).toMatch(/Library\/Preferences\/com\.moonlight-stream\.Moonlight\.plist$/);
  });
});

describe("frontiere systeme", () => {
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

  test("emet exactement les commandes calculees sur l'export recu", async () => {
    await forgetHostAtIndex(EXPORT, 2);
    expect(spawnCalls[0]!.cmd).toEqual(forgetHostArgs(forgetHostCommands(EXPORT, 2)));
  });

  test("tue cfprefsd apres une suppression confirmee", async () => {
    await forgetHostAtIndex(EXPORT, 1);
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]!.cmd[0]).toBe("killall");
    expect(spawnCalls[1]!.cmd).toContain("cfprefsd");
  });

  test("un echec de PlistBuddy n'est jamais pris pour un succes", async () => {
    exitCodes = [1];
    expect(await forgetHostAtIndex(EXPORT, 1)).toBe(false);
    expect(spawnCalls).toHaveLength(1);
  });

  test("un hote absent rend true sans rien lancer", async () => {
    expect(await forgetHostFromExport(EXPORT, "192.168.1.99")).toBe(true);
    expect(spawnCalls).toHaveLength(0);
  });

  test("un hote present est retire par son index Qt", async () => {
    expect(await forgetHostFromExport(EXPORT, "192.168.1.48")).toBe(true);
    expect(spawnCalls[0]!.cmd).toContain("Delete :hosts.2.localaddress");
  });
});
