import { test, expect, describe } from "bun:test";
import { encodePowerShell, buildSSHArgs, type SSHTarget } from "../../src/lib/ssh";

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
