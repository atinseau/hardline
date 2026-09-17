import { test, expect, describe } from "bun:test";
import { estBloqueParMacos } from "../../src/lib/apollo-api";

describe("refus macOS du reseau local", () => {
  test("reconnait le socket que macOS n'a pas laisse ouvrir", () => {
    // Bun rend ce code quand l'autorisation « Réseau local » manque. Mesuré sur
    // la machine : même requête, même seconde, 200 depuis un processus
    // autorisé, FailedToOpenSocket depuis iTerm.
    const bloque = Object.assign(new TypeError("Was there a typo in the url or port?"), {
      code: "FailedToOpenSocket",
    });
    expect(estBloqueParMacos(bloque)).toBe(true);
  });

  test("ne confond pas avec une vraie panne réseau ni avec rien", () => {
    expect(estBloqueParMacos(new Error("ECONNREFUSED"))).toBe(false);
    expect(estBloqueParMacos({ code: "ECONNRESET" })).toBe(false);
    expect(estBloqueParMacos(null)).toBe(false);
    expect(estBloqueParMacos(undefined)).toBe(false);
  });
});
