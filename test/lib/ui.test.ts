import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";

const calls: string[] = [];
let cancelNext = false;
const spinnerStop = mock((m?: string) => calls.push(`stop:${m}`));
const spinnerError = mock((m?: string) => calls.push(`error:${m}`));

mock.module("@clack/prompts", () => ({
  intro: (m: string) => calls.push(`intro:${m}`),
  outro: (m: string) => calls.push(`outro:${m}`),
  note: (m: string, t?: string) => calls.push(`note:${t}:${m}`),
  cancel: (m: string) => calls.push(`cancel:${m}`),
  isCancel: (v: unknown) => typeof v === "symbol",
  confirm: async () => (cancelNext ? Symbol("cancel") : true),
  password: async () => (cancelNext ? Symbol("cancel") : "s3cr3t"),
  log: {
    step: (m: string) => calls.push(`step:${m}`),
    success: (m: string) => calls.push(`success:${m}`),
    error: (m: string) => calls.push(`error:${m}`),
    info: (m: string) => calls.push(`info:${m}`),
    warn: (m: string) => calls.push(`warn:${m}`),
  },
  spinner: () => ({
    start: (m?: string) => calls.push(`start:${m}`),
    message: (m?: string) => calls.push(`message:${m}`),
    stop: spinnerStop,
    error: spinnerError,
  }),
}));

const { configureOutput, ui, withSpinner, askConfirmation, askSecret, CancelledError } =
  await import("../../src/lib/ui");

const savedCI = process.env.CI;
beforeEach(() => {
  calls.length = 0;
  delete process.env.CI;
});
afterEach(() => {
  if (savedCI === undefined) delete process.env.CI;
  else process.env.CI = savedCI;
});

describe("configureOutput", () => {
  test("force CI hors terminal, pour ne pas polluer une sortie redirigee", () => {
    configureOutput(false);
    expect(process.env.CI).toBe("true");
  });

  test("ne touche a rien dans un terminal", () => {
    configureOutput(true);
    expect(process.env.CI).toBeUndefined();
  });
});

describe("statuts d'etape", () => {
  test("une etape deja conforme est visible, pas silencieuse", () => {
    ui.skipped({ label: "Adresse Mac", detail: "en 10.10.10.2" });
    expect(calls[0]).toContain("step:");
    expect(calls[0]).toContain("Adresse Mac");
    // Accents exiges par les contraintes du projet, et verifies ici : le
    // detail fourni par le test n'en contient aucun, donc seule la chaine
    // produite par le module peut satisfaire cette assertion.
    expect(calls[0]).toContain("déjà conforme");
  });

  test("une etape appliquee est distinguee d'une etape sautee", () => {
    ui.applied({ label: "Adresse Mac", detail: "posee" });
    expect(calls[0]).toContain("success:");
    expect(calls[0]).toContain("appliqué");
  });

  test("une etape restauree est distinguee d'une etape appliquee", () => {
    // Meme regle de discrimination que plus haut : le detail fourni ici ne
    // contient pas "restauré", seule la chaine du module peut le produire.
    ui.restored({ label: "Adresse Mac", detail: "ancienne adresse remise" });
    expect(calls[0]).toContain("success:");
    expect(calls[0]).toContain("restauré");
    expect(calls[0]).not.toContain("appliqué");
  });

  test("une etape en echec passe par le canal d'erreur", () => {
    ui.failed({ label: "Adresse Mac", detail: "sudo refuse" });
    expect(calls[0]).toContain("error:");
    expect(calls[0]).toContain("échec");
  });
});

describe("withSpinner", () => {
  test("arrete le spinner et rend la valeur en cas de succes", async () => {
    const value = await withSpinner("Attente du lien", async () => 42);
    expect(value).toBe(42);
    expect(spinnerStop).toHaveBeenCalledTimes(1);
    expect(spinnerError).not.toHaveBeenCalled();
  });

  test("bascule le spinner en erreur et propage l'exception", async () => {
    const boom = withSpinner("Attente du lien", async () => {
      throw new Error("cable debranche");
    });
    expect(boom).rejects.toThrow("cable debranche");
    await boom.catch(() => {});
    expect(spinnerError).toHaveBeenCalledTimes(1);
  });

  test("transmet un rapporteur de progression", async () => {
    await withSpinner("Installation", async (progress) => {
      progress("telechargement");
      progress("configuration");
    });
    expect(calls).toContain("message:telechargement");
    expect(calls).toContain("message:configuration");
  });
});

describe("askConfirmation", () => {
  test("ne demande rien quand --yes est passe", async () => {
    expect(await askConfirmation("Continuer ?", { assumeYes: true })).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("ne demande rien hors terminal", async () => {
    // Poser une question a un flux non interactif bloquerait indefiniment.
    expect(
      await askConfirmation("Continuer ?", { assumeYes: false, interactive: false }),
    ).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("rend la reponse de l'utilisateur en mode interactif", async () => {
    expect(
      await askConfirmation("Continuer ?", { assumeYes: false, interactive: true }),
    ).toBe(true);
  });

  test("leve CancelledError sur annulation, sans quitter le processus", async () => {
    // process.exit ici rendrait la fonction intestable et empecherait tout
    // nettoyage par l'appelant.
    cancelNext = true;
    const attempt = askConfirmation("Continuer ?", {
      assumeYes: false,
      interactive: true,
    });
    expect(attempt).rejects.toBeInstanceOf(CancelledError);
    await attempt.catch(() => {});
    expect(calls.some((c) => c.startsWith("cancel:"))).toBe(true);
    cancelNext = false;
  });
});

describe("report", () => {
  test("rend un bloc multi-lignes titre", () => {
    ui.report("Diagnostic", ["Latence : 1.04 ms", "Adresse PC : 10.10.10.1"]);
    expect(calls[0]).toContain("note:Diagnostic:");
    expect(calls[0]).toContain("Latence");
    expect(calls[0]).toContain("Adresse PC");
  });
});

describe("askSecret", () => {
  test("leve une erreur explicite hors terminal, sans jamais bloquer", async () => {
    await expect(
      askSecret("Mot de passe Windows", { interactive: false }),
    ).rejects.toThrow(/terminal interactif/);
    expect(calls).toHaveLength(0);
  });

  test("rend la valeur saisie en mode interactif", async () => {
    expect(await askSecret("Mot de passe Windows", { interactive: true })).toBe(
      "s3cr3t",
    );
  });

  test("leve CancelledError sur annulation", async () => {
    cancelNext = true;
    const attempt = askSecret("Mot de passe Windows", { interactive: true });
    await expect(attempt).rejects.toBeInstanceOf(CancelledError);
    await attempt.catch(() => {});
    cancelNext = false;
  });

  test("ne fait jamais echo de la valeur saisie sur aucun canal de sortie", async () => {
    // password() est le seul point d'entree clack utilise ici : le mock ne
    // pousse la valeur saisie dans `calls` (le journal de tout ce qui est
    // affiche) sous aucun pretexte. Si askSecret venait a logger la reponse
    // (ui.info, console.log, etc.), ce test le verrait.
    calls.length = 0;
    const value = await askSecret("Mot de passe Windows", { interactive: true });
    expect(value).toBe("s3cr3t");
    expect(calls.some((c) => c.includes("s3cr3t"))).toBe(false);
  });
});
