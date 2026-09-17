import { test, expect, describe } from "bun:test";
import { REQUIRED_CONF, parseConf, patchConf, confConforms } from "../../src/lib/apollo-conf";

// Le fichier du PC de reference : une cle imposee deja presente mais fausse
// (dd_configuration_option), les autres absentes, un commentaire, deux cles
// etrangeres — dont headless_mode, que hardline n'impose plus et ne doit donc
// PAS toucher — et server_cmd dont la valeur JSON doit survivre au passage.
const CONF_FIXTURE = [
  "# Fichier genere par Apollo",
  "sunshine_name = PC-ARTHUR",
  "headless_mode = disabled",
  "dd_configuration_option = disabled",
  'server_cmd = [{"name":"Bubbles","cmd":"start bubbles.exe","elevated":false}]',
  "",
].join("\n");

describe("REQUIRED_CONF", () => {
  test("contient exactement les dix cles imposees par Apollo", () => {
    expect(REQUIRED_CONF).toEqual({
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
  test("n'impose JAMAIS headless_mode, qui efface l'écran de verrouillage", () => {
    // Mesuré sur la machine : activé, le flux reste noir tant que la session
    // Windows n'est pas ouverte sur place, donc impossible de déverrouiller à
    // distance. Aucune valeur de dd_configuration_option ne le rattrape.
    expect(REQUIRED_CONF).not.toHaveProperty("headless_mode");
  });
});

describe("parseConf", () => {
  test("lit les paires cle/valeur et ignore commentaires et lignes vides", () => {
    const parsed = parseConf(CONF_FIXTURE);
    expect(parsed).toEqual({
      sunshine_name: "PC-ARTHUR",
      headless_mode: "disabled",
      dd_configuration_option: "disabled",
      server_cmd: '[{"name":"Bubbles","cmd":"start bubbles.exe","elevated":false}]',
    });
  });

  test("rend un objet vide sur un texte vide", () => {
    expect(parseConf("")).toEqual({});
  });
});

describe("confConforms", () => {
  test("est faux tant que les dix cles ne sont pas exactement imposees", () => {
    expect(confConforms(CONF_FIXTURE, REQUIRED_CONF)).toBe(false);
  });

  test("est vrai sur un texte qui porte deja toutes les valeurs imposees", () => {
    const conforming = [
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
    // hardline n'impose plus headless_mode : il le laisse donc tel quel.
    expect(patched).toContain("headless_mode = disabled");
    expect(patched).toContain(
      'server_cmd = [{"name":"Bubbles","cmd":"start bubbles.exe","elevated":false}]',
    );
  });

  test("remplace une cle imposee deja presente sur place, sans la dupliquer", () => {
    const patched = patchConf(CONF_FIXTURE, REQUIRED_CONF);
    const lines = patched.split("\n");

    const ddLines = lines.filter((line) => line.startsWith("dd_configuration_option"));
    expect(ddLines).toEqual(["dd_configuration_option = ensure_only_display"]);

    // Remplacee en place, donc toujours avant server_cmd qui suit dans
    // la fixture d'origine - pas rejetee a la fin avec les cles ajoutees.
    const ddIndex = lines.indexOf("dd_configuration_option = ensure_only_display");
    const serverCmdIndex = lines.findIndex((line) => line.startsWith("server_cmd"));
    expect(ddIndex).toBeGreaterThanOrEqual(0);
    expect(ddIndex).toBeLessThan(serverCmdIndex);
  });

  test("ajoute a la fin les cles absentes de la fixture, chacune une seule fois", () => {
    const patched = patchConf(CONF_FIXTURE, REQUIRED_CONF);

    for (const [key, value] of Object.entries(REQUIRED_CONF)) {
      if (key === "dd_configuration_option") continue;
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
      "dd_configuration_option = ensure_only_display\n" +
        "dd_resolution_option = auto\n" +
        "dd_refresh_rate_option = auto\n" +
        "dd_config_revert_on_disconnect = enabled\n" +
        "capture = ddx\nnvenc_preset = 5\nnvenc_spatial_aq = enabled\n" +
        "nvenc_twopass = quarter_res\nnvenc_vbv_increase = 400\nmax_bitrate = 0\n",
    );
  });
});
