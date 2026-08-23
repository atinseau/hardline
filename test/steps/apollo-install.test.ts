import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";

let jsonQueue: unknown[][] = [];
const runRemoteJson = mock(async () => {
  const next = jsonQueue.shift();
  if (!next) throw new Error("file d'attente JSON vide dans le test");
  return next;
});
const runRemoteChecked = mock(async (..._args: unknown[]) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../../src/lib/ssh", () => ({
  runRemoteJson,
  runRemoteChecked,
}));

const { apolloInstallStep, ForeignApolloError, MARKER_FILE } = await import(
  "../../src/steps/apollo-install"
);

beforeEach(() => {
  jsonQueue = [];
  runRemoteJson.mockClear();
  runRemoteChecked.mockClear();
});

function checkedScript(call: number): string {
  return String((runRemoteChecked.mock.calls[call] as unknown[])[1]);
}

describe("inspect", () => {
  test("absent", async () => {
    jsonQueue.push([
      { installed: false, version: null, ours: false, pairedClients: 0, hasConfig: false },
    ]);
    const state = await apolloInstallStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current.installed).toBe(false);
    expect(state.detail).toContain("absent");
  });

  test("etranger", async () => {
    jsonQueue.push([
      { installed: true, version: "0.4.6", ours: false, pairedClients: 3, hasConfig: true },
    ]);
    const state = await apolloInstallStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current.ours).toBe(false);
    expect(state.current.pairedClients).toBe(3);
    expect(state.detail).toContain("étranger");
    expect(state.detail).toContain("3 client");
  });

  test("nous, version conforme", async () => {
    jsonQueue.push([
      { installed: true, version: "0.4.6", ours: true, pairedClients: 1, hasConfig: true },
    ]);
    const state = await apolloInstallStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
  });

  test("nous, mauvaise version", async () => {
    jsonQueue.push([
      { installed: true, version: "0.4.5", ours: true, pairedClients: 1, hasConfig: true },
    ]);
    const state = await apolloInstallStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
  });

  test("echoue explicitement si le PC ne repond rien", async () => {
    jsonQueue.push([]);
    expect(apolloInstallStep.inspect(CONFIG)).rejects.toThrow();
  });
});

describe("apply - installation neuve", () => {
  test("telecharge, verifie l'empreinte avant execution, installe, depose le marqueur", async () => {
    jsonQueue.push([
      { installed: false, version: null, ours: false, pairedClients: 0, hasConfig: false },
    ]);
    await apolloInstallStep.apply(CONFIG);
    expect(runRemoteChecked).toHaveBeenCalledTimes(1);
    const script = checkedScript(0);

    const download = script.indexOf("Invoke-WebRequest");
    const hashCheck = script.indexOf("Get-FileHash");
    const compare = script.indexOf("if ($actual -ne");
    const install = script.indexOf("& $tempPath");
    const marker = script.indexOf(MARKER_FILE);

    expect(download).toBeGreaterThanOrEqual(0);
    expect(hashCheck).toBeGreaterThan(download);
    expect(compare).toBeGreaterThan(hashCheck);
    expect(install).toBeGreaterThan(compare);
    expect(marker).toBeGreaterThan(install);
    expect(script).toContain(CONFIG.apollo.installerUrl);
    expect(script).toContain(CONFIG.apollo.installerSha256);
    expect(script).toContain("'/S'");
    expect(script).toContain(`/D=${CONFIG.apollo.installDir}`);
  });
});

describe("apply - installation etrangere", () => {
  test("leve ForeignApolloError sans rien executer", async () => {
    jsonQueue.push([
      { installed: true, version: "0.4.6", ours: false, pairedClients: 2, hasConfig: true },
    ]);
    await expect(apolloInstallStep.apply(CONFIG)).rejects.toThrow(ForeignApolloError);
    expect(runRemoteChecked).not.toHaveBeenCalled();
  });

  test("l'erreur porte l'etat constate", async () => {
    jsonQueue.push([
      { installed: true, version: "0.4.6", ours: false, pairedClients: 5, hasConfig: true },
    ]);
    try {
      await apolloInstallStep.apply(CONFIG);
      throw new Error("aurait du lever");
    } catch (error) {
      expect(error).toBeInstanceOf(ForeignApolloError);
      const foreign = error as InstanceType<typeof ForeignApolloError>;
      expect(foreign.state.version).toBe("0.4.6");
      expect(foreign.state.pairedClients).toBe(5);
      expect(foreign.hasConfig).toBe(true);
      expect(foreign.message).toContain("5 client");
    }
  });
});

describe("apply - remplacement d'une installation posee par hardline", () => {
  test("sauvegarde puis desinstalle puis reinstalle, dans cet ordre", async () => {
    jsonQueue.push([
      { installed: true, version: "0.4.5", ours: true, pairedClients: 1, hasConfig: true },
    ]);
    jsonQueue.push([
      { backupPath: "C:\\ProgramData\\hardline\\apollo-backup-20260101-000000.conf" },
    ]);

    await apolloInstallStep.apply(CONFIG);

    expect(runRemoteJson).toHaveBeenCalledTimes(2);
    expect(runRemoteChecked).toHaveBeenCalledTimes(2);
    expect(checkedScript(0)).toContain("Uninstall.exe");
    expect(checkedScript(1)).toContain("Invoke-WebRequest");
  });
});

describe("restore", () => {
  test("nous : desinstallation complete dans l'ordre exact", async () => {
    await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "0.4.6", ours: true, backupPath: null, pairedClients: 0 },
      { pending: [] },
    );
    expect(runRemoteChecked).toHaveBeenCalledTimes(1);
    const script = checkedScript(0);

    const stop = script.indexOf("sc.exe stop");
    const uninstallArg = script.indexOf("_?=");
    const uninstallExe = script.indexOf("Uninstall.exe");
    const nefconc = script.indexOf("nefconc.exe");
    const certRoot = script.indexOf("-delstore root");
    const certTrusted = script.indexOf("-delstore TrustedPublisher");
    const gamepad = script.indexOf("uninstall-gamepad.ps1");
    const path = script.indexOf("update-path.bat");
    const remove = script.indexOf("Remove-Item");
    const scDelete = script.indexOf("sc.exe delete");
    const netsh = script.indexOf("netsh.exe");

    expect(stop).toBeGreaterThanOrEqual(0);
    expect(uninstallExe).toBeGreaterThan(stop);
    expect(uninstallArg).toBeGreaterThan(stop);
    expect(nefconc).toBeGreaterThan(uninstallExe);
    expect(certRoot).toBeGreaterThan(nefconc);
    expect(certTrusted).toBeGreaterThan(certRoot);
    expect(gamepad).toBeGreaterThan(certTrusted);
    expect(path).toBeGreaterThan(gamepad);
    expect(remove).toBeGreaterThan(path);
    expect(scDelete).toBeGreaterThan(remove);
    expect(netsh).toBeGreaterThan(scDelete);

    expect(script).not.toContain("uninstall.bat");
    expect(script).not.toContain("pause");
  });

  test("etranger : cede sans rien executer", async () => {
    const outcome = await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "1.2.3", ours: false, backupPath: null, pairedClients: 4 },
      { pending: [] },
    );
    expect(runRemoteChecked).not.toHaveBeenCalled();
    expect(outcome).toBeDefined();
    expect(outcome && "yielded" in outcome ? outcome.yielded : "").toContain("4 client");
  });
});
