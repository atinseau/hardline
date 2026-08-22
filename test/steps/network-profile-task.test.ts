import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";

let remoteState: unknown[];
const runRemoteChecked = mock(async (..._args: unknown[]) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../../src/lib/ssh", () => ({
  runRemoteJson: async () => remoteState,
  runRemoteChecked,
}));

const { windowsProfileTaskStep, TASK_NAME } = await import(
  "../../src/steps/network-profile-task"
);

beforeEach(() => runRemoteChecked.mockClear());

describe("inspect", () => {
  test("declare conforme quand la tache existe et est active", async () => {
    remoteState = [{ present: true, state: "Ready" }];
    expect((await windowsProfileTaskStep.inspect(CONFIG)).conforming).toBe(true);
  });

  test("declare non conforme quand la tache est absente", async () => {
    remoteState = [{ present: false, state: null }];
    const state = await windowsProfileTaskStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current.present).toBe(false);
  });

  test("declare non conforme quand la tache existe mais est desactivee", async () => {
    remoteState = [{ present: true, state: "Disabled" }];
    expect((await windowsProfileTaskStep.inspect(CONFIG)).conforming).toBe(false);
  });
});

describe("apply", () => {
  test("enregistre une tache au demarrage executee en SYSTEM", async () => {
    await windowsProfileTaskStep.apply(CONFIG);
    const script = String((runRemoteChecked.mock.calls[0] as unknown[])[1]);
    expect(script).toContain("Register-ScheduledTask");
    expect(script).toContain(TASK_NAME);
    expect(script).toContain("AtStartup");
    expect(script).toContain("SYSTEM");
  });

  test("le script planifie attend l'apparition du profil, sous une limite de temps", async () => {
    // Au demarrage, l'interface n'est pas prete immediatement : sans attente,
    // Set-NetConnectionProfile echoue et la tache ne sert a rien.
    //
    // Mais une attente NON BORNEE serait pire : la tache tournerait
    // indefiniment sous le compte SYSTEM a chaque demarrage du PC. Ce test
    // doit donc verifier la borne elle-meme, pas la simple presence d'une
    // boucle — une assertion sur "while ou for ou Start-Sleep" laisserait
    // passer `while ($true)`.
    await windowsProfileTaskStep.apply(CONFIG);
    const script = String((runRemoteChecked.mock.calls[0] as unknown[])[1]);

    expect(script).toContain("Get-NetConnectionProfile");
    expect(script).toContain("Start-Sleep");
    expect(script).toMatch(/\$deadline\s*=\s*\(Get-Date\)\.AddMinutes\(\d+\)/);
    expect(script).toMatch(/while\s*\(\(Get-Date\)\s*-lt\s*\$deadline\)/);
    expect(script).not.toMatch(/while\s*\(\s*\$true\s*\)/);
  });

  test("le script planifie vise la seule interface du lien direct", async () => {
    await windowsProfileTaskStep.apply(CONFIG);
    const script = String((runRemoteChecked.mock.calls[0] as unknown[])[1]);
    expect(script).toContain(CONFIG.windows.interfaceAlias);
  });
});

// Une fenetre masquee sous SYSTEM est le pire endroit ou perdre une erreur :
// personne ne la voit, le lien reste Public — donc le pare-feu ferme — et rien
// n'en garde trace jusqu'au redemarrage suivant.
describe("apply, le script planifie verifie ce qu'il ecrit", () => {
  async function scheduledScript(): Promise<string> {
    await windowsProfileTaskStep.apply(CONFIG);
    return String((runRemoteChecked.mock.calls[0] as unknown[])[1]);
  }

  test("arrete les erreurs au lieu de les laisser filer", async () => {
    // Sans cette preference, un Set-NetConnectionProfile refuse continue en
    // silence. Le script planifie n'est pas confie a runRemoteChecked : c'est
    // un contenu encode, la preference doit y etre posee explicitement.
    expect(await scheduledScript()).toContain(
      "$ErrorActionPreference = 'Stop'",
    );
  });

  test("relit le profil apres l'avoir ecrit", async () => {
    const script = await scheduledScript();
    const reads = script.match(/Get-NetConnectionProfile/g) ?? [];
    const write = script.indexOf("Set-NetConnectionProfile");

    // Une lecture pour attendre l'interface, une pour verifier l'ecriture.
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(script.lastIndexOf("Get-NetConnectionProfile")).toBeGreaterThan(
      write,
    );
  });

  test("ne sort de la boucle qu'une fois le profil constate en Private", async () => {
    // La version fautive sortait sur la simple presence du profil : un Set
    // refuse laissait le lien en Public sans que personne le sache.
    const script = await scheduledScript();
    expect(script).toMatch(/if \(\$last -eq 'Private'\)[\s\S]{0,80}break/);
    expect(script.indexOf("break")).toBeGreaterThan(
      script.indexOf("Set-NetConnectionProfile"),
    );
  });

  test("laisse une trace quand il n'a pas pu appliquer le profil", async () => {
    const script = await scheduledScript();
    expect(script).toMatch(/if \(-not \$applied\) \{/);
    expect(script).toContain("Add-Content");
    expect(script).toContain("network-profile.log");
    expect(script).toContain("profil privé non appliqué");
  });
});

describe("restore", () => {
  test("supprime la tache si hardline l'avait creee", async () => {
    await windowsProfileTaskStep.restore(CONFIG, { present: false, state: null });
    const script = String((runRemoteChecked.mock.calls[0] as unknown[])[1]);
    expect(script).toContain("Unregister-ScheduledTask");
  });

  test("ne supprime rien si une tache de ce nom preexistait", async () => {
    await windowsProfileTaskStep.restore(CONFIG, { present: true, state: "Ready" });
    expect(runRemoteChecked).not.toHaveBeenCalled();
  });

  test("emporte le journal laisse par la tache", async () => {
    // Le seul residu que la tache puisse ecrire ; le laisser derriere elle
    // ferait de l'uninstall une restauration approximative.
    await windowsProfileTaskStep.restore(CONFIG, { present: false, state: null });
    const script = String((runRemoteChecked.mock.calls[0] as unknown[])[1]);
    expect(script).toContain("Remove-Item");
    expect(script).toContain("hardline");
  });

  test("n'avale pas un code de retour non nul", async () => {
    runRemoteChecked.mockImplementationOnce(async () => {
      throw new Error("Commande distante en echec (code 1) : Access is denied");
    });
    await expect(
      windowsProfileTaskStep.restore(CONFIG, { present: false, state: null }),
    ).rejects.toThrow(/code 1/);
  });
});
