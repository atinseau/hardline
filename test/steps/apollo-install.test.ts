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

/**
 * La ligne du script qui lance un installateur NSIS, reperee par SON marqueur
 * d'arguments - /D= a l'installation, _?= a la desinstallation - et non par le
 * nom du lanceur : reperer la ligne par « Start-Process » presupposerait ce
 * qu'on veut prouver, et la retrouverait meme apres un retour a `&`.
 *
 * Les garanties d'attente portent sur CETTE ligne, pas sur le script entier :
 * un Start-Process -Wait present ailleurs ne prouve rien sur l'installateur.
 */
function launchLine(script: string, marker: string): string {
  const lines = script.split("\n").filter((candidate) => candidate.includes(marker));
  expect(lines).toHaveLength(1);
  return lines[0] ?? "";
}

/**
 * Le defaut du 23 aout, en une fonction : PowerShell N'ATTEND PAS un
 * executable GUI lance par `&` - les installateurs NSIS en sont - et ne met
 * pas $LASTEXITCODE a jour. Le controle qui suivait relisait le code de la
 * commande precedente, et la suite du script s'executait PENDANT
 * l'installation. Seul Start-Process -Wait -PassThru attend, et seul .ExitCode
 * de l'objet rendu porte le vrai code.
 *
 * Un retour a `& (Join-Path ...)` ou une relecture de $LASTEXITCODE fait
 * tomber ce controle.
 */
