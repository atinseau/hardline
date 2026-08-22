import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import type { CheckResult } from "../../src/lib/preflight";

const realShell = await import("../../src/lib/shell");
const realSsh = await import("../../src/lib/ssh");

const trace: string[] = [];
let localChecks: CheckResult[] = [];
let remoteChecks: CheckResult[] = [];
let reachable = true;

const reports: string[][] = [];
const finishes: string[] = [];

mock.module("../../src/lib/preflight", () => ({
  runLocalPreflight: async () => {
    trace.push("preflight-local");
    return localChecks;
  },
  runRemotePreflight: async () => {
    trace.push("preflight-remote");
    return remoteChecks;
  },
}));

// Le PC injoignable est le cas nominal du diagnostic, pas une anomalie de test :
// c'est precisement l'etat qu'on vient regarder.
mock.module("../../src/lib/shell", () => ({
  ...realShell,
  getServiceInfo: async () => {
    if (!reachable) throw new Error("service introuvable");
    return { mode: "manual", ip: "10.10.10.2", subnetMask: "255.255.255.0", router: null };
  },
  pingFrom: async () =>
    reachable
      ? {
          transmitted: 20,
          received: 20,
          lossPercent: 0,
          minMs: 0.4,
          avgMs: 1.04,
          maxMs: 1.7,
          stddevMs: 0.21,
        }
      : {
          transmitted: 20,
          received: 0,
          lossPercent: 100,
          minMs: null,
          avgMs: null,
          maxMs: null,
          stddevMs: null,
        },
}));

mock.module("../../src/lib/ssh", () => ({
  ...realSsh,
  runRemoteJson: async () => {
    throw new Error("PC injoignable");
  },
  runRemoteChecked: async () => {
    throw new Error("PC injoignable");
  },
}));

mock.module("../../src/lib/ui", () => ({
  configureOutput: () => {},
  withSpinner: async <T>(_label: string, run: () => Promise<T>) => run(),
  ui: {
    start: () => {},
    finish: (message: string) => finishes.push(message),
    skipped: () => {},
    applied: () => {},
    restored: () => {},
    failed: () => {},
    info: () => {},
    warn: () => {},
    report: (_title: string, lines: string[]) => reports.push(lines),
  },
}));

const { doctorCommand } = await import("../../src/commands/doctor");

const ok = (name: string): CheckResult => ({ name, ok: true, blocking: true, detail: "ok" });
const ko = (name: string): CheckResult => ({
  name,
  ok: false,
  blocking: true,
  detail: "PC injoignable",
});

beforeEach(() => {
  trace.length = 0;
  reports.length = 0;
  finishes.length = 0;
  localChecks = [ok("service-mac")];
  remoteChecks = [ok("ssh"), ok("gpu")];
  reachable = true;
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe("doctorCommand", () => {
  test("execute les deux phases de preconditions", async () => {
    await doctorCommand();
    expect(trace).toEqual(["preflight-local", "preflight-remote"]);
  });

  test("rend un rapport complet meme quand le PC ne repond pas", async () => {
    reachable = false;
    remoteChecks = [ko("ssh")];
    await doctorCommand();
    // Aucune exception : les deux phases ont tourne, chaque etape en echec a
    // sa ligne, et le diagnostic sort en anomalie.
    expect(trace).toEqual(["preflight-local", "preflight-remote"]);
    const rendered = (reports[0] ?? []).join("\n");
    expect(rendered).toMatch(/^KO\s+ssh\s*:/m);
    expect(rendered).toMatch(/injoignable/);
    expect(rendered).not.toContain("undefined");
    expect(process.exitCode).toBe(1);
  });

  test("conclut en anomalie tant qu'une etape ne converge pas", async () => {
    // Les etapes distantes restent en echec ici (SSH simule injoignable), donc
    // le diagnostic doit rester en anomalie : c'est ce qui prouve que la
    // conclusion depend de l'etat observe et non d'un chemin toujours vrai.
    await doctorCommand();
    expect(finishes.join("\n")).toContain("Anomalies détectées");
    expect(process.exitCode).toBe(1);
  });
});
