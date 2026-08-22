import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import type { CheckResult } from "../../src/lib/preflight";
import type { Step } from "../../src/steps/types";

// Les fonctions pures de preflight restent les vraies : hasBlockingFailure et
// SSH_CHECK decident du parcours, les simuler reviendrait a tester la simulation.
const realPreflight = await import("../../src/lib/preflight");
const realFs = await import("node:fs/promises");

// Journal d'execution. C'est l'ORDRE qui porte le correctif : la convergence
// locale doit preceder la premiere sonde distante, sans quoi la sonde part par
// la passerelle Wi-Fi et expire quel que soit l'etat du PC.
const trace: string[] = [];

let localChecks: CheckResult[] = [];
let remoteRounds: CheckResult[][] = [];
let remoteCalls = 0;
let bootstrapSucceeds = true;
let serveCalls = 0;
let waitCalls = 0;

const finishes: string[] = [];
const failures: string[] = [];
let applyThrowsOn: string | null = null;
let publicKey: string | null = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 test\n";
const appliedGroups: string[][] = [];
const manifestPaths: string[] = [];

mock.module("../../src/lib/preflight", () => ({
  ...realPreflight,
  runLocalPreflight: async () => {
    trace.push("preflight-local");
    return localChecks;
  },
  runRemotePreflight: async () => {
    trace.push("preflight-remote");
    const round = remoteRounds[Math.min(remoteCalls, remoteRounds.length - 1)];
    remoteCalls += 1;
    return round ?? [];
  },
  waitForRemote: async () => {
    trace.push("wait");
    waitCalls += 1;
    return bootstrapSucceeds;
  },
}));

mock.module("../../src/lib/orchestrator", () => ({
  applySteps: async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    steps: Step<any>[],
    _config: unknown,
    manifestPath: string,
  ) => {
    const names = steps.map((s) => s.name);
    trace.push(`apply:${names.join("+")}`);
    if (applyThrowsOn === names.join("+")) throw new Error("boum");
    appliedGroups.push(names);
    manifestPaths.push(manifestPath);
  },
}));

mock.module("../../src/lib/bootstrap-server", () => ({
  serveBootstrap: async (options: { port: number }) => {
    trace.push("serve");
    serveCalls += 1;
    return {
      url: `http://mac.local:${options.port}`,
      port: options.port,
      stop: () => trace.push("stop"),
    };
  },
  localBootstrapUrl: (port: number) => `http://mac.local:${port}/bootstrap.ps1`,
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
    failed: ({ label, detail }: { label: string; detail: string }) =>
      failures.push(`${label} — ${detail}`),
    info: () => {},
    warn: () => {},
    report: () => {},
  },
}));

// La cle publique est lue avant de servir le script d'amorcage ; le test ne
// doit dependre d'aucun fichier de la vraie machine.
mock.module("node:fs/promises", () => ({
  ...realFs,
  readFile: async () => {
    if (publicKey === null) throw new Error("ENOENT");
    return publicKey;
  },
}));

const { installCommand } = await import("../../src/commands/install");

const ok = (name: string): CheckResult => ({
  name,
  ok: true,
  blocking: true,
  detail: `${name} conforme`,
});

const ko = (name: string, blocking = true): CheckResult => ({
  name,
  ok: false,
  blocking,
  detail: `${name} en echec`,
});

const MAC_OK = [ok("service-mac")];
const PC_OK = [ok("ssh"), ok("windows-version"), ok("gpu"), ok("lien-windows")];

const LOCAL_GROUP = ["network-mac"];
const REMOTE_GROUP = ["bootstrap-windows", "network-windows", "network-profile-task"];

beforeEach(() => {
  trace.length = 0;
  finishes.length = 0;
  failures.length = 0;
  applyThrowsOn = null;
  publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 test\n";
  appliedGroups.length = 0;
  manifestPaths.length = 0;
  localChecks = MAC_OK;
  remoteRounds = [PC_OK];
  remoteCalls = 0;
  bootstrapSucceeds = true;
  serveCalls = 0;
  waitCalls = 0;
  process.exitCode = 0;
});

afterEach(() => {
  // Sans cela, le code de sortie pose par une commande simulee ferait echouer
  // le processus de test entier.
  process.exitCode = 0;
});

