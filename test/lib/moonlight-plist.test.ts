import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  parseHosts,
  containsHost,
  hostKeys,
  hostIndex,
  rewriteWithoutHost,
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

describe("rewriteWithoutHost", () => {
  test("l'entrée visée disparaît, valeur binaire comprise", () => {
    const reecrit = rewriteWithoutHost(EXPORT, 1);
    expect(reecrit).not.toContain("10.10.10.1");
    // Le <data> de l'entrée retirée part avec elle, sans laisser sa valeur
    // orpheline : un plist à moitié réécrit ne se relit plus.
    expect(parseHosts(reecrit)).toEqual([
      { address: "192.168.1.48" },
      { address: "192.168.1.70" },
    ]);
  });

  test("ce qui suit descend d'un cran, sans quoi Qt cesserait de voir la fin", () => {
    // Qt lit de 1 a hosts.size : un trou au milieu cache tout ce qui suit.
    const reecrit = rewriteWithoutHost(EXPORT, 1);
    expect(reecrit).toContain("<key>hosts.1.localaddress</key>");
    expect(reecrit).toContain("<key>hosts.2.localaddress</key>");
    expect(reecrit).not.toContain("<key>hosts.3.localaddress</key>");
    expect(reecrit).toContain("<key>hosts.size</key>\n\t<integer>2</integer>");
  });

  test("ce qui n'est pas un hôte n'est pas touché", () => {
    const reecrit = rewriteWithoutHost(EXPORT, 2);
    expect(reecrit).toContain("<key>bitrate</key>");
    expect(reecrit).toContain("<integer>10000</integer>");
    expect(reecrit).toContain("<key>certificate</key>");
    expect(reecrit).toContain("LS0tLS1CRUdJTiBDRVJU");
  });

  test("retirer la dernière entrée ne déplace rien", () => {
    const reecrit = rewriteWithoutHost(EXPORT, 3);
    expect(parseHosts(reecrit)).toEqual([
      { address: "10.10.10.1" },
      { address: "192.168.1.48" },
    ]);
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

  test("réimporte par defaults, jamais en écrivant le plist dans le dos de cfprefsd", async () => {
    await forgetHostAtIndex(EXPORT, 2);
    expect(spawnCalls[0]!.cmd.slice(0, 3)).toEqual([
      "defaults",
      "import",
      "com.moonlight-stream.Moonlight",
    ]);
  });

  test("retire le dernier rang, que l'import fusionnant laisse en place", async () => {
    // `defaults import` fusionne : il pose les entrées descendues d'un cran,
    // mais laisse le rang devenu excédentaire. Sans ces suppressions, Moonlight
    // garde une entrée de trop et hosts.size ment.
    await forgetHostAtIndex(EXPORT, 1);
    const suppressions = spawnCalls.slice(1).map((c) => c.cmd[3]);
    expect(suppressions).toContain("hosts.3.localaddress");
    expect(suppressions).not.toContain("hosts.2.localaddress");
    expect(spawnCalls.every((c) => c.cmd[0] === "defaults")).toBe(true);
  });

  test("ne tue JAMAIS cfprefsd", async () => {
    // Tout passe désormais par cfprefsd. Le tuer lui ferait recharger un
    // fichier périmé et annulerait le travail — constaté sur la machine.
    await forgetHostAtIndex(EXPORT, 1);
    expect(spawnCalls.flatMap((c) => c.cmd)).not.toContain("cfprefsd");
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
    expect(spawnCalls[0]!.cmd[1]).toBe("import");
  });
});
