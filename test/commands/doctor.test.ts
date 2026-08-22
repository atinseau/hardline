import { test, expect, describe } from "bun:test";
import { formatDiagnostic, type Diagnostic } from "../../src/commands/doctor";

/**
 * Les libelles et les details ci-dessous sont ceux que les modules produisent
 * REELLEMENT aujourd'hui, accents compris : `macNetworkStep.label` et le
 * `detail` conforme de son `inspect`, ceux de l'etape reseau du PC, et le
 * message de `runLocalPreflight` pour la cle publique. Une fixture qui decrit
 * une sortie disparue est verte et fausse : elle protege un rendu que plus
 * personne ne produit.
 */
const MAC = "Adresse fixe sur le lien direct (Mac)";
const PC = "Adresse fixe et profil privé sur le lien direct (PC)";
const MAC_DETAIL = "AX88179A déjà en 10.10.10.2";
const PC_DETAIL = "Ethernet déjà en 10.10.10.1/24, profil privé";
const SSH_DETAIL = "PC joignable sur 10.10.10.1";

const HEALTHY: Diagnostic = {
  checks: [
    {
      name: "ssh",
      ok: true,
      blocking: true,
      installOnly: false,
      detail: SSH_DETAIL,
    },
  ],
  steps: [
    { label: MAC, conforming: true, detail: MAC_DETAIL },
    { label: PC, conforming: true, detail: PC_DETAIL },
  ],
  ping: {
    transmitted: 20,
    received: 20,
    lossPercent: 0,
    minMs: 0.465,
    avgMs: 1.04,
    maxMs: 1.734,
    stddevMs: 0.209,
  },
};

/**
 * La ligne rendue pour un nom, marqueur compris. Le `slice(4)` saute le
 * marqueur : c'est lui qu'on veut pouvoir affirmer separement du reste.
 */
function lineFor(lines: string[], name: string): string {
  const found = lines.find((l) => l.slice(4).startsWith(`${name} :`));
  expect(found).toBeDefined();
  return found as string;
}

const markerOf = (line: string): string => line.slice(0, 4);

/** La colonne ou commence le detail. Sortie du module, jamais de la fixture. */
const columnOf = (line: string, detail: string): number =>
  line.length - detail.length;

describe("formatDiagnostic", () => {
  test("rend la latence et la gigue avec deux decimales", () => {
    const lines = formatDiagnostic(HEALTHY);
    expect(lines.join("\n")).toContain("1.04 ms");
    expect(lines.join("\n")).toContain("0.21 ms");
  });

  test("signale une perte de paquets non nulle", () => {
    const lines = formatDiagnostic({
      ...HEALTHY,
      ping: { ...HEALTHY.ping, received: 18, lossPercent: 10 },
    });
    // Assertion sur la ligne entiere : un simple toContain("10") serait
    // satisfait par l'adresse 10.10.10.1 presente ailleurs dans le rapport.
    expect(lines.join("\n")).toMatch(/^KO\s+Perte de paquets\s*:\s*10 %/m);
  });

  test("indique clairement qu'un hote est injoignable", () => {
    const lines = formatDiagnostic({
      ...HEALTHY,
      ping: {
        transmitted: 20,
        received: 0,
        lossPercent: 100,
        minMs: null,
        avgMs: null,
        maxMs: null,
        stddevMs: null,
      },
    });
    expect(lines.join("\n")).toMatch(/injoignable/i);
    expect(lines.join("\n")).not.toContain("null");
  });

  test("evite d'afficher undefined quand les paquets arrivent sans statistiques", () => {
    const lines = formatDiagnostic({
      ...HEALTHY,
      ping: {
        transmitted: 20,
        received: 18,
        lossPercent: 10,
        minMs: null,
        avgMs: null,
        maxMs: null,
        stddevMs: null,
      },
    });
    const text = lines.join("\n");
    expect(text).toMatch(/^KO\s+Latence\s*:\s*18\/20 paquets reçus, statistiques indisponibles/m);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
  });

  test("distingue une etape conforme d'une etape derivee", () => {
    // Les deux etapes portent la MEME fixture a une chose pres : `conforming`.
    // Le marqueur ne peut donc venir que du module.
    const lines = formatDiagnostic({
      ...HEALTHY,
      steps: [
        { label: MAC, conforming: true, detail: MAC_DETAIL },
        { label: PC, conforming: false, detail: "adresse absente, profil Public" },
      ],
    });
    expect(markerOf(lineFor(lines, MAC))).toBe("OK  ");
    expect(markerOf(lineFor(lines, PC))).toBe("KO  ");
    expect(lineFor(lines, MAC).endsWith(MAC_DETAIL)).toBe(true);
  });

  test("marque KO une verification en echec", () => {
    const lines = formatDiagnostic({
      ...HEALTHY,
      checks: [
        {
          name: "ssh",
          ok: false,
          blocking: true,
          installOnly: false,
          detail: "PC injoignable sur 10.10.10.1",
        },
      ],
    });
    expect(markerOf(lineFor(lines, "ssh"))).toBe("KO  ");
  });

  test("montre une precondition d'installation sans la marquer KO", () => {
    // Elle doit se voir — la taire cacherait pourquoi la prochaine
    // installation echouera — sans etre confondue avec une liaison malade.
    const lines = formatDiagnostic({
      ...HEALTHY,
      checks: [
        ...HEALTHY.checks,
        {
          name: "cle-publique",
          ok: false,
          blocking: true,
          installOnly: true,
          detail: "Clé publique introuvable ou vide",
        },
      ],
    });
    expect(markerOf(lineFor(lines, "cle-publique"))).toBe("!!  ");
    expect(markerOf(lineFor(lines, "ssh"))).toBe("OK  ");
    expect(lineFor(lines, "cle-publique")).toContain("Clé publique introuvable");
  });

  test("aligne tous les details sur une seule colonne", () => {
    // Sortie propre au module : aucune valeur de fixture ne peut la produire.
    const lines = formatDiagnostic(HEALTHY);
    const colonnes = new Set([
      columnOf(lineFor(lines, "ssh"), SSH_DETAIL),
      columnOf(lineFor(lines, MAC), MAC_DETAIL),
      columnOf(lineFor(lines, PC), PC_DETAIL),
    ]);
    expect(colonnes.size).toBe(1);
  });

  test("la colonne s'elargit pour le plus long libelle", () => {
    const etroit = columnOf(lineFor(formatDiagnostic(HEALTHY), "ssh"), SSH_DETAIL);
    const large = columnOf(
      lineFor(
        formatDiagnostic({
          ...HEALTHY,
          steps: [
            ...HEALTHY.steps,
            {
              label: "Amorçage du PC : OpenSSH, pare-feu, clé et adressage (PC)",
              conforming: true,
              detail: "relevé d'amorçage du 2026-08-22T09:00:00 déjà enregistré",
            },
          ],
        }),
        "ssh",
      ),
      SSH_DETAIL,
    );
    expect(large).toBeGreaterThan(etroit);
  });
});