describe("installCommand", () => {
  test("converge le Mac avant de sonder le PC", async () => {
    await installCommand();
    expect(trace).toEqual([
      "preflight-local",
      "apply:network-mac",
      "preflight-remote",
      "apply:bootstrap-windows+network-windows+network-profile-task",
    ]);
    expect(process.exitCode).toBe(0);
  });

  test("les deux convergences ecrivent dans le meme manifeste", async () => {
    await installCommand();
    expect(appliedGroups).toEqual([LOCAL_GROUP, REMOTE_GROUP]);
    expect(manifestPaths).toHaveLength(2);
    expect(manifestPaths[1]).toBe(manifestPaths[0] as string);
    expect(manifestPaths[0]).toContain("manifest.json");
  });

  test("un blocage cote Mac ne modifie rien et n'envoie pas amorcer le PC", async () => {
    localChecks = [ko("service-mac")];
    await installCommand();
    // Ni convergence, ni sonde distante, ni dix minutes passees devant le PC.
    expect(trace).toEqual(["preflight-local"]);
    expect(serveCalls).toBe(0);
    expect(waitCalls).toBe(0);
    expect(process.exitCode).toBe(1);
    expect(finishes.join("\n")).toContain("Rien n'a été modifié");
  });

  test("un amorcage reussi rejoue la phase distante au lieu de demander une relance", async () => {
    remoteRounds = [[ko("ssh")], PC_OK];
    await installCommand();
    expect(trace).toEqual([
      "preflight-local",
      "apply:network-mac",
      "preflight-remote",
      "serve",
      "wait",
      "stop",
      "preflight-remote",
      "apply:bootstrap-windows+network-windows+network-profile-task",
    ]);
    expect(finishes.join("\n")).toContain("Liaison établie");
    expect(finishes.join("\n")).not.toContain("Relancer");
    expect(process.exitCode).toBe(0);
  });

  test("un amorcage sans reponse laisse le Mac converge et une consigne utilisable", async () => {
    remoteRounds = [[ko("ssh")]];
    bootstrapSucceeds = false;
    await installCommand();
    expect(remoteCalls).toBe(1);
    expect(appliedGroups).toEqual([LOCAL_GROUP]);
    expect(trace).not.toContain("apply:bootstrap-windows+network-windows+network-profile-task");
    expect(process.exitCode).toBe(1);
    const message = finishes.join("\n");
    expect(message).toContain("hardline install");
    expect(message).toContain("le Mac reste configuré");
    expect(message).toContain("hardline uninstall");
  });

  test("un blocage distant autre que SSH n'entre jamais dans l'amorcage", async () => {
    remoteRounds = [[ok("ssh"), ko("gpu")]];
    await installCommand();
    expect(serveCalls).toBe(0);
    expect(waitCalls).toBe(0);
    expect(remoteCalls).toBe(1);
    expect(appliedGroups).toEqual([LOCAL_GROUP]);
    expect(process.exitCode).toBe(1);
    // La sortie doit dire dans quel etat sont les machines et comment en sortir.
    const message = finishes.join("\n");
    expect(message).toContain("hardline uninstall");
    expect(message).toContain("Le Mac est configuré");
  });

  test("SSH en echec accompagne d'un autre blocage n'ouvre pas l'amorcage", async () => {
    remoteRounds = [[ko("ssh"), ko("lien-windows")]];
    await installCommand();
    expect(serveCalls).toBe(0);
    expect(appliedGroups).toEqual([LOCAL_GROUP]);
    expect(process.exitCode).toBe(1);
  });

  test("une cle publique manquante bloque en phase 1, avant toute modification", async () => {
    localChecks = [ok("service-mac"), ko("cle-publique")];
    await installCommand();
    expect(trace).toEqual(["preflight-local"]);
    expect(appliedGroups).toEqual([]);
    expect(serveCalls).toBe(0);
    expect(finishes.join("\n")).toContain("Rien n'a été modifié");
    expect(process.exitCode).toBe(1);
  });

  test("une cle disparue entre la phase 1 et l'amorcage sort en disant l'etat du Mac", async () => {
    // Le fichier existait a la phase 1 et n'existe plus a l'amorcage : le seul
    // cas que la precondition locale ne peut pas couvrir.
    remoteRounds = [[ko("ssh")]];
    publicKey = null;
    await installCommand();
    expect(trace).toEqual(["preflight-local", "apply:network-mac", "preflight-remote"]);
    expect(serveCalls).toBe(0);
    expect(appliedGroups).toEqual([LOCAL_GROUP]);
    expect(failures.join("\n")).toContain("ssh-keygen -t ed25519");
    const message = finishes.join("\n");
    expect(message).toContain("Le Mac reste configuré");
    expect(message).toContain("hardline uninstall");
    expect(process.exitCode).toBe(1);
  });

  test("un echec de la convergence du Mac n'envoie pas sonder le PC", async () => {
    applyThrowsOn = "network-mac";
    await installCommand();
    expect(trace).toEqual(["preflight-local", "apply:network-mac"]);
    expect(failures.join("\n")).toContain("Convergence du Mac — boum");
    expect(process.exitCode).toBe(1);
  });

  test("un echec de la convergence du PC dit comment reprendre", async () => {
    applyThrowsOn = "bootstrap-windows+network-windows+network-profile-task";
    await installCommand();
    expect(failures.join("\n")).toContain("Convergence du PC — boum");
    const message = finishes.join("\n");
    expect(message).toContain("état antérieur");
    expect(message).toContain("hardline uninstall");
    expect(process.exitCode).toBe(1);
  });

  test("un echec distant non bloquant n'arrete pas l'installation", async () => {
    remoteRounds = [[ok("ssh"), ko("windows-version", false), ok("gpu")]];
    await installCommand();
    expect(appliedGroups).toEqual([LOCAL_GROUP, REMOTE_GROUP]);
    expect(process.exitCode).toBe(0);
  });
});
