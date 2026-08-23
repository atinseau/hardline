import { test, expect, describe } from "bun:test";
import { parseDisplays, mainDisplay } from "../../src/lib/display";

const TWO_SCREENS =
  "3456\t2234\t120.0\t1728\t1117\t1\n2560\t1440\t144.0\t2560\t1440\t0\n";

const NO_MAIN_FLAGGED =
  "3456\t2234\t120.0\t1728\t1117\t0\n2560\t1440\t144.0\t2560\t1440\t0\n";

describe("parseDisplays", () => {
  test("lit les deux écrans de la machine de référence", () => {
    expect(parseDisplays(TWO_SCREENS)).toEqual([
      {
        widthPx: 3456,
        heightPx: 2234,
        refreshHz: 120.0,
        widthPt: 1728,
        heightPt: 1117,
        main: true,
      },
      {
        widthPx: 2560,
        heightPx: 1440,
        refreshHz: 144.0,
        widthPt: 2560,
        heightPt: 1440,
        main: false,
      },
    ]);
  });

  test("rend un tableau vide sur une sortie vide", () => {
    expect(parseDisplays("")).toEqual([]);
  });

  test("ignore une ligne à qui il manque un champ, sans lever", () => {
    const malformed =
      "3456\t2234\t120.0\t1728\t1117\n2560\t1440\t144.0\t2560\t1440\t0\n";
    expect(parseDisplays(malformed)).toEqual([
      {
        widthPx: 2560,
        heightPx: 1440,
        refreshHz: 144.0,
        widthPt: 2560,
        heightPt: 1440,
        main: false,
      },
    ]);
  });

  test("distingue 0 et 1 pour le drapeau principal", () => {
    const [first, second] = parseDisplays(TWO_SCREENS);
    expect(first?.main).toBe(true);
    expect(second?.main).toBe(false);
  });
});

describe("mainDisplay", () => {
  test("rend l'écran marqué principal", () => {
    const displays = parseDisplays(TWO_SCREENS);
    expect(mainDisplay(displays)?.widthPx).toBe(3456);
  });

  test("rend le premier écran si aucun n'est marqué principal", () => {
    const displays = parseDisplays(NO_MAIN_FLAGGED);
    expect(mainDisplay(displays)?.widthPx).toBe(3456);
  });

  test("rend null pour un tableau vide", () => {
    expect(mainDisplay([])).toBeNull();
  });
});
