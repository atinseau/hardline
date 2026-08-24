import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import type { Config, SMBShare } from "../../src/config";

let mkdirCalls: string[];
const realFs = await import("node:fs/promises");

mock.module("node:fs/promises", () => ({
  ...realFs,
  mkdir: async (path: string) => {
    mkdirCalls.push(path);
  },
}));

const { smbUrl, mountShare, unmountShare, isMounted } = await import("../../src/lib/smb");

const CONFIG: Config = {
  mac: { serviceName: "AX88179A", ip: "10.10.10.2", subnetMask: "255.255.255.0" },
  windows: { interfaceAlias: "Ethernet", ip: "10.10.10.1", prefixLength: 24 },
  ssh: { host: "10.10.10.1", user: "arthur", identityFile: "/dev/null", connectTimeoutSec: 8 },
  bootstrapPort: 8080,
  apollo: {
    version: "0.4.6",
    installerUrl: "https://example.invalid/Apollo-0.4.6.exe",
    installerSha256: "42b2aefaacb3474511517a56b96ee9f0517f30ac38b5dd2fda9fd5b478f5021a",
    installDir: "C:\\Program Files\\Apollo",
    serviceName: "ApolloService",
    apiPort: 47990,
    webUser: "hardline",
  },
  moonlight: {
    cask: "moonlight",
    binary: "/opt/homebrew/bin/moonlight",
    clientName: "hardline-mac",
    app: "Desktop",
  },
  smb: {
    user: "arthur",
    shares: [
      { name: "arthur", path: null, mountPoint: "/Volumes/pc-arthur" },
      { name: "hardline-d", path: "D:\\", mountPoint: "/Volumes/pc-d" },
      { name: "hardline-e", path: "E:\\", mountPoint: "/Volumes/pc-e" },
    ],
  },
};

const SHARE_D: SMBShare = { name: "hardline-d", path: "D:\\", mountPoint: "/Volumes/pc-d" };

type SpawnCall = { cmd: string[] };

let spawnCalls: SpawnCall[];
let mountSmbfsExit: number;
let mountSmbfsStderr: string;
let mountOutput: string;
let lsExit: number;
let originalSpawn: typeof Bun.spawn;

beforeEach(() => {
  mkdirCalls = [];
  spawnCalls = [];
  mountSmbfsExit = 0;
  mountSmbfsStderr = "";
  mountOutput = "";
  lsExit = 0;
  originalSpawn = Bun.spawn;
  Bun.spawn = ((cmd: string[]) => {
    spawnCalls.push({ cmd });
    if (cmd[0] === "mount_smbfs") {
      return {
        stdout: "",
        stderr: mountSmbfsStderr,
        exited: Promise.resolve(mountSmbfsExit),
      };
    }
    if (cmd[0] === "mount") {
      return {
        stdout: mountOutput,
        stderr: "",
        exited: Promise.resolve(0),
      };
    }
    if (cmd[0] === "/bin/ls") {
      return { stdout: "", stderr: "", exited: Promise.resolve(lsExit) };
    }
    return { stdout: "", stderr: "", exited: Promise.resolve(0) };
  }) as unknown as typeof Bun.spawn;
});

afterEach(() => {
  Bun.spawn = originalSpawn;
});

describe("smbUrl", () => {
  test("chiffre le mot de passe pour une URL, jamais pour un shell", () => {
    const password = "p@ss w0rd!#";
    const url = smbUrl("10.10.10.1", "arthur", password, "hardline-d");
    expect(url).toBe(`smb://arthur:${encodeURIComponent(password)}@10.10.10.1/hardline-d`);
  });
});

