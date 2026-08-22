import { test, expect, describe } from "bun:test";
import { errorMessage } from "../../src/lib/errors";

describe("errorMessage", () => {
  test("rend le message d'une Error", () => {
    expect(errorMessage(new Error("refus"))).toBe("refus");
  });

  test("rend une valeur levee qui n'est pas une Error", () => {
    expect(errorMessage("chaine brute")).toBe("chaine brute");
  });

  test("ne rend jamais undefined pour une Error sans message", () => {
    expect(errorMessage(new Error())).toBe("Error");
  });

  test("rend une valeur nulle sans lever", () => {
    expect(errorMessage(undefined)).toBe("undefined");
  });
});
