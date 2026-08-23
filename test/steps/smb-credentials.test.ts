import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";

let storedSecret: string | null;
const setSecret = mock(async (_name: string, value: string) => {
  storedSecret = value;
});
const deleteSecret = mock(async (_name: string) => {
  const existed = storedSecret !== null;
  storedSecret = null;
  return existed;
});

mock.module("../../src/lib/keychain", () => ({
  getSecret: async () => storedSecret,
  setSecret,
  deleteSecret,
}));

const { smbCredentialsStep, providePassword } = await import(
  "../../src/steps/smb-credentials"
);

beforeEach(() => {
  storedSecret = null;
  setSecret.mockClear();
  deleteSecret.mockClear();
});

describe("inspect", () => {
  test("declare conforme quand un secret est deja au trousseau", async () => {
    storedSecret = "ancien-mot-de-passe";
    const state = await smbCredentialsStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
    expect(state.current).toEqual({ present: true });
  });

  test("declare non conforme quand le trousseau est vide", async () => {
    const state = await smbCredentialsStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current).toEqual({ present: false });
  });

  test("ne revele jamais la valeur du secret dans le detail", async () => {
    storedSecret = "s3cr3t-Windows!";
    const state = await smbCredentialsStep.inspect(CONFIG);
    expect(state.detail).not.toContain("s3cr3t-Windows!");
  });
});

describe("apply", () => {
  test("range le mot de passe depose par providePassword", async () => {
    providePassword("hunter2");
    await smbCredentialsStep.apply(CONFIG);
    expect(setSecret).toHaveBeenCalledWith("windows-account", "hunter2");
  });

  test("le secret range au trousseau est exactement celui saisi", async () => {
    // Preuve directe de non-alteration : ce qui sort de setSecret est ce qui
    // est entre dans providePassword, caractere pour caractere.
    providePassword("hunter2-avec-accent-é-et-symboles!@#");
    await smbCredentialsStep.apply(CONFIG);
    expect(storedSecret).toBe("hunter2-avec-accent-é-et-symboles!@#");
  });

  test("efface le mot de passe en memoire une fois range : un second appel sans nouveau depot echoue", async () => {
    providePassword("hunter2");
    await smbCredentialsStep.apply(CONFIG);
    setSecret.mockClear();
    await expect(smbCredentialsStep.apply(CONFIG)).rejects.toThrow(
      /Mot de passe Windows manquant/,
    );
    expect(setSecret).not.toHaveBeenCalled();
  });

  test("rejette si aucun mot de passe n'a ete depose", async () => {
    await expect(smbCredentialsStep.apply(CONFIG)).rejects.toThrow(
      /providePassword\(\) doit être appelé/,
    );
  });

  test("le message d'erreur de mot de passe manquant ne contient jamais un secret depose auparavant", async () => {
    // Depose puis consomme un secret, puis provoque l'echec "manquant" : le
    // message d'erreur ne doit porter aucune trace du secret precedent.
    providePassword("secret-precedent-a-ne-jamais-fuir");
    await smbCredentialsStep.apply(CONFIG);
    try {
      await smbCredentialsStep.apply(CONFIG);
      throw new Error("aurait du rejeter");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain("secret-precedent-a-ne-jamais-fuir");
    }
  });
});

describe("restore", () => {
  const NO_PENDING = { pending: [] as string[] };

  test("retire le secret que l'etape a cree", async () => {
    storedSecret = "hunter2";
    await smbCredentialsStep.restore(CONFIG, { present: false }, NO_PENDING);
    expect(deleteSecret).toHaveBeenCalledWith("windows-account");
  });

  test("ne touche jamais a un secret qui preexistait", async () => {
    storedSecret = "mot-de-passe-utilisateur";
    await smbCredentialsStep.restore(CONFIG, { present: true }, NO_PENDING);
    expect(deleteSecret).not.toHaveBeenCalled();
  });
});
