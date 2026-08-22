import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import type { CheckResult } from "../../src/lib/preflight";

const realShell = await import("../../src/lib/shell");
const realSsh = await import("../../src/lib/ssh");

const trace: string[] = [];
let localChecks: CheckResult[] = [];
let remoteChecks: CheckResult[] = [];
let reachable = true;
/** Le profil du lien cote PC : c'est lui qui decide de la conformite de l'etape. */
let profilPrive = true;

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

// Le PC repond quand la liaison est saine : sans cela, les etapes distantes
// echouent toutes et le diagnostic ne peut JAMAIS conclure a une liaison
// operationnelle, le seul cas ou le code de sortie est en jeu.
mock.module("../../src/lib/ssh", () => ({
  ...realSsh,
  runRemoteJson: async (_target: unknown, script: string) => {
    if (!reachable) throw new Error("PC injoignable");
    if (script.includes("Get-ScheduledTask")) return [{ present: true, state: "Ready" }];
    if (script.includes("bootstrap-state.json")) {
      // Aucun releve : l'etape se declare conforme et ne promet rien.
      return [{ capture: null, acknowledged: false, unreadable: false }];
    }
    return [
      {
        adapterPresent: true,
        adapterStatus: "Up",
        addresses: ["10.10.10.1/24"],
        manualAddresses: ["10.10.10.1/24"],
        dhcpEnabled: false,
        category: profilPrive ? "Private" : "Public",
      },
    ];
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
    yielded: () => {},
    detached: () => {},
    failed: () => {},
    info: () => {},
    warn: () => {},
    report: (_title: string, lines: string[]) => reports.push(lines),
  },
}));

const { doctorCommand } = await import("../../src/commands/doctor");

const ok = (name: string): CheckResult => ({
  name,
  ok: true,
  blocking: true,
  installOnly: false,
  detail: "ok",
});
const ko = (name: string): CheckResult => ({
  name,
  ok: false,
  blocking: true,
  installOnly: false,
  detail: "PC injoignable",
});
/** Un echec qui bloque l'installation sans rien dire de la sante du lien. */
const koPrecondition = (name: string): CheckResult => ({
  name,
  ok: false,
  blocking: true,
  installOnly: true,
  detail: "Clé publique introuvable ou vide",
});

beforeEach(() => {
  trace.length = 0;
  reports.length = 0;
  finishes.length = 0;
  localChecks = [ok("service-mac")];
  remoteChecks = [ok("ssh"), ok("gpu")];
  reachable = true;
  profilPrive = true;
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

  test("conclut a une liaison operationnelle sur un lien sain", async () => {
    // Le controle de tous les tests qui suivent : sans lui, une conclusion
    // toujours en anomalie les satisferait aussi.
    await doctorCommand();
    expect(finishes.join("\n")).toBe("Liaison opérationnelle.");
    expect(process.exitCode).toBe(0);
  });

  test("conclut en anomalie des qu'une etape ne converge pas", async () => {
    // Le PC repond, mais son lien est repasse en profil public : le pare-feu
    // est ferme et l'etape n'est plus conforme.
    profilPrive = false;
    await doctorCommand();
    expect(finishes.join("\n")).toContain("Anomalies détectées");
    expect(process.exitCode).toBe(1);
  });

  test("une cle publique absente ne rend pas la liaison malade", async () => {
    // Elle est une precondition d'INSTALLATION : la deposer sur le PC est deja
    // fait, et le lien tient sans elle. Sortir en 1 sur un lien qui fonctionne
    // rendrait le code de sortie de doctor inutilisable dans un script.
    localChecks = [ok("service-mac"), koPrecondition("cle-publique")];
    await doctorCommand();

    expect(process.exitCode).toBe(0);
    const message = finishes.join("\n");
    expect(message).toContain("Liaison opérationnelle");
    expect(message).not.toContain("Anomalies détectées");
    // Et elle est bien RAPPORTEE : la taire cacherait pourquoi la prochaine
    // installation echouera.
    expect(message).toContain("cle-publique");
    expect((reports[0] ?? []).join("\n")).toMatch(/^!!\s+cle-publique\s*:/m);
  });

  test("un echec bloquant qui n'est pas une precondition sort en 1", async () => {
    // Le controle du test precedent : c'est `installOnly` qui fait la
    // difference, pas le simple fait d'echouer en phase locale.
    localChecks = [ko("service-mac")];
    await doctorCommand();
    expect(finishes.join("\n")).toContain("Anomalies détectées");
    expect(process.exitCode).toBe(1);
  });
});
