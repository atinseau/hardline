import { test, expect, describe } from "bun:test";
import { formatDiagnostic } from "../../src/commands/doctor";

const HEALTHY = {
  checks: [
    { name: "ssh", ok: true, blocking: true, detail: "PC joignable sur 10.10.10.1" },
  ],
  steps: [
    { label: "Adresse fixe (Mac)", conforming: true, detail: "deja en 10.10.10.2" },
    { label: "Adresse fixe (PC)", conforming: true, detail: "deja en 10.10.10.1" },
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

  test("distingue une etape conforme d'une etape derivee", () => {
    const lines = formatDiagnostic({
      ...HEALTHY,
      steps: [
        { label: "Adresse fixe (Mac)", conforming: true, detail: "deja en 10.10.10.2" },
        { label: "Adresse fixe (PC)", conforming: false, detail: "profil Public" },
      ],
    });
    const text = lines.join("\n");
    expect(text).toMatch(/^OK\s+Adresse fixe \(Mac\)\s*:\s*deja en 10\.10\.10\.2/m);
    expect(text).toMatch(/^KO\s+Adresse fixe \(PC\)\s*:\s*profil Public/m);
  });

  test("marque KO une verification en echec", () => {
    const lines = formatDiagnostic({
      ...HEALTHY,
      checks: [{ name: "ssh", ok: false, blocking: true, detail: "PC injoignable" }],
    });
    expect(lines.join("\n")).toMatch(/^KO\s+ssh\s*:\s*PC injoignable/m);
  });
});
