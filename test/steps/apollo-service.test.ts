import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../fixtures/config";

let jsonQueue: unknown[][] = [];
const runRemoteJson = mock(async () => {
  const next = jsonQueue.shift();
  if (!next) throw new Error("file d'attente JSON vide dans le test");
  return next;
});
const runRemoteChecked = mock(async (..._args: unknown[]) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../../src/lib/ssh", () => ({ runRemoteJson, runRemoteChecked }));

const { apolloServiceStep } = await import("../../src/steps/apollo-service");

beforeEach(() => {
  jsonQueue = [];
  runRemoteJson.mockClear();
  runRemoteChecked.mockClear();
});

function checkedScript(call: number): string {
  return String((runRemoteChecked.mock.calls[call] as unknown[])[1]);
}

describe("inspect", () => {
  test("conforme quand automatique et demarre", async () => {
    jsonQueue.push([{ startType: "Automatic", status: "Running" }]);
    const state = await apolloServiceStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
  });

  test("non conforme quand demarrage manuel", async () => {
    jsonQueue.push([{ startType: "Manual", status: "Stopped" }]);
    const state = await apolloServiceStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
  });
});

describe("apply", () => {
  test("passe en demarrage automatique puis demarre", async () => {
    await apolloServiceStep.apply(CONFIG);
    const script = checkedScript(0);
    const config = script.indexOf("start= auto");
    const start = script.indexOf("Start-Service");
    expect(config).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(config);
    expect(script).toContain(`sc.exe config '${CONFIG.apollo.serviceName}'`);
  });
});

describe("restore", () => {
  test("rend le demarrage et l'etat exacts d'avant", async () => {
    await apolloServiceStep.restore(
      CONFIG,
      { startType: "Manual", status: "Stopped" },
      { pending: [] },
    );
    const script = checkedScript(0);
    expect(script).toContain("-StartupType Manual");
    expect(script).toContain("Stop-Service");
    expect(script).not.toContain("Start-Service -Name");
  });

  /**
   * Complement au test precedent, avec l'autre polarite : si la production
   * ne posait le startType (ou l'etat) que dans un des deux sens, un seul
   * des deux tests s'en apercevrait. Ensemble, ils prouvent que les DEUX
   * valeurs relevees par inspect sont rendues, quel que soit leur cote.
   */
  test("rend le demarrage et l'etat exacts d'avant, cote automatique/demarre", async () => {
    await apolloServiceStep.restore(
      CONFIG,
      { startType: "Automatic", status: "Running" },
      { pending: [] },
    );
    const script = checkedScript(0);
    expect(script).toContain("-StartupType Automatic");
    expect(script).toContain("Start-Service");
    expect(script).not.toContain("Stop-Service");
  });

  test("n'ecrit rien quand le service n'existait pas", async () => {
    await apolloServiceStep.restore(CONFIG, { startType: null, status: null }, { pending: [] });
    expect(runRemoteChecked).not.toHaveBeenCalled();
  });

  test("rejette un type de demarrage hors de l'ensemble connu", async () => {
    await expect(
      apolloServiceStep.restore(CONFIG, { startType: "Bogus", status: null }, { pending: [] }),
    ).rejects.toThrow();
  });
});