describe("mountShare", () => {
  test("cree le point de montage au besoin puis appelle mount_smbfs avec l'URL chiffree", async () => {
    await mountShare(SHARE_D, CONFIG, "s3cret!");

    expect(mkdirCalls).toEqual(["/Volumes/pc-d"]);

    const call = spawnCalls.find((c) => c.cmd[0] === "mount_smbfs");
    expect(call?.cmd[1]).toBe(smbUrl(CONFIG.ssh.host, CONFIG.smb.user, "s3cret!", SHARE_D.name));
    expect(call?.cmd[2]).toBe(SHARE_D.mountPoint);
  });

  test("ne laisse jamais fuir la forme brute du mot de passe", async () => {
    const password = "S3cret Pass@Word/2026";
    const anchor = "authentification refusee pour le compte arthur";
    mountSmbfsExit = 68;
    mountSmbfsStderr = `mount_smbfs: ${anchor} avec le mot de passe ${password}`;

    let caught: Error | null = null;
    try {
      await mountShare(SHARE_D, CONFIG, password);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught?.message).not.toContain(password);
    expect(caught?.message).not.toContain(encodeURIComponent(password));
    expect(caught?.message).not.toContain(anchor);
  });

  test("ne laisse jamais fuir la forme encodee du mot de passe", async () => {
    const password = "S3cret Pass@Word/2026";
    const anchor = "url rejetee par le serveur";
    mountSmbfsExit = 68;
    mountSmbfsStderr =
      `mount_smbfs: ${anchor} url=smb://arthur:${encodeURIComponent(password)}@10.10.10.1/hardline-d`;

    let caught: Error | null = null;
    try {
      await mountShare(SHARE_D, CONFIG, password);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught?.message).not.toContain(password);
    expect(caught?.message).not.toContain(encodeURIComponent(password));
    expect(caught?.message).not.toContain(anchor);
  });

  test("ne remonte pas un partage deja monte", async () => {
    // Sans cette garde, un montage laisse par un up interrompu s'empile au
    // lancement suivant : macOS suffixe le point de montage plutot que de
    // refuser, et l'utilisateur se retrouve avec pc-d, pc-d-1, pc-d-2.
    mountOutput = `//arthur@10.10.10.1/hardline-d on ${SHARE_D.mountPoint} (smbfs, nodev, nosuid, mounted by arthur)`;

    await mountShare(SHARE_D, CONFIG, "s3cret!");

    expect(spawnCalls.some((c) => c.cmd[0] === "mount_smbfs")).toBe(false);
    expect(mkdirCalls).toEqual([]);
  });

  test("recycle un montage existant qui ne repond plus", async () => {
    mountOutput = `//arthur@10.10.10.1/hardline-d on ${SHARE_D.mountPoint} (smbfs, nodev, nosuid, mounted by arthur)`;
    lsExit = 137;

    await mountShare(SHARE_D, CONFIG, "s3cret!");

    expect(spawnCalls.map((call) => call.cmd[0])).toEqual([
      "mount",
      "/bin/ls",
      "umount",
      "mount_smbfs",
    ]);
    expect(spawnCalls[2]!.cmd).toEqual(["umount", "-f", SHARE_D.mountPoint]);
  });
});

describe("unmountShare", () => {
  test("ne leve pas quand rien n'etait monte", async () => {
    mountOutput = "map -hosts on /net (autofs, nosuid, automounted)";

    await expect(unmountShare(SHARE_D)).resolves.toBeUndefined();
    expect(spawnCalls.some((c) => c.cmd[0] === "umount")).toBe(false);
  });

  test("demonte quand le partage est effectivement monte", async () => {
    mountOutput = `//arthur@10.10.10.1/hardline-d on ${SHARE_D.mountPoint} (smbfs, nodev, nosuid, mounted by arthur)`;

    await unmountShare(SHARE_D);

    expect(
      spawnCalls.some((c) => c.cmd[0] === "umount" && c.cmd[1] === SHARE_D.mountPoint),
    ).toBe(true);
  });
});

describe("isMounted", () => {
  test("lit la sortie de mount pour reconnaitre le volume", async () => {
    mountOutput = `//arthur@10.10.10.1/hardline-d on ${SHARE_D.mountPoint} (smbfs, nodev, nosuid, mounted by arthur)`;
    expect(await isMounted(SHARE_D)).toBe(true);
  });

  test("rend false quand le point de montage est absent de la sortie", async () => {
    mountOutput = "map -hosts on /net (autofs, nosuid, automounted)";
    expect(await isMounted(SHARE_D)).toBe(false);
  });
});
