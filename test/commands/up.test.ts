import { test, expect, describe } from "bun:test";
import {
  parseResolution,
  parseFps,
  buildStreamOptions,
  broadcastAddress,
} from "../../src/commands/up";

describe("parseResolution", () => {
  test("lit une resolution valide", () => {
    expect(parseResolution("3456x2234")).toEqual({ width: 3456, height: 2234 });
  });

  test("accepte un X majuscule", () => {
    expect(parseResolution("1920X1080")).toEqual({ width: 1920, height: 1080 });
  });

  test("rejette un format invalide", () => {
    expect(() => parseResolution("3456-2234")).toThrow(/Résolution invalide/);
  });

  test("rejette une chaine vide", () => {
    expect(() => parseResolution("")).toThrow(/Résolution invalide/);
  });
});

describe("parseFps", () => {
  test("lit un entier positif", () => {
    expect(parseFps("120")).toBe(120);
  });

  test("rejette zero", () => {
    expect(() => parseFps("0")).toThrow(/Fréquence invalide/);
  });

  test("rejette une valeur non entiere", () => {
    expect(() => parseFps("59.94")).toThrow(/Fréquence invalide/);
  });

  test("rejette une valeur non numerique", () => {
    expect(() => parseFps("soixante")).toThrow(/Fréquence invalide/);
  });
});

describe("buildStreamOptions", () => {
  test("rend des options par defaut sans aucun drapeau", () => {
    expect(
      buildStreamOptions({ fullscreen: false, resolution: null, fps: null }),
    ).toEqual({ fullscreen: false, resolution: null, fps: null });
  });

  test("compose la resolution et la frequence imposees", () => {
    expect(
      buildStreamOptions({ fullscreen: true, resolution: "2560x1440", fps: "144" }),
    ).toEqual({
      fullscreen: true,
      resolution: { width: 2560, height: 1440 },
      fps: 144,
    });
  });
});

describe("broadcastAddress", () => {
  test("calcule la diffusion d'un reseau en /24", () => {
    expect(broadcastAddress("10.10.10.2", "255.255.255.0")).toBe("10.10.10.255");
  });

  test("calcule la diffusion d'un reseau en /16", () => {
    expect(broadcastAddress("192.168.0.5", "255.255.0.0")).toBe("192.168.255.255");
  });

  test("rejette une adresse malformee", () => {
    expect(() => broadcastAddress("10.10.10", "255.255.255.0")).toThrow(/invalide/);
  });
});
