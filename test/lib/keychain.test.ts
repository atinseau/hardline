import { test, expect, describe, spyOn } from "bun:test";
import { KEYCHAIN_SERVICE, generatePassword, generatePin } from "../../src/lib/keychain";

describe("KEYCHAIN_SERVICE", () => {
  test("vaut hardline, l'étiquette de service commune à tous les secrets", () => {
    expect(KEYCHAIN_SERVICE).toBe("hardline");
  });
});

describe("generatePassword", () => {
  test("rend une chaîne de la longueur par défaut", () => {
    expect(generatePassword()).toHaveLength(24);
  });

  test("respecte une longueur explicite", () => {
    expect(generatePassword(12)).toHaveLength(12);
  });

  test("ne contient que des caractères imprimables, sans espace ni guillemet", () => {
    const password = generatePassword(64);
    expect(password).toMatch(/^[A-Za-z0-9!@#$%^&*\-_=+]+$/);
  });

  test("deux tirages successifs ne coïncident jamais", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

describe("generatePin", () => {
  test("rend toujours quatre chiffres", () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePin()).toMatch(/^\d{4}$/);
    }
  });

  test("conserve les zéros en tête", () => {
    // Force la valeur tiree pour prouver que le remplissage a zero fonctionne,
    // au lieu d'attendre au hasard un tirage qui commence par zero.
    const spy = spyOn(crypto, "getRandomValues").mockImplementation(
      (<T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint32Array) array[0] = 7;
        return array;
      }) as typeof crypto.getRandomValues,
    );
    try {
      expect(generatePin()).toBe("0007");
    } finally {
      spy.mockRestore();
    }
  });

  test("deux tirages non forcés ne coïncident pas systématiquement", () => {
    const pins = new Set(Array.from({ length: 20 }, () => generatePin()));
    expect(pins.size).toBeGreaterThan(1);
  });
});
