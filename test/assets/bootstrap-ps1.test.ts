import { describe, expect, test } from "bun:test";

const SCRIPT = await Bun.file(
  new URL("../../src/assets/bootstrap.ps1", import.meta.url),
).text();

const PHASE_ONE = "Invoke-HardlinePost '/phase-one'";
const RECOVERY_WRITE = "Move-Item -Path $recoveryTemp -Destination $statePath -Force";
const MUTATIONS = [
  "Add-WindowsCapability",
  "Set-Service -Name sshd -StartupType Automatic",
  "Start-Service -Name sshd",
  "New-NetFirewallRule",
  "Add-Content -Path $keyFile",
  "icacls $keyFile",
  "New-NetIPAddress",
  "Set-NetConnectionProfile",
];

describe("Bootstrap Rendezvous phase one", () => {
  test("collects machine, administrator, physical network and OpenSSH observations", () => {
    expect(SCRIPT).toContain("Get-CimInstance -ClassName Win32_ComputerSystemProduct");
    expect(SCRIPT).toContain("WindowsIdentity]::GetCurrent().Name");
    expect(SCRIPT).toContain("Get-NetAdapter -Physical");
    expect(SCRIPT).toContain("Get-NetRoute -AddressFamily IPv4");
    expect(SCRIPT).toContain("Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop");
    expect(SCRIPT).toContain("activeIpv4Addresses = $activeIpv4Addresses");
    expect(SCRIPT).not.toContain("Test-Connection");
    expect(SCRIPT).toContain("Get-WindowsCapability -Online -Name 'OpenSSH.Server*'");
    expect(SCRIPT.indexOf("$currentHostKey =")).toBeLessThan(
      SCRIPT.indexOf(PHASE_ONE),
    );
    expect(SCRIPT).toContain("hostKey = $currentHostKey");
  });

  test("posts observations and receives authorization before every mutation", () => {
    const authorization = SCRIPT.indexOf(PHASE_ONE);
    expect(authorization).toBeGreaterThan(0);
    for (const statement of MUTATIONS) {
      expect(SCRIPT.indexOf(statement)).toBeGreaterThan(authorization);
    }
  });

  test("offers only physical adapters and rejects a plan outside that observation", () => {
    expect(SCRIPT).toContain("Get-NetAdapter -Physical");
    expect(SCRIPT).toContain(
      "$physicalAdapters | Where-Object { $_.Name -ceq $authorizedAlias }",
    );
    expect(SCRIPT).toContain(
      "The authorized interface is not an observed physical adapter.",
    );
  });
});

describe("immutable recovery checkpoint", () => {
  test("is published atomically after authorization and before every mutation", () => {
    const authorization = SCRIPT.indexOf(PHASE_ONE);
    const written = SCRIPT.indexOf(RECOVERY_WRITE);
    expect(written).toBeGreaterThan(authorization);
    expect(SCRIPT.indexOf("Set-Content -Path $recoveryTemp")).toBeLessThan(written);
    for (const statement of MUTATIONS) {
      expect(SCRIPT.indexOf(statement)).toBeGreaterThan(written);
    }
  });

  test("is never overwritten and a retry matches the stable adapter identity", () => {
    expect(SCRIPT).toContain("if (Test-Path $statePath) {");
    expect(SCRIPT).toContain("$recorded.machineId -cne $observations.machineId");
    expect(SCRIPT).toContain("$recorded.hardwareId -ne $hardwareId");
    expect(SCRIPT).not.toContain("$recorded.interfaceAlias -cne $alias");
    expect(SCRIPT).toContain("$recorded.address -cne $target");
    expect(SCRIPT.split(RECOVERY_WRITE)).toHaveLength(2);
    expect(SCRIPT).toContain("[System.IO.FileAttributes]::ReadOnly");
  });

  test("accepts a renamed alias for the same GUID and uses the current observed alias", () => {
    expect(SCRIPT).toContain("$hardwareId = [string]$adapter.InterfaceGuid");
    expect(SCRIPT).toContain("hardwareId = $hardwareId");
    expect(SCRIPT).toContain("$alias = [string]$adapter.Name");
    expect(SCRIPT.indexOf("$alias = [string]$adapter.Name")).toBeLessThan(
      SCRIPT.indexOf("if (Test-Path $statePath)"),
    );
  });

  test("records all bootstrap-owned state before changing it", () => {
    for (const field of [
      "capability =",
      "sshd =",
      "firewall =",
      "authorizedKeys =",
      "network =",
    ]) {
      expect(SCRIPT).toContain(field);
    }
  });
});

describe("authorized mutation and SSH trust", () => {
  test("takes interface, address, prefix and identity only from the authorized plan", () => {
    expect(SCRIPT).toContain(
      "$authorizedAlias = [string]$plan.directLink.interfaceAlias",
    );
    expect(SCRIPT).toContain("$target = [string]$plan.directLink.address");
    expect(SCRIPT).toContain("$prefix = [int]$plan.directLink.prefixLength");
    expect(SCRIPT).toContain("$publicKey = [string]$plan.ssh.administratorPublicKey");
    expect(SCRIPT).not.toMatch(/@@[A-Z_]+@@/);
  });

  test("writes the administrator key safely using language-independent SIDs", () => {
    expect(SCRIPT).toContain(
      "Add-Content -Path $keyFile -Value $publicKey -Encoding ascii",
    );
    const icacls = SCRIPT.split("\n").find((line) => line.startsWith("icacls "));
    expect(icacls).toContain("*S-1-5-32-544");
    expect(SCRIPT).toContain("*S-1-5-18");
  });

  test("returns the generated host key through phase two before declaring completion", () => {
    const keyRead = SCRIPT.indexOf("ssh_host_ed25519_key.pub");
    const completion = SCRIPT.indexOf("Invoke-HardlinePost '/phase-two'");
    const success = SCRIPT.indexOf("Bootstrap complete. Return to the Mac.");
    expect(keyRead).toBeGreaterThan(0);
    expect(completion).toBeGreaterThan(keyRead);
    expect(success).toBeGreaterThan(completion);
  });
});

test("the autonomous payload remains ASCII and sets strict error handling", () => {
  expect([...SCRIPT].filter((character) => character.charCodeAt(0) > 127)).toEqual([]);
  expect(SCRIPT).toContain("$ErrorActionPreference = 'Stop'");
});
