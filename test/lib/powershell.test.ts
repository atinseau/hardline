import { test, expect, describe } from "bun:test";
import {
  assertNoApostrophe,
  psInteger,
  psKeyword,
  psQuote,
} from "../../src/lib/powershell";

/**
 * Le script d'amorcage refusait deja toute valeur a apostrophe ; le chemin
 * RETOUR — les valeurs du releve recousues dans un script de restauration —
 * n'avait pas cette rigueur. Ce n'est pas une barriere de securite : le releve
 * n'est modifiable que par un administrateur du PC. C'est ce qui separe une
 * erreur nommee d'une instruction muette qui ne repose jamais l'adresse.
 */
describe("assertNoApostrophe", () => {
  test("laisse passer une valeur ordinaire", () => {
    expect(() => assertNoApostrophe("Ethernet", "alias")).not.toThrow();
  });

  test("refuse une apostrophe, et nomme la valeur fautive", () => {
    expect(() => assertNoApostrophe("Réseau d'Arthur", "alias")).toThrow(
      /alias.*Arthur/s,
    );
  });
});

describe("psQuote", () => {
  test("rend la valeur entre apostrophes", () => {
    expect(psQuote("Ethernet", "alias")).toBe("'Ethernet'");
  });

  test("refuse ce qui casserait la chaine", () => {
    expect(() => psQuote("a'b", "alias")).toThrow(/apostrophe/);
  });
});

describe("psInteger", () => {
  test("accepte un entier dans les bornes, chaine comprise", () => {
    expect(psInteger("24", "préfixe", 32)).toBe(24);
    expect(psInteger(0, "préfixe", 32)).toBe(0);
    expect(psInteger(32, "préfixe", 32)).toBe(32);
  });

  test("refuse un préfixe absent", () => {
    // Le cas reel : manualAddresses: ["10.0.0.1"] sans préfixe produisait
    // « -PrefixLength undefined », instruction qui echoue en silence dans une
    // queue tournant en Continue. L'adresse n'etait jamais reposee et personne
    // ne le savait.
    expect(() => psInteger(undefined, "préfixe", 32)).toThrow(/préfixe/);
    expect(() => psInteger("", "préfixe", 32)).toThrow(/préfixe/);
  });

  test("refuse hors bornes et non entier", () => {
    expect(() => psInteger(33, "préfixe", 32)).toThrow();
    expect(() => psInteger(-1, "préfixe", 32)).toThrow();
    expect(() => psInteger("24.5", "préfixe", 32)).toThrow();
    expect(() => psInteger("Private", "préfixe", 32)).toThrow();
  });
});

describe("psKeyword", () => {
  test("laisse passer un mot-cle de l'ensemble", () => {
    expect(psKeyword("Manual", "démarrage", ["Automatic", "Manual"])).toBe("Manual");
  });

  test("refuse tout le reste, puisqu'il est interpole hors apostrophes", () => {
    expect(() =>
      psKeyword("Automatic; Remove-Item C:\\", "démarrage", ["Automatic", "Manual"]),
    ).toThrow(/démarrage/);
  });
});
