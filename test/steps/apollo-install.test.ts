import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";

let jsonQueue: unknown[][] = [];
/**
 * Journal partage entre les deux mocks, dans l'ordre reel des appels. Un
 * comptage separe par mock ne voit rien d'une inversion entre une sauvegarde
 * (runRemoteJson) et une desinstallation (runRemoteChecked) : les deux
 * grandeurs sont invariantes par permutation. Seul un journal commun permet
 * de prouver l'ordre REEL entre les deux mocks.
 */
let scriptLog: string[] = [];

const runRemoteJson = mock(async (_target: unknown, script: string) => {
  scriptLog.push(script);
  const next = jsonQueue.shift();
  if (!next) throw new Error("file d'attente JSON vide dans le test");
  return next;
});
const runRemoteChecked = mock(async (_target: unknown, script: string) => {
  scriptLog.push(script);
  return { exitCode: 0, stdout: "", stderr: "" };
});

mock.module("../../src/lib/ssh", () => ({
  runRemoteJson,
  runRemoteChecked,
}));

const { apolloInstallStep, ForeignApolloError, MARKER_FILE } = await import(
  "../../src/steps/apollo-install"
);

beforeEach(() => {
  jsonQueue = [];
  scriptLog = [];
  runRemoteJson.mockClear();
  runRemoteChecked.mockClear();
});

function checkedScript(call: number): string {
  return String((runRemoteChecked.mock.calls[call] as unknown[])[1]);
}

/** Position de la premiere entree du journal contenant `marker`, tous mocks confondus. */
function logIndexOf(marker: string): number {
  return scriptLog.findIndex((script) => script.includes(marker));
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

/**
 * Le mock de runRemoteJson ne relit jamais le script distant : sans ces
 * tests, deux mutations ECRITES DANS LE POWERSHELL passent inapercues -
 * decider "ours" sur la version au lieu de Test-Path $markerPath, et
 * supprimer le comptage de root.named_certs - alors qu'elles sont
 * exactement ce que cette tache s'engage a ne jamais faire.
 */
describe("inspect - script distant (releve)", () => {
  test("l'appartenance est ecrite comme Test-Path sur le marqueur, jamais comme une comparaison de version", async () => {
    jsonQueue.push([
      { installed: true, version: "0.4.6", ours: true, pairedClients: 0, hasConfig: true },
    ]);
    await apolloInstallStep.inspect(CONFIG);
    const script = scriptLog[0] ?? "";
    const oursLine = script.split("\n").find((line) => line.includes("ours"));

    expect(script).toContain(MARKER_FILE);
    expect(oursLine).toBeDefined();
    expect(oursLine).toContain("Test-Path");
    expect(oursLine).toContain("$markerPath");
    expect(oursLine).not.toContain("$version");
  });

  test("le nombre de clients apparies vient de sunshine_state.json (named_certs), jamais d'une requete HTTP", async () => {
    jsonQueue.push([
      { installed: true, version: "0.4.6", ours: true, pairedClients: 0, hasConfig: true },
    ]);
    await apolloInstallStep.inspect(CONFIG);
    const script = scriptLog[0] ?? "";

    expect(script).toContain("sunshine_state.json");
    expect(script).toContain("named_certs");
    expect(script).not.toContain("Invoke-RestMethod");
    expect(script).not.toContain("Invoke-WebRequest");
    expect(script).not.toContain(String(CONFIG.apollo.apiPort));
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

    // Preuve d'ordre REELLE, a travers les deux mocks : les deux assertions
    // ci-dessus restent identiques meme si backupApolloConfig() est appelee
    // apres uninstallApollo() dans le code de production, puisque la
    // sauvegarde ne passe jamais par runRemoteChecked. Seul le journal
    // partage voit l'inversion.
    const backupAt = logIndexOf("Copy-Item");
    const uninstallAt = logIndexOf("Uninstall.exe");
    const installAt = logIndexOf("Invoke-WebRequest");
    expect(backupAt).toBeGreaterThanOrEqual(0);
    expect(uninstallAt).toBeGreaterThan(backupAt);
    expect(installAt).toBeGreaterThan(uninstallAt);
  });
});

describe("restore", () => {
  test("nous : sauvegarde puis desinstallation complete dans l'ordre exact", async () => {
    jsonQueue.push([
      { backupPath: "C:\\ProgramData\\hardline\\apollo-backup-20260101-000000.conf" },
    ]);

    const outcome = await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "0.4.6", ours: true, backupPath: null, pairedClients: 0 },
      { pending: [] },
    );

    expect(outcome).toBeUndefined();
    expect(runRemoteJson).toHaveBeenCalledTimes(1);
    expect(runRemoteChecked).toHaveBeenCalledTimes(1);

    const backupAt = logIndexOf("Copy-Item");
    const uninstallAt = logIndexOf("Uninstall.exe");
    expect(backupAt).toBeGreaterThanOrEqual(0);
    expect(uninstallAt).toBeGreaterThan(backupAt);

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

  /**
   * Cas nominal, et le trou que la ronde de correction a trouve : le
   * manifeste enregistre state.current AVANT apply (src/lib/orchestrator.ts),
   * donc previous decrit l'etat d'AVANT l'installation. Quand hardline a
   * installe Apollo sur une machine qui ne l'avait pas, previous vaut
   * { installed: false, ours: false } alors que c'est bien le notre qui
   * tourne : restore() doit le desinstaller quand meme, jamais ceder sur la
   * seule foi de previous.
   */
  test("previous.installed === false : ce que hardline a pose est desinstalle quand meme", async () => {
    jsonQueue.push([{ backupPath: null }]);

    const outcome = await apolloInstallStep.restore(
      CONFIG,
      { installed: false, version: null, ours: false, backupPath: null, pairedClients: 0 },
      { pending: [] },
    );

    expect(runRemoteJson).toHaveBeenCalledTimes(1);
    expect(runRemoteChecked).toHaveBeenCalledTimes(1);
    expect(checkedScript(0)).toContain("Uninstall.exe");
    expect(outcome).toBeUndefined();
  });

  /**
   * L'etranger efface apres consentement de l'utilisateur (tache 12) :
   * previous porte encore le releve d'origine { installed: true, ours: false
   * }, mais c'est desormais Apollo pose par hardline qui tourne sur le PC.
   * restore() le desinstalle comme le reste, ET dit en plus que l'etranger
   * d'origine ne sera pas remis.
   */
  test("previous.installed && !previous.ours : l'etranger d'origine est efface avec le notre, et non remis", async () => {
    jsonQueue.push([{ backupPath: null }]);

    const outcome = await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "1.2.3", ours: false, backupPath: null, pairedClients: 4 },
      { pending: [] },
    );

    expect(runRemoteJson).toHaveBeenCalledTimes(1);
    expect(runRemoteChecked).toHaveBeenCalledTimes(1);
    expect(checkedScript(0)).toContain("Uninstall.exe");
    expect(outcome).toBeDefined();
    expect(outcome && "yielded" in outcome ? outcome.yielded : "").toContain("4 client");
  });
});
