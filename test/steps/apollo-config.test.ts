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
    const patch = script.indexOf("Set-Content");
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
});

describe("restore", () => {
  test("rend le contenu exact d'avant et retire le secret cree par hardline", async () => {
    await apolloConfigStep.restore(
      CONFIG,
      { conf: "sunshine_name = ancien", hadCredentials: false },
      { pending: [] },
    );
    expect(checkedScript(0)).toContain("sunshine_name = ancien");
    expect(checkedScript(0)).toContain("Set-Content");
    expect(deleteSecret).toHaveBeenCalledWith("apollo-web");
  });

  test("supprime le fichier quand il n'existait pas avant, et garde le secret preexistant", async () => {
    await apolloConfigStep.restore(CONFIG, { conf: null, hadCredentials: true }, { pending: [] });
    expect(checkedScript(0)).toContain("Remove-Item");
    expect(deleteSecret).not.toHaveBeenCalled();
  });
});
