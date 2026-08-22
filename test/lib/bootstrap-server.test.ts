import { test, expect, describe } from "bun:test";
import {
  localBootstrapUrl,
  renderBootstrapScript,
  serveBootstrap,
} from "../../src/lib/bootstrap-server";

const TEMPLATE = `$publicKey = '@@PUBLIC_KEY@@'
$alias = '@@INTERFACE_ALIAS@@'
$target = '@@WINDOWS_IP@@'
$prefix = @@PREFIX_LENGTH@@`;

const VARS = {
  publicKey: "ssh-ed25519 AAAAC3Nz test@mac",
  interfaceAlias: "Ethernet",
  windowsIp: "10.10.10.1",
  prefixLength: 24,
};

describe("renderBootstrapScript", () => {
  test("remplace tous les marqueurs", () => {
    const script = renderBootstrapScript(TEMPLATE, VARS);
    expect(script).not.toContain("@@");
    expect(script).toContain("ssh-ed25519 AAAAC3Nz test@mac");
    expect(script).toContain("10.10.10.1");
    expect(script).toContain("$prefix = 24");
  });

  test("echoue si un marqueur reste non substitue", () => {
    expect(() =>
      renderBootstrapScript("$x = '@@INCONNU@@'", VARS),
    ).toThrow(/INCONNU/);
  });

  test("refuse une cle publique contenant un apostrophe", () => {
    // Le marqueur est place entre apostrophes dans le script PowerShell :
    // une apostrophe dans la valeur casserait la chaine.
    expect(() =>
      renderBootstrapScript(TEMPLATE, { ...VARS, publicKey: "abc'def" }),
    ).toThrow(/apostrophe/);
  });
});

describe("localBootstrapUrl", () => {
  test("compose une adresse mDNS complete", () => {
    expect(localBootstrapUrl(8080)).toMatch(
      /^http:\/\/[^/:]+:8080\/bootstrap\.ps1$/,
    );
  });
});

describe("serveBootstrap", () => {
  test("sert le script rendu puis s'arrete", async () => {
    const server = await serveBootstrap({ port: 0, template: TEMPLATE, ...VARS });
    try {
      const response = await fetch(`${server.url}/bootstrap.ps1`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("10.10.10.1");
    } finally {
      server.stop();
    }
  });

  test("repond 404 sur toute autre route", async () => {
    const server = await serveBootstrap({ port: 0, template: TEMPLATE, ...VARS });
    try {
      const response = await fetch(`${server.url}/autre`);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    } finally {
      server.stop();
    }
  });

  test("le serveur ne repond plus apres arret", async () => {
    const server = await serveBootstrap({ port: 0, template: TEMPLATE, ...VARS });
    const url = server.url;
    server.stop();
    await expect(fetch(`${url}/bootstrap.ps1`)).rejects.toThrow();
  });
});
