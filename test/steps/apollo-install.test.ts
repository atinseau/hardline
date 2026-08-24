import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../fixtures/config";

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
/**
 * Ce que le PC ecrit sur sa sortie standard. La desinstallation y depose, par
 * un marqueur, ce qu'elle n'a PAS pu faire : sans stdout pilotable, aucun test
 * ne peut prouver que ce canal est relu jusqu'a l'ecran.
 */
let checkedStdout = "";
const runRemoteChecked = mock(async (_target: unknown, script: string) => {
  scriptLog.push(script);
  return { exitCode: 0, stdout: checkedStdout, stderr: "" };
});

mock.module("../../src/lib/ssh", () => ({
  runRemoteJson,
  runRemoteChecked,
}));

const {
  apolloInstallStep,
  backupApolloConfig,
  ForeignApolloError,
  MARKER_FILE,
  UNINSTALL_WARN_MARK,
} =
  await import("../../src/steps/apollo-install");

beforeEach(() => {
  jsonQueue = [];
  scriptLog = [];
  checkedStdout = "";
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

describe("Apollo Rescue Backup", () => {
  test("conserve configuration, version detectee et explication dans un dossier visible", async () => {
    jsonQueue.push([
      { backupPath: "C:\\ProgramData\\hardline\\apollo-rescue-20260824-120000" },
    ]);

    const path = await backupApolloConfig(CONFIG, {
      version: "0.4.5",
      explanation:
        "This Apollo installation existed before Hardline and is not reinstalled automatically.",
    });
    const script = scriptLog[0] ?? "";

    expect(path).toContain("apollo-rescue-");
    expect(script).toContain("apollo-rescue-$stamp");
    expect(script).toContain("sunshine.conf");
    expect(script).toContain("README.txt");
    expect(script).toContain("Detected version: 0.4.5");
    expect(script).toContain("existed before Hardline");
    expect(script).not.toContain("Remove-Item");
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
  test("nous : desinstallation complete sans nouvelle sauvegarde de secours", async () => {
    const outcome = await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "0.4.6", ours: true, backupPath: null, pairedClients: 0 },
      { pending: [] },
    );

    expect(outcome).toBeUndefined();
    expect(runRemoteJson).not.toHaveBeenCalled();
    expect(runRemoteChecked).toHaveBeenCalledTimes(1);

    const script = checkedScript(0);

    const stop = script.indexOf("sc.exe stop");
    const driverQuery = script.indexOf("Win32_PnPSignedDriver");
    const removeDevice = script.indexOf("/remove-device");
    const deleteDriver = script.indexOf("/delete-driver");
    const gamepad = script.indexOf("uninstall-gamepad.ps1");
    const path = script.indexOf("update-path.bat");
    const uninstallExe = script.indexOf("Uninstall.exe");
    const uninstallArg = script.indexOf("_?=");
    const certRoot = script.indexOf("-delstore root");
    const certTrusted = script.indexOf("-delstore TrustedPublisher");
    const remove = script.indexOf("Remove-Item");
    const scDelete = script.indexOf("sc.exe delete");
    const netsh = script.indexOf("netsh.exe");
    // lastIndexOf : le script remet aussi $LASTEXITCODE a zero apres sc.exe
    // stop, apres pnputil et apres chaque certutil, et c'est la remise FINALE -
    // celle qui protege le code de sortie de la session SSH - qui doit suivre
    // netsh.
    const resetExitCode = script.lastIndexOf("$LASTEXITCODE = 0");

    expect(stop).toBeGreaterThanOrEqual(0);
    // Le pilote et les deux scripts d'Apollo passent AVANT Uninstall.exe :
    // c'est lui qui supprime tools\, scripts\ et update-path.bat.
    expect(driverQuery).toBeGreaterThan(stop);
    expect(removeDevice).toBeGreaterThan(driverQuery);
    expect(deleteDriver).toBeGreaterThan(removeDevice);
    expect(gamepad).toBeGreaterThan(deleteDriver);
    expect(path).toBeGreaterThan(gamepad);
    expect(uninstallExe).toBeGreaterThan(path);
    expect(uninstallArg).toBeGreaterThan(uninstallExe);
    // Les certificats ne dependent d'aucun fichier d'Apollo : ils suivent.
    expect(certRoot).toBeGreaterThan(uninstallArg);
    expect(certTrusted).toBeGreaterThan(certRoot);
    expect(remove).toBeGreaterThan(certTrusted);
    expect(scDelete).toBeGreaterThan(remove);
    expect(netsh).toBeGreaterThan(scDelete);
    // netsh sort en code non nul quand aucune regle ne correspond deja - le
    // cas normal apres une desinstallation propre - sans quoi runRemoteChecked
    // rapporterait en echec une restauration reussie : la remise a zero doit
    // survivre APRES cet appel, pas seulement figurer quelque part dans le texte.
    expect(resetExitCode).toBeGreaterThan(netsh);

    expect(script).not.toContain("uninstall.bat");
    expect(script).not.toContain("pause");
    // nefconc.exe vivait sous tools\, que Uninstall.exe supprime : plus aucun
    // appel ne doit en dependre, ou que ce soit dans le script.
    expect(script).not.toContain("nefconc");
  });

  /**
   * Le sujet des certificats, et non le nom du fichier livre par Apollo.
   * Verifie en lecture sur le PC : `certutil -store root sudovda.cer` rend
   * NTE_NOT_FOUND, tandis que `certutil -store root sudovda@su.mk` trouve le
   * certificat. L'ancienne ligne n'aurait jamais rien retire des deux magasins,
   * meme si le script l'avait atteinte.
   */
  test("les certificats sont designes par leur sujet, dans les deux magasins", async () => {
    jsonQueue.push([{ backupPath: null }]);
    await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "0.4.6", ours: true, backupPath: null, pairedClients: 0 },
      { pending: [] },
    );
    const script = checkedScript(0);

    expect(script).toContain("-delstore root 'sudovda@su.mk'");
    expect(script).toContain("-delstore TrustedPublisher 'sudovda@su.mk'");
    // Le nom du fichier ne designe aucun certificat : il ne doit plus paraitre.
    expect(script).not.toContain("sudovda.cer");
  });

  /**
   * Le pilote se retire par pnputil, outil natif : il ne disparait pas avec le
   * dossier d'Apollo, il sait nettoyer une installation deja demontee, et il
   * n'exige pas d'executer un binaire tiers avec des privileges.
   *
   * Le pilote est retrouve par Win32_PnPSignedDriver, a partir de l'identifiant
   * materiel : les intitules de `pnputil /enum-drivers` sont TRADUITS et leur
   * analyse dependrait de la langue du PC.
   */
  test("le pilote SudoVDA est retire par pnputil, repere par son identifiant materiel", async () => {
    jsonQueue.push([{ backupPath: null }]);
    await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "0.4.6", ours: true, backupPath: null, pairedClients: 0 },
      { pending: [] },
    );
    const script = checkedScript(0);

    expect(script).toContain("Win32_PnPSignedDriver");
    expect(script).toContain("$_.HardWareID -eq 'root\\sudomaker\\sudovda'");
    expect(script).toContain("pnputil.exe /remove-device $device.DeviceID");
    expect(script).toContain("pnputil.exe /delete-driver $device.InfName");
    // L'analyse de la sortie de pnputil dependrait de la langue du PC.
    expect(script).not.toContain("/enum-drivers");
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
    // Le lanceur designe Uninstall.exe par la variable qui porte son chemin,
    // laquelle est bien construite sous le dossier d'Apollo.
    expect(launchLine(script, "_?=")).toContain("-FilePath $uninstallExe");
    expect(script).toContain(
      `$uninstallExe = Join-Path '${CONFIG.apollo.installDir}' 'Uninstall.exe'`,
    );

    // Rien de la suite ne commence avant que le code d'Uninstall.exe soit lu.
    const guard = script.indexOf("$uninstall.ExitCode");
    for (const suivant of [
      "-delstore root",
      "-delstore TrustedPublisher",
      `Remove-Item -Path ${"'" + CONFIG.apollo.installDir + "'"}`,
    ]) {
      expect(script.indexOf(suivant)).toBeGreaterThan(guard);
    }
  });

  /**
   * Ce que le deuxieme essai reel a revele, verrouille de face.
   *
   * Uninstall.exe supprime tools\, scripts\ et update-path.bat. Tout ce qui
   * EXECUTE un fichier fourni par Apollo doit donc passer AVANT lui, sans quoi
   * le script appelle des fichiers qui n'existent plus : « Le terme
   * C:\Program Files\Apollo\tools\nefconc.exe n'est pas reconnu ».
   *
   * Deux filets, et le second est celui qui mord sur ce qui n'existe pas encore.
   * Le premier nomme les fichiers connus. Le second BALAYE le script : toute
   * ligne qui execute quelque chose situe sous le dossier d'Apollo - par son
   * chemin en clair, ou par une variable affectee depuis ce dossier - doit
   * preceder le lancement d'Uninstall.exe, quel que soit le nom de l'outil.
   * Un retour a l'ancien ordre fait tomber les deux.
   */
  test("tout ce qui depend d'un fichier fourni par Apollo precede Uninstall.exe", async () => {
    jsonQueue.push([{ backupPath: null }]);
    await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "0.4.6", ours: true, backupPath: null, pairedClients: 0 },
      { pending: [] },
    );
    const lignes = checkedScript(0).split("\n");

    // La ligne qui LANCE Uninstall.exe, reperee par son marqueur NSIS : la
    // simple mention du nom apparait des l'affectation du chemin.
    const lancement = lignes.findIndex((ligne) => ligne.includes("_?="));
    expect(lancement).toBeGreaterThanOrEqual(0);

    for (const fourni of ["uninstall-gamepad.ps1", "update-path.bat", "nefconc.exe"]) {
      const at = lignes.findIndex((ligne) => ligne.includes(fourni));
      if (at >= 0) expect(at).toBeLessThan(lancement);
    }

    // Les variables PowerShell qui designent un fichier SOUS le dossier
    // d'Apollo : sans elles, deplacer l'affectation avant le lancement et
    // l'appel apres suffirait a passer le premier filet.
    const sousApollo = new Set<string>();
    for (const ligne of lignes) {
      const affectation = ligne.match(/^\s*\$(\w+)\s*=\s*Join-Path\s+'([^']*)'/);
      if (affectation?.[1] && affectation[2] === CONFIG.apollo.installDir) {
        sousApollo.add(affectation[1]);
      }
    }
    expect(sousApollo.size).toBeGreaterThan(0);

    lignes.forEach((ligne, index) => {
      if (index === lancement) return;
      const execute = /(^|[\s;{])&\s|Start-Process/.test(ligne);
      const viseApollo =
        ligne.includes(CONFIG.apollo.installDir) ||
        [...sousApollo].some((nom) => new RegExp(`\\$${nom}\\b`).test(ligne));
      if (execute && viseApollo) expect(index).toBeLessThan(lancement);
    });
  });

  /**
   * L'etat reel du PC apres le deuxieme essai : Uninstall.exe est passe,
   * scripts\ et update-path.bat ont disparu, le pilote et les certificats sont
   * restes. Une nouvelle execution doit aller jusqu'au bout de ce qui reste au
   * lieu de lever sur le premier fichier manquant - et nommer chaque manque.
   */
  test("chaque geste tolere l'absence de sa cible, et le dit", async () => {
    jsonQueue.push([{ backupPath: null }]);
    await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "0.4.6", ours: true, backupPath: null, pairedClients: 0 },
      { pending: [] },
    );
    const script = checkedScript(0);

    // Chaque fichier fourni par Apollo est teste avant d'etre appele.
    expect(script).toContain("if (Test-Path $gamepadScript) {");
    expect(script).toContain("if (Test-Path $updatePath) {");
    expect(script).toContain("if (Test-Path $uninstallExe) {");

    // Et chaque absence a sa branche qui la NOMME. Un `else` vide passerait le
    // controle precedent tout en retablissant le silence.
    const absences = script
      .split("\n")
      .filter((ligne) => ligne.includes("$warnings +="));
    for (const attendu of [
      "ViGEmBus",
      "update-path.bat",
      "Uninstall.exe",
      "SudoVDA",
      "root",
      "TrustedPublisher",
    ]) {
      expect(absences.some((ligne) => ligne.includes(attendu))).toBe(true);
    }

    // Le canal de retour existe, et il est le seul.
    expect(script).toContain(`Write-Output "${UNINSTALL_WARN_MARK} $warning"`);
  });

  /**
   * La tolerance ne doit jamais devenir du silence : ce que le PC dit n'avoir
   * pas pu faire remonte tel quel dans le rapport de fin, comme pairing.restore
   * le fait de ses propres cessions.
   */
  test("ce que le PC n'a pas pu faire remonte en cession", async () => {
    jsonQueue.push([{ backupPath: null }]);
    checkedStdout = [
      "Un bavardage quelconque de certutil",
      `${UNINSTALL_WARN_MARK} Pilote SudoVDA introuvable.`,
      `${UNINSTALL_WARN_MARK} update-path.bat absent.`,
    ].join("\n");

    const outcome = await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "0.4.6", ours: true, backupPath: null, pairedClients: 0 },
      { pending: [] },
    );

    const dit = outcome && "yielded" in outcome ? outcome.yielded : "";
    expect(dit).toContain("Pilote SudoVDA introuvable.");
    expect(dit).toContain("update-path.bat absent.");
    // Le marqueur est un detail de transport : il ne s'affiche pas.
    expect(dit).not.toContain(UNINSTALL_WARN_MARK);
    // Ce qui n'est pas marque n'est pas un avertissement.
    expect(dit).not.toContain("bavardage");
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
    const outcome = await apolloInstallStep.restore(
      CONFIG,
      { installed: false, version: null, ours: false, backupPath: null, pairedClients: 0 },
      { pending: [] },
    );

    expect(runRemoteJson).not.toHaveBeenCalled();
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
    const outcome = await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "1.2.3", ours: false, backupPath: null, pairedClients: 4 },
      { pending: [] },
    );

    // Le secours de l'Apollo etranger a ete cree avant son remplacement. La
    // restauration retire seulement l'Apollo gere par Hardline, sans en creer un autre.
    expect(runRemoteJson).not.toHaveBeenCalled();
    expect(runRemoteChecked).toHaveBeenCalledTimes(1);
    expect(checkedScript(0)).toContain("Uninstall.exe");
    expect(outcome).toBeDefined();
    expect(outcome && "yielded" in outcome ? outcome.yielded : "").toContain("4 client");
  });
});
