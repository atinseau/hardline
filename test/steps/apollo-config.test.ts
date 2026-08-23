import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";

let jsonQueue: unknown[][] = [];
/** Les scripts envoyes a runRemoteJson, dans l'ordre reel des appels. */
let jsonScripts: string[] = [];
const runRemoteJson = mock(async (_target: unknown, script: string) => {
  jsonScripts.push(script);
  const next = jsonQueue.shift();
  if (!next) throw new Error("file d'attente JSON vide dans le test");
  return next;
});
const runRemoteChecked = mock(async (..._args: unknown[]) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../../src/lib/ssh", () => ({ runRemoteJson, runRemoteChecked }));

const setSecret = mock(async (..._args: unknown[]) => {});
const deleteSecret = mock(async (..._args: unknown[]) => true);
const generatePassword = mock(() => "S3cr3t-Passw0rd!");

mock.module("../../src/lib/keychain", () => ({
  setSecret,
  deleteSecret,
  generatePassword,
}));

const { apolloConfigStep } = await import("../../src/steps/apollo-config");

beforeEach(() => {
  jsonQueue = [];
  jsonScripts = [];
  runRemoteJson.mockClear();
  runRemoteChecked.mockClear();
  setSecret.mockClear();
  deleteSecret.mockClear();
  generatePassword.mockClear();
  generatePassword.mockImplementation(() => "S3cr3t-Passw0rd!");
});

function checkedScript(call: number): string {
  return String((runRemoteChecked.mock.calls[call] as unknown[])[1]);
}

const CONFORME_CONF = `headless_mode = enabled
dd_configuration_option = ensure_only_display
dd_resolution_option = auto
dd_refresh_rate_option = auto
dd_config_revert_on_disconnect = enabled
capture = ddx`;

describe("inspect", () => {
  test("conforme quand les identifiants et les six cles sont deja poses", async () => {
    jsonQueue.push([{ conf: CONFORME_CONF, hadCredentials: true }]);
    const state = await apolloConfigStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
  });

  test("non conforme sans identifiants meme si la conf est correcte", async () => {
    jsonQueue.push([{ conf: CONFORME_CONF, hadCredentials: false }]);
    const state = await apolloConfigStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.detail).toContain("absents");
  });

  test("non conforme quand une cle manque", async () => {
    jsonQueue.push([{ conf: "headless_mode = enabled", hadCredentials: true }]);
    const state = await apolloConfigStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
  });
});