function expectAwaitedLauncher(script: string, marker: string, variable: string): void {
  const line = launchLine(script, marker);
  expect(line).toContain("Start-Process");
  expect(line).toContain("-Wait");
  expect(line).toContain("-PassThru");
  expect(line).toContain(`$${variable} = `);
  // L'operateur d'appel, qui rend la main aussitot sur un binaire GUI.
  expect(line).not.toMatch(/(^|[;{]\s*)&\s/);

  const guard = script
    .split("\n")
    .find((candidate) => candidate.includes(`$${variable}.ExitCode -ne 0`));
  expect(guard).toBeDefined();
  // Le code lu est celui du processus attendu, jamais celui qui traine.
  expect(guard).not.toContain("$LASTEXITCODE");
  expect(script.indexOf(`$${variable}.ExitCode`)).toBeGreaterThan(script.indexOf(marker));
}

/**
 * Les marqueurs NSIS /D= et _?= prennent tout le reste de la ligne de commande
 * BRUTE, guillemets compris. `-ArgumentList` concatene ses elements par des
 * espaces sans les reciter (verifie sur le PC, PowerShell 5.1) : les
 * apostrophes de psQuote sont consommees par PowerShell, ce qui est juste, mais
 * un guillemet ajoute a la main ferait partie du chemin, et un marqueur qui ne
 * serait pas le dernier element verrait la suite avalee dans son chemin.
 */
function expectTrailingNsisMarker(line: string, marker: string): void {
  const list = line.slice(line.indexOf("-ArgumentList") + "-ArgumentList".length);
  const args = list.slice(0, list.indexOf("-Wait")).trim().replace(/,$/, "");
  const elements = args.split(",").map((element) => element.trim());
  expect(elements[0]).toBe("'/S'");
  expect(elements.at(-1)).toContain(marker);
  expect(elements.at(-1)).not.toContain('"');
  // psQuote reste le seul citateur : la valeur arrive entre apostrophes.
  expect(elements.at(-1)?.startsWith("'")).toBe(true);
  expect(elements.at(-1)?.endsWith("'")).toBe(true);
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
    const install = script.indexOf("Start-Process -FilePath $tempPath");
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

  /**
   * L'installateur est un binaire NSIS, donc un executable GUI : sans
   * Start-Process -Wait, la suppression du telechargement et le depot du
   * marqueur s'executent PENDANT l'installation, et le controle de code qui
   * suit est un faux positif systematique.
   */
  test("attend reellement l'installateur et lit SON code de sortie", async () => {
    jsonQueue.push([
      { installed: false, version: null, ours: false, pairedClients: 0, hasConfig: false },
    ]);
    await apolloInstallStep.apply(CONFIG);
    const script = checkedScript(0);

    expectAwaitedLauncher(script, `/D=${CONFIG.apollo.installDir}`, "install");

    // La suppression du telechargement et le marqueur viennent APRES le
    // controle du code, jamais pendant l'installation. lastIndexOf : une
    // premiere suppression existe deja dans la branche d'empreinte invalide.
    expect(script.lastIndexOf("Remove-Item -Path $tempPath")).toBeGreaterThan(
      script.indexOf("$install.ExitCode"),
    );
    expect(script.indexOf(MARKER_FILE)).toBeGreaterThan(
      script.indexOf("$install.ExitCode"),
    );
  });

  test("/D= arrive nu et en dernier, comme NSIS l'exige", async () => {
    jsonQueue.push([
      { installed: false, version: null, ours: false, pairedClients: 0, hasConfig: false },
    ]);
    await apolloInstallStep.apply(CONFIG);
    const line = launchLine(checkedScript(0), `/D=${CONFIG.apollo.installDir}`);
    expect(line).toContain("-FilePath $tempPath");
    expectTrailingNsisMarker(line, `/D=${CONFIG.apollo.installDir}`);
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
    // lastIndexOf : le script remet aussi $LASTEXITCODE a zero juste apres
    // sc.exe stop, et c'est la remise FINALE - celle qui protege le code de
    // sortie de la session SSH - qui doit suivre netsh.
    const resetExitCode = script.lastIndexOf("$LASTEXITCODE = 0");

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
    // netsh sort en code non nul quand aucune regle ne correspond deja - le
    // cas normal apres une desinstallation propre - sans quoi runRemoteChecked
    // rapporterait en echec une restauration reussie : la remise a zero doit
    // survivre APRES cet appel, pas seulement figurer quelque part dans le texte.
    expect(resetExitCode).toBeGreaterThan(netsh);

    expect(script).not.toContain("uninstall.bat");
    expect(script).not.toContain("pause");
  });

  /**
   * Le defaut du 23 aout, teste de face. Uninstall.exe est un binaire GUI
   * (Subsystem=2 sur le PC) : lance par `&`, PowerShell rend la main aussitot
   * sans mettre $LASTEXITCODE a jour. nefconc, les certutil et le Remove-Item
   * du dossier s'executaient alors PENDANT la desinstallation, et le controle
   * de code relisait celui de sc.exe stop - 1062 sur un service deja arrete,
   * d'ou l'echec observe. Un retour a `&` doit faire tomber ce test.
   */
  test("attend reellement Uninstall.exe et lit SON code de sortie", async () => {
    jsonQueue.push([{ backupPath: null }]);
    await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "0.4.6", ours: true, backupPath: null, pairedClients: 0 },
      { pending: [] },
    );
    const script = checkedScript(0);

    expectAwaitedLauncher(script, "_?=", "uninstall");
    expect(launchLine(script, "_?=")).toContain("Uninstall.exe");

    // Rien de la suite ne commence avant que le code d'Uninstall.exe soit lu.
    const guard = script.indexOf("$uninstall.ExitCode");
    for (const suivant of [
      "nefconc.exe",
      "-delstore root",
      "-delstore TrustedPublisher",
      "uninstall-gamepad.ps1",
      "update-path.bat",
      `Remove-Item -Path ${"'" + CONFIG.apollo.installDir + "'"}`,
    ]) {
      expect(script.indexOf(suivant)).toBeGreaterThan(guard);
    }
  });

  /**
   * _?= reste OBLIGATOIRE, et pour une raison distincte de l'attente : sans
   * lui, NSIS se recopie dans un dossier temporaire et se detache, si bien
   * qu'il n'y a meme plus de processus a attendre. -Wait sans _?= attendrait
   * un processus qui a deja rendu la main.
   */
  test("_?= arrive nu et en dernier, comme NSIS l'exige", async () => {
    jsonQueue.push([{ backupPath: null }]);
    await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "0.4.6", ours: true, backupPath: null, pairedClients: 0 },
      { pending: [] },
    );
    expectTrailingNsisMarker(
      launchLine(checkedScript(0), "_?="),
      `_?=${CONFIG.apollo.installDir}`,
    );
  });

  /**
   * sc.exe stop rend 1062 (ERROR_SERVICE_NOT_ACTIVE) sur un service deja
   * arrete - le cas nominal apres un plantage - et `| Out-Null` ne remet pas
   * $LASTEXITCODE a zero. C'est ce 1062 survivant qui a fait lever l'etape.
   */
  test("l'arret du service accepte 1062 et ne laisse survivre aucun code", async () => {
    jsonQueue.push([{ backupPath: null }]);
    await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "0.4.6", ours: true, backupPath: null, pairedClients: 0 },
      { pending: [] },
    );
    const script = checkedScript(0);

    const stop = script.indexOf("sc.exe stop");
    const garde = script.indexOf("$LASTEXITCODE -ne 1062");
    const reset = script.indexOf("$LASTEXITCODE = 0");

    // 1062 est nomme, donc traite comme un succes explicite.
    expect(garde).toBeGreaterThan(stop);
    // ... ainsi que 1060, ERROR_SERVICE_DOES_NOT_EXIST : plus rien a arreter.
    expect(script).toContain("$LASTEXITCODE -ne 1060");
    // La remise a zero suit l'arret et PRECEDE le lancement d'Uninstall.exe :
    // aucun code parasite ne subsiste pour la suite du script.
    expect(reset).toBeGreaterThan(garde);
    expect(reset).toBeLessThan(script.indexOf("Uninstall.exe"));
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
