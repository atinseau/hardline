import { beforeEach, describe, expect, mock, test } from "bun:test";
import { CONFIG } from "../fixtures/config";

const NO_PENDING = { pending: [] as string[] };
let remoteState: unknown[] = [];

const runRemoteJson = mock(async (..._args: unknown[]) => remoteState);
const runRemoteChecked = mock(async (..._args: unknown[]) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../../src/lib/ssh", () => ({ runRemoteJson, runRemoteChecked }));

const { windowsFastStartupStep } = await import("../../src/steps/windows-fast-startup");

beforeEach(() => {
  remoteState = [];
  runRemoteJson.mockClear();
  runRemoteChecked.mockClear();
});

const checkedScript = (): string =>
  String((runRemoteChecked.mock.calls[0] as unknown[])[1]);

describe("inspect", () => {
  test("declare conforme quand Fast Startup est desactive", async () => {
    remoteState = [{ enabled: false }];
    expect((await windowsFastStartupStep.inspect(CONFIG)).conforming).toBe(true);
  });

  test("declare non conforme quand Fast Startup desarme le WOL a l'arret", async () => {
    remoteState = [{ enabled: true }];
    const state = await windowsFastStartupStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.detail).toContain("activé");
  });

  test("conserve l'absence de la valeur pour pouvoir la restituer", async () => {
    remoteState = [{ enabled: null }];
    expect((await windowsFastStartupStep.inspect(CONFIG)).current.enabled).toBeNull();
  });

  test("echoue si Windows ne renvoie aucun etat", async () => {
    await expect(windowsFastStartupStep.inspect(CONFIG)).rejects.toThrow(/Fast Startup/);
  });
});

describe("apply", () => {
  test("desactive Fast Startup avec une valeur DWORD", async () => {
    await windowsFastStartupStep.apply(CONFIG);
    expect(checkedScript()).toContain("HiberbootEnabled");
    expect(checkedScript()).toContain("-Value 0");
    expect(checkedScript()).toContain("-PropertyType DWord");
  });
});

describe("restore", () => {
  test("reactive Fast Startup quand il etait actif", async () => {
    await windowsFastStartupStep.restore(CONFIG, { enabled: true }, NO_PENDING);
    expect(checkedScript()).toContain("-Value 1");
  });

  test("le laisse desactive quand il l'etait deja", async () => {
    await windowsFastStartupStep.restore(CONFIG, { enabled: false }, NO_PENDING);
    expect(checkedScript()).toContain("-Value 0");
  });

  test("retire la valeur quand elle n'existait pas", async () => {
    await windowsFastStartupStep.restore(CONFIG, { enabled: null }, NO_PENDING);
    expect(checkedScript()).toContain("Remove-ItemProperty");
    expect(checkedScript()).toContain("HiberbootEnabled");
  });
});
