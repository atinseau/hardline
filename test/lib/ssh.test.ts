import { test, expect, describe } from "bun:test";
import {
  encodePowerShell,
  withOutputEncoding,
  buildSSHArgs,
  parseRemoteJson,
  type SSHTarget,
} from "../../src/lib/ssh";

const TARGET: SSHTarget = {
  host: "10.10.10.1",
  user: "arthur",
  identityFile: "/Users/arthur/.ssh/id_ed25519_winpc",
};

describe("encodePowerShell", () => {
  test("produit du base64 decodable en UTF-16LE", () => {
    const script = "Write-Output 'test'";
    const encoded = encodePowerShell(script);
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(script);
  });

  test("preserve les accents francais", () => {
    const script = "Write-Output 'réseau privé déjà conforme'";
    const encoded = encodePowerShell(script);
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(script);
  });

  test("preserve les guillemets imbriques sans echappement", () => {
    const script = `Get-NetAdapter -Name "Ethernet" | Select-Object -Property "Status"`;
    expect(Buffer.from(encodePowerShell(script), "base64").toString("utf16le")).toBe(
      script,
    );
  });
});

describe("withOutputEncoding", () => {
  test("prefixe le script pour forcer une sortie UTF-8", () => {
    const wrapped = withOutputEncoding("Write-Output 'réseau privé'");
    expect(wrapped).toContain("OutputEncoding");
    expect(wrapped).toContain("UTF8Encoding");
  });

  test("laisse le script d'origine intact a la fin", () => {
    const script = "Get-NetAdapter | Select-Object Name";
    expect(withOutputEncoding(script).endsWith(script)).toBe(true);
  });
});

describe("buildSSHArgs", () => {
  test("construit un tableau d'arguments, jamais une chaine shell", () => {
    const args = buildSSHArgs(TARGET, "powershell -EncodedCommand AAA=");
    expect(Array.isArray(args)).toBe(true);
    expect(args[0]).toBe("ssh");
    expect(args).toContain("arthur@10.10.10.1");
    expect(args.at(-1)).toBe("powershell -EncodedCommand AAA=");
  });

  test("desactive l'interactivite pour ne jamais bloquer", () => {
    const args = buildSSHArgs(TARGET, "whoami");
    expect(args).toContain("BatchMode=yes");
  });

  test("utilise la cle fournie", () => {
    const args = buildSSHArgs(TARGET, "whoami");
    const i = args.indexOf("-i");
    expect(args[i + 1]).toBe(TARGET.identityFile);
  });

  test("applique le delai de connexion demande", () => {
    const args = buildSSHArgs({ ...TARGET, connectTimeoutSec: 3 }, "whoami");
    expect(args).toContain("ConnectTimeout=3");
  });
});

describe("parseRemoteJson", () => {
  test("chaîne vide renvoie un tableau vide", () => {
    const result = parseRemoteJson("");
    expect(result).toEqual([]);
  });

  test("tableau avec un seul élément renvoie ce tableau", () => {
    const singleJson = '[{"Name":"Ethernet","Status":"Up"}]';
    const result = parseRemoteJson<{ Name: string; Status: string }>(singleJson);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0]?.Name).toBe("Ethernet");
  });

  test("tableau avec plusieurs éléments renvoie le tableau tel quel", () => {
    const arrayJson = '[{"id":1},{"id":2},{"id":3}]';
    const result = parseRemoteJson<{ id: number }>(arrayJson);
    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  test("sortie illisible lève une Error", () => {
    expect(() => {
      parseRemoteJson("ceci n'est pas du JSON valide");
    }).toThrow(Error);
  });
});
