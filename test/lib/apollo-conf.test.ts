import { test, expect, describe } from "bun:test";
import { REQUIRED_CONF, parseConf, patchConf, confConforms } from "../../src/lib/apollo-conf";

// Le fichier du PC de reference : une cle imposee deja presente mais fausse
// (headless_mode), cinq absentes, un commentaire, une cle etrangere, et
// server_cmd dont la valeur JSON doit survivre intacte au passage.
const CONF_FIXTURE = [
  "# Fichier genere par Apollo",
  "sunshine_name = PC-ARTHUR",
  "headless_mode = disabled",
  'server_cmd = [{"name":"Bubbles","cmd":"start bubbles.exe","elevated":false}]',
  "",
].join("\n");

describe("REQUIRED_CONF", () => {
  test("contient exactement les onze cles imposees par Apollo", () => {
    expect(REQUIRED_CONF).toEqual({
      headless_mode: "enabled",
      dd_configuration_option: "ensure_only_display",
      dd_resolution_option: "auto",
      dd_refresh_rate_option: "auto",
      dd_config_revert_on_disconnect: "enabled",
      capture: "ddx",
      nvenc_preset: "5",
      nvenc_spatial_aq: "enabled",
      nvenc_twopass: "quarter_res",
      nvenc_vbv_increase: "400",
      max_bitrate: "0",
    });
  });
});

describe("parseConf", () => {
  test("lit les paires cle/valeur et ignore commentaires et lignes vides", () => {
    const parsed = parseConf(CONF_FIXTURE);
    expect(parsed).toEqual({
      sunshine_name: "PC-ARTHUR",
      headless_mode: "disabled",
      server_cmd: '[{"name":"Bubbles","cmd":"start bubbles.exe","elevated":false}]',
    });
  });

  test("rend un objet vide sur un texte vide", () => {
    expect(parseConf("")).toEqual({});
  });
});

describe("confConforms", () => {
  test("est faux tant que les onze cles ne sont pas exactement imposees", () => {
    expect(confConforms(CONF_FIXTURE, REQUIRED_CONF)).toBe(false);
  });

  test("est vrai sur un texte qui porte deja toutes les valeurs imposees", () => {
    const conforming = [
      "headless_mode = enabled",
      "dd_configuration_option = ensure_only_display",
      "dd_resolution_option = auto",
      "dd_refresh_rate_option = auto",
      "dd_config_revert_on_disconnect = enabled",
      "capture = ddx\nnvenc_preset = 5\nnvenc_spatial_aq = enabled\nnvenc_twopass = quarter_res\nnvenc_vbv_increase = 400\nmax_bitrate = 0",
    ].join("\n");
    expect(confConforms(conforming, REQUIRED_CONF)).toBe(true);
  });
});

describe("patchConf", () => {
  test("preserve server_cmd, le commentaire et la cle etrangere sunshine_name", () => {
    const patched = patchConf(CONF_FIXTURE, REQUIRED_CONF);

    expect(patched).toContain("# Fichier genere par Apollo");
    expect(patched).toContain("sunshine_name = PC-ARTHUR");
    expect(patched).toContain(
      'server_cmd = [{"name":"Bubbles","cmd":"start bubbles.exe","elevated":false}]',
    );
  });

  test("remplace une cle imposee deja presente sur place, sans la dupliquer", () => {
    const patched = patchConf(CONF_FIXTURE, REQUIRED_CONF);
    const lines = patched.split("\n");

    const headlessLines = lines.filter((line) => line.startsWith("headless_mode"));
    expect(headlessLines).toEqual(["headless_mode = enabled"]);

    // Remplacee en place, donc toujours avant server_cmd qui suit dans
    // la fixture d'origine - pas rejetee a la fin avec les cles ajoutees.
    const headlessIndex = lines.indexOf("headless_mode = enabled");
    const serverCmdIndex = lines.findIndex((line) => line.startsWith("server_cmd"));
    expect(headlessIndex).toBeGreaterThanOrEqual(0);
    expect(headlessIndex).toBeLessThan(serverCmdIndex);
  });

  test("ajoute a la fin les cinq cles absentes de la fixture, chacune une seule fois", () => {
    const patched = patchConf(CONF_FIXTURE, REQUIRED_CONF);

    for (const [key, value] of Object.entries(REQUIRED_CONF)) {
      if (key === "headless_mode") continue;
      const line = `${key} = ${value}`;
      expect(patched).toContain(line);
      const occurrences = patched.split(line).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  test("rend un texte qui satisfait ensuite confConforms", () => {
    const patched = patchConf(CONF_FIXTURE, REQUIRED_CONF);
    expect(confConforms(patched, REQUIRED_CONF)).toBe(true);
  });

  test("appliquer patchConf une seconde fois ne change plus rien", () => {
    const once = patchConf(CONF_FIXTURE, REQUIRED_CONF);
    const twice = patchConf(once, REQUIRED_CONF);
    expect(twice).toBe(once);
  });

  test("ajoute toutes les cles imposees sur un fichier vide", () => {
    const patched = patchConf("", REQUIRED_CONF);
    expect(patched).toBe(
      "headless_mode = enabled\n" +
        "dd_configuration_option = ensure_only_display\n" +
        "dd_resolution_option = auto\n" +
        "dd_refresh_rate_option = auto\n" +
        "dd_config_revert_on_disconnect = enabled\n" +
        "capture = ddx\nnvenc_preset = 5\nnvenc_spatial_aq = enabled\n" +
        "nvenc_twopass = quarter_res\nnvenc_vbv_increase = 400\nmax_bitrate = 0\n",
    );
  });
});
