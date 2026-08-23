/**
 * Les huit cles que hardline impose. Rien d'autre n'est touche.
 *
 * Les six premieres decident de l'ecran virtuel ; les deux dernieres, de la
 * qualite de l'encodage. Le journal d'Apollo revelait
 * « NvEnc: created encoder HEVC P1 » : P1 est le preset le PLUS RAPIDE de
 * NVENC, donc celui de moindre qualite, et c'est le defaut. Sur une carte qui
 * encode ce flux sans effort et un lien direct qui porte 106 Mbps, le payer
 * en qualite n'a aucune contrepartie utile. P5 garde une marge confortable
 * avant P7, que rien ne justifie en temps reel.
 *
 * spatial_aq repartit le debit vers les zones peu detaillees — un fond uni
 * parseme de texte, c'est-a-dire exactement un bureau. C'est ce qui evite le
 * grain autour des caracteres.
 */
export const REQUIRED_CONF: Readonly<Record<string, string>> = {
  headless_mode: "enabled",
  dd_configuration_option: "ensure_only_display",
  dd_resolution_option: "auto",
  dd_refresh_rate_option: "auto",
  dd_config_revert_on_disconnect: "enabled",
  capture: "ddx",
  nvenc_preset: "5",
  nvenc_spatial_aq: "enabled",
};

/** Fonction pure. Lit un sunshine.conf en paires cle/valeur. */
export function parseConf(text: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "") continue;

    result[key] = value;
  }

  return result;
}

/**
 * Fonction pure. Rend le texte du fichier avec les cles imposees, en
 * preservant les cles et les commentaires que hardline ne gere pas. Une cle
 * deja presente est remplacee sur place ; une cle absente est ajoutee a la
 * fin, dans l'ordre de `required`.
 */
export function patchConf(text: string, required: Record<string, string>): string {
  const remaining = new Set(Object.keys(required));
  const lines = text.split("\n");

  const patched = lines.map((rawLine) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return rawLine;

    const eq = line.indexOf("=");
    if (eq === -1) return rawLine;

    const key = line.slice(0, eq).trim();
    if (!(key in required)) return rawLine;

    remaining.delete(key);
    return `${key} = ${required[key]!}`;
  });

  let result = patched.join("\n");

  if (remaining.size > 0) {
    if (result !== "" && !result.endsWith("\n")) result += "\n";
    for (const key of remaining) {
      result += `${key} = ${required[key]!}\n`;
    }
  }

  return result;
}

/** Fonction pure. Vrai si toutes les cles imposees ont deja la bonne valeur. */
export function confConforms(text: string, required: Record<string, string>): boolean {
  const parsed = parseConf(text);
  return Object.entries(required).every(([key, value]) => parsed[key] === value);
}