describe("apply", () => {
  test("pose des identifiants tires au hasard quand ils sont absents, avant le premier demarrage", async () => {
    jsonQueue.push([{ conf: null, hadCredentials: false, serviceRunning: false }]);
    await apolloConfigStep.apply(CONFIG);

    expect(generatePassword).toHaveBeenCalledTimes(1);
    expect(setSecret).toHaveBeenCalledWith("apollo-web", "S3cr3t-Passw0rd!");

    const script = checkedScript(0);
    const creds = script.indexOf("--creds");
    const patch = script.indexOf("WriteAllText");
    expect(creds).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThan(creds);
    expect(script).toContain("headless_mode");
    expect(script).not.toContain("Restart-Service");
  });

  test("ne repose jamais les identifiants quand ils existent deja", async () => {
    jsonQueue.push([
      { conf: "headless_mode = enabled", hadCredentials: true, serviceRunning: true },
    ]);
    await apolloConfigStep.apply(CONFIG);

    expect(generatePassword).not.toHaveBeenCalled();
    expect(setSecret).not.toHaveBeenCalled();
    const script = checkedScript(0);
    expect(script).not.toContain("--creds");
  });

  test("relance le service si les identifiants sont poses alors qu'il tourne deja", async () => {
    jsonQueue.push([{ conf: null, hadCredentials: false, serviceRunning: true }]);
    await apolloConfigStep.apply(CONFIG);
    const script = checkedScript(0);
    const creds = script.indexOf("--creds");
    const restart = script.indexOf("Restart-Service");
    expect(restart).toBeGreaterThan(creds);
  });

  test("preserve les lignes non gerees par hardline", async () => {
    jsonQueue.push([
      {
        conf: "# commentaire perso\nsunshine_name = mon-pc\nheadless_mode = disabled",
        hadCredentials: true,
        serviceRunning: false,
      },
    ]);
    await apolloConfigStep.apply(CONFIG);
    const script = checkedScript(0);
    expect(script).toContain("sunshine_name = mon-pc");
    expect(script).toContain("commentaire perso");
    expect(script).toContain("headless_mode = enabled");
  });

  /**
   * Preuve par mutation : le mot de passe engendre doit passer par psQuote
   * avant d'entrer dans le script distant, jamais par interpolation directe.
   * psQuote rejette toute valeur contenant une apostrophe (voir
   * src/lib/powershell.ts) ; si le mot de passe tire au hasard en contient
   * une, apply() doit echouer. Une interpolation directe (par exemple
   * `'${password}'` a la main) ne ferait pas cette verification et laisserait
   * ce test passer a tort : c'est exactement le bug que ce test attrape.
   */
  test("le mot de passe engendre passe par psQuote : une apostrophe fait echouer apply", async () => {
    generatePassword.mockImplementation(() => "mauvais'motdepasse");
    jsonQueue.push([{ conf: null, hadCredentials: false, serviceRunning: false }]);
    await expect(apolloConfigStep.apply(CONFIG)).rejects.toThrow();
  });

  /**
   * Preuve par mutation complementaire : le mot de passe engendre doit
   * apparaitre au trousseau ET dans le script distant, sous la forme exacte
   * que psQuote produit (entoure d'apostrophes). Une fuite qui contournerait
   * setSecret, ou une citation differente, romprait cette assertion.
   */
  test("le mot de passe range au trousseau est celui pose sur le PC, cite par psQuote", async () => {
    jsonQueue.push([{ conf: null, hadCredentials: false, serviceRunning: false }]);
    await apolloConfigStep.apply(CONFIG);
    const script = checkedScript(0);
    expect(script).toContain("'S3cr3t-Passw0rd!'");
  });

  /**
   * Preuve par mutation (ronde 1) : le mot de passe ne doit apparaitre que
   * sur sa ligne d'affectation, jamais sur la ligne d'appel a sunshine.exe.
   * Une interpolation directe dans l'appel (le defaut corrige) mettrait le
   * mot de passe sur les DEUX lignes, ou ferait disparaitre la ligne
   * d'affectation ; l'un ou l'autre fait tomber ce test.
   */
  test("le mot de passe n'apparait jamais sur la ligne d'appel a --creds, seulement dans l'affectation qui precede", async () => {
    jsonQueue.push([{ conf: null, hadCredentials: false, serviceRunning: false }]);
    await apolloConfigStep.apply(CONFIG);
    const script = checkedScript(0);
    const lines = script.split("\n");
    const assignIndex = lines.findIndex((l) => l.includes("S3cr3t-Passw0rd!"));
    const credsIndex = lines.findIndex((l) => l.includes("--creds"));
    expect(assignIndex).toBeGreaterThanOrEqual(0);
    expect(lines[assignIndex]).toContain("=");
    expect(credsIndex).toBeGreaterThan(assignIndex);
    expect(lines[credsIndex]).not.toContain("S3cr3t-Passw0rd!");
  });

  /**
   * Preuve par mutation (ronde 1) : simule un echec de la ligne d'appel a
   * sunshine.exe --creds comme le ferait PowerShell via son PositionMessage,
   * qui recite le texte SOURCE de la ligne en cause - et que
   * runRemoteChecked (src/lib/ssh.ts) recopie tel quel dans le message
   * d'erreur remonte. Si le mot de passe etait cousu en litteral dans cette
   * ligne, il reapparaitrait ici ; avec l'affectation intermediaire, la
   * ligne en cause ne contient que $applyWebPassword.
   */
  test("le mot de passe n'apparait dans aucun message d'erreur remonte, meme si l'appel --creds echoue", async () => {
    jsonQueue.push([{ conf: null, hadCredentials: false, serviceRunning: false }]);
    runRemoteChecked.mockImplementationOnce(async (..._args: unknown[]) => {
      const script = String(_args[1]);
      const credsLine = script.split("\n").find((l) => l.includes("--creds"));
      throw new Error(
        `Commande distante en échec (code 1)\u00a0: At line:2 char:1\n+ ${credsLine}\n+ ~~~~`,
      );
    });
    let caught: unknown;
    try {
      await apolloConfigStep.apply(CONFIG);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("S3cr3t-Passw0rd!");
  });

  /**
   * Preuve par mutation (ronde 2) : le test precedent fabrique lui-meme le
   * message d'erreur simule en extrayant la ligne du script - il ne verifie
   * jamais que la redirection y figure REELLEMENT. C'est 2>$null qui empeche
   * sunshine.exe d'ecrire sur son propre flux d'erreur un texte que
   * runRemoteChecked (src/lib/ssh.ts) recopierait ensuite dans l'erreur
   * remontee : sans cette assertion sur le script capture, retirer la
   * redirection de la production laissait tous les tests verts.
   */
  test("la ligne d'appel a --creds redirige son flux d'erreur vers le neant", async () => {
    jsonQueue.push([{ conf: null, hadCredentials: false, serviceRunning: false }]);
    await apolloConfigStep.apply(CONFIG);
    const script = checkedScript(0);
    const credsLine = script.split("\n").find((l) => l.includes("--creds"));
    expect(credsLine).toContain("2>$null");
  });

  /**
   * Preuve par mutation (ronde 1) : le contenu ecrit passe par psDoubleQuote,
   * qui echappe accent grave, dollar et guillemet. Une interpolation nue
   * (par exemple un template `"${patchedConf}"` a la main) laisserait `$` et
   * `"` intacts dans le script, ce que ce test detecte.
   */
  test("le contenu ecrit est echappe par psDoubleQuote : dollar et guillemet survivent cites", async () => {
    jsonQueue.push([
      {
        conf: 'sunshine_name = "valeur $HOME"',
        hadCredentials: true,
        serviceRunning: false,
      },
    ]);
    await apolloConfigStep.apply(CONFIG);
    const script = checkedScript(0);
    expect(script).toContain("`$HOME");
    expect(script).toContain('`"valeur');
  });

  /**
   * Preuve par mutation (ronde 1) : WriteAllText ecrit en UTF-8 sans BOM et
   * ne mutile pas les accents, contrairement a Set-Content -Encoding ascii.
   */
  test("le contenu accentue et un commentaire francais sont ecrits par WriteAllText en UTF-8 sans BOM", async () => {
    const conf = "# Commentaire en français : éàïôû\nsunshine_name = PC de l'étage";
    jsonQueue.push([{ conf, hadCredentials: true, serviceRunning: false }]);
    await apolloConfigStep.apply(CONFIG);
    const script = checkedScript(0);
    expect(script).toContain("[System.IO.File]::WriteAllText(");
    expect(script).toContain("New-Object System.Text.UTF8Encoding($false)");
    expect(script).not.toContain("-Encoding ascii");
    expect(script).not.toContain("Set-Content");
    expect(script).toContain("Commentaire en français");
    expect(script).toContain("PC de l'étage");
  });
});

describe("restore", () => {
  test("rend le contenu exact d'avant et retire le secret cree par hardline", async () => {
    await apolloConfigStep.restore(
      CONFIG,
      { conf: "sunshine_name = ancien", hadCredentials: false },
      { pending: [] },
    );
    expect(checkedScript(0)).toContain("sunshine_name = ancien");
    expect(checkedScript(0)).toContain("WriteAllText");
    expect(deleteSecret).toHaveBeenCalledWith("apollo-web");
  });

  test("supprime le fichier quand il n'existait pas avant, et garde le secret preexistant", async () => {
    await apolloConfigStep.restore(CONFIG, { conf: null, hadCredentials: true }, { pending: [] });
    expect(checkedScript(0)).toContain("Remove-Item");
    expect(deleteSecret).not.toHaveBeenCalled();
  });

  /**
   * Preuve par mutation (ronde 1) : restore() ecrit par WriteAllText en
   * UTF-8 sans BOM, verbatim, accents et commentaire francais compris - la
   * meme garantie que pour apply(), et le meme defaut a corriger si elle
   * disparait (Set-Content -Encoding ascii mutilait les accents).
   */
  test("rend un contenu accentue et un commentaire francais par WriteAllText en UTF-8 sans BOM", async () => {
    const conf = "# commentaire français\nsunshine_name = café de l'étage";
    await apolloConfigStep.restore(CONFIG, { conf, hadCredentials: true }, { pending: [] });
    const script = checkedScript(0);
    expect(script).toContain("[System.IO.File]::WriteAllText(");
    expect(script).toContain("New-Object System.Text.UTF8Encoding($false)");
    expect(script).not.toContain("-Encoding ascii");
    expect(script).not.toContain("Set-Content");
    expect(script).toContain("commentaire français");
    expect(script).toContain("café de l'étage");
  });

  /**
   * Preuve par mutation (ronde 2) : symetrique du test d'echappement cote
   * apply. restore() ecrit le meme genre de contenu par le meme mecanisme
   * (psDoubleQuote), mais rien ne lie les deux scripts entre eux - le trou
   * signale au point 3 de la ronde 1 pour le releve valait aussi ici, pour
   * l'ecriture. Une configuration anterieure portant `$` et `"` doit
   * ressortir echappee du script de restore.
   */
  test("le contenu restaure est echappe par psDoubleQuote : dollar et guillemet survivent cites", async () => {
    const conf = 'sunshine_name = "valeur $HOME"';
    await apolloConfigStep.restore(CONFIG, { conf, hadCredentials: true }, { pending: [] });
    const script = checkedScript(0);
    expect(script).toContain("`$HOME");
    expect(script).toContain('`"valeur');
  });
});

/**
 * Preuve par mutation (ronde 1) : les mocks ci-dessus injectent le JSON de
 * retour sans jamais regarder le script ENVOYE a runRemoteJson. Un relecteur
 * a deja remplace root.username par root.named_certs dans les deux scripts
 * (onze tests verts), puis a remplace tout le releve par un appel HTTP a
 * l'API d'Apollo - exactement ce que le brief interdit (onze tests verts).
 * Ces tests capturent le script REEL envoye et verifient qu'il lit bien
 * sunshine_state.json / root.username, et qu'il ne contient AUCUN appel
 * HTTP. Les deux scripts (inspect et apply) sont couverts separement : ils
 * se ressemblent mais ne partagent aucune logique (voir la decision de
 * conception dans le brief), donc rien ne garantit qu'une mutation posee
 * dans l'un soit posee dans l'autre.
 */
describe("scripts de releve envoyes au PC", () => {
  test("inspect lit sunshine_state.json et root.username, sans appel HTTP", async () => {
    jsonQueue.push([{ conf: null, hadCredentials: false }]);
    await apolloConfigStep.inspect(CONFIG);
    const script = jsonScripts[0]!;
    expect(script).toContain("sunshine_state.json");
    expect(script).toContain("root.username");
    expect(script).not.toContain("Invoke-WebRequest");
    expect(script).not.toContain("Invoke-RestMethod");
    expect(script).not.toContain(String(CONFIG.apollo.apiPort));
  });

  test("apply lit sunshine_state.json et root.username, sans appel HTTP", async () => {
    jsonQueue.push([{ conf: null, hadCredentials: false, serviceRunning: false }]);
    await apolloConfigStep.apply(CONFIG);
    const script = jsonScripts[0]!;
    expect(script).toContain("sunshine_state.json");
    expect(script).toContain("root.username");
    expect(script).not.toContain("Invoke-WebRequest");
    expect(script).not.toContain("Invoke-RestMethod");
    expect(script).not.toContain(String(CONFIG.apollo.apiPort));
  });
});
