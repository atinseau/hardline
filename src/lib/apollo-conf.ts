/** Les six cles que hardline impose. Rien d'autre n'est touche. */
export const REQUIRED_CONF: Readonly<Record<string, string>> = {
  headless_mode: "enabled",
  dd_configuration_option: "ensure_only_display",
  dd_resolution_option: "auto",
  dd_refresh_rate_option: "auto",
  dd_config_revert_on_disconnect: "enabled",
  capture: "ddx",
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
