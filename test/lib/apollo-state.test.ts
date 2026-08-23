import { describe, expect, test } from "bun:test";
import {
  BOOLEAN_DEVICE_FIELDS,
  normalizeState,
} from "../../src/lib/apollo-state";

/**
 * Le fichier tel qu'Apollo 0.4.6 l'ecrit apres un appairage : les trois
 * champs booleens y sont des CHAINES. Mesure sur la machine : dans cet etat,
 * Sunshine.exe meurt au demarrage suivant (abort de la CRT, 0xc0000409),
 * juste avant d'ouvrir son interface web.
 */
const APRES_APPAIRAGE = JSON.stringify(
  {
    username: "hardline",
    salt: "P2mb3iv0XIVVtWZW",
    password: "6FD5335",
    root: {
      named_devices: [
        {
          allow_client_commands: "false",
          always_use_virtual_display: "false",
          cert: "-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----\n",
          display_mode: "",
          enable_legacy_ordering: "true",
          name: "Mac",
          perm: "117440512",
          uuid: "C1D70833",
        },
      ],
      uniqueid: "03D34044",
    },
  },
  null,
  4,
);

describe("normalizeState", () => {
  test("convertit les trois champs de chaîne en booléen", () => {
    const patched = normalizeState(APRES_APPAIRAGE);
    expect(patched).not.toBeNull();

    const device = JSON.parse(patched!).root.named_devices[0];
    expect(device.allow_client_commands).toBe(false);
    expect(device.always_use_virtual_display).toBe(false);
    expect(device.enable_legacy_ordering).toBe(true);
  });

  test("les trois champs traités sont exactement ceux mesurés coupables", () => {
    expect([...BOOLEAN_DEVICE_FIELDS]).toEqual([
      "allow_client_commands",
      "always_use_virtual_display",
      "enable_legacy_ordering",
    ]);
  });

  /**
   * Le certificat est le seul champ dont l'absence fait AUSSI planter Apollo
   * (cas 6 du releve terrain). Le perdre en normalisant remplacerait un crash
   * par un autre, et ferait en plus disparaitre l'appairage.
   */
  test("préserve le certificat, les champs étrangers et l'identifiant unique", () => {
    const patched = normalizeState(APRES_APPAIRAGE)!;
    const parsed = JSON.parse(patched);
    const device = parsed.root.named_devices[0];

    expect(device.cert).toBe(
      "-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----\n",
    );
    expect(device.name).toBe("Mac");
    expect(device.uuid).toBe("C1D70833");
    expect(device.perm).toBe("117440512");
    expect(device.display_mode).toBe("");
    expect(parsed.root.uniqueid).toBe("03D34044");
    expect(parsed.username).toBe("hardline");
    expect(parsed.password).toBe("6FD5335");
    expect(parsed.salt).toBe("P2mb3iv0XIVVtWZW");
  });

  test("rend null quand les champs sont déjà des booléens", () => {
    const deja = normalizeState(APRES_APPAIRAGE)!;
    expect(normalizeState(deja)).toBeNull();
  });

  test("rend null sur un état sans client appairé", () => {
    expect(
      normalizeState(JSON.stringify({ username: "hardline", root: { uniqueid: "X" } })),
    ).toBeNull();
    expect(normalizeState(JSON.stringify({ username: "hardline" }))).toBeNull();
  });

  test("normalise toutes les entrées, pas seulement la première", () => {
    const deux = JSON.parse(APRES_APPAIRAGE);
    deux.root.named_devices.push({
      ...deux.root.named_devices[0],
      name: "Autre",
      uuid: "B2",
      enable_legacy_ordering: "false",
    });

    const device = JSON.parse(normalizeState(JSON.stringify(deux))!).root
      .named_devices[1];
    expect(device.allow_client_commands).toBe(false);
    expect(device.enable_legacy_ordering).toBe(false);
    expect(device.name).toBe("Autre");
  });

  /**
   * Une valeur qu'on ne sait pas interpreter n'est pas convertie en `false`
   * par defaut : deviner ici, c'est changer une permission sans le dire.
   */
  test("laisse intacte une valeur qui n'est ni « true » ni « false »", () => {
    const bizarre = JSON.parse(APRES_APPAIRAGE);
    bizarre.root.named_devices[0].allow_client_commands = "peut-être";

    const device = JSON.parse(normalizeState(JSON.stringify(bizarre))!).root
      .named_devices[0];
    expect(device.allow_client_commands).toBe("peut-être");
    expect(device.always_use_virtual_display).toBe(false);
  });

  test("refuse un texte qui n'est pas du JSON, en nommant le fichier", () => {
    expect(() => normalizeState("{ pas du json")).toThrow(/sunshine_state\.json/);
  });
});
