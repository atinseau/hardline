import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";
import type { MoonlightState } from "../../src/lib/brew";

let currentState: MoonlightState;
const install = mock(async (..._args: unknown[]) => 0);
const uninstall = mock(async (..._args: unknown[]) => 0);

mock.module("../../src/lib/brew", () => ({
  caskInfo: async () => currentState,
  installCask: install,
  uninstallCask: uninstall,
}));

const { moonlightInstallStep } = await import("../../src/steps/moonlight-install");

beforeEach(() => {
  install.mockClear();
  uninstall.mockClear();
});

describe("inspect", () => {
  test("declare conforme quand le cask est deja installe", async () => {
    currentState = { installed: true, version: "6.1.0" };
    const state = await moonlightInstallStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
    expect(state.detail).toContain("6.1.0");
  });

  test("declare non conforme quand le cask est absent", async () => {
    currentState = { installed: false, version: null };
    const state = await moonlightInstallStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current).toEqual({ installed: false, version: null });
  });
});

describe("apply", () => {
  test("installe le cask configure", async () => {
    await moonlightInstallStep.apply(CONFIG);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith("moonlight");
  });

  test("rejette quand brew refuse l'installation", async () => {
    install.mockImplementationOnce(async () => 1);
    await expect(moonlightInstallStep.apply(CONFIG)).rejects.toThrow(
      /Homebrew a refusé/,
    );
  });
});

describe("restore", () => {
  test("retire toujours le cask, meme si l'etat anterieur pretend qu'il etait deja installe", async () => {
    // La spec a tranche : la desinstallation retire Moonlight sans exception,
    // contrairement a la regle habituelle de ne defaire que ce qu'on a fait.
    // Un etat anterieur "installed: true" ne doit rien changer au geste.
    await moonlightInstallStep.restore(
      CONFIG,
      { installed: true, version: "6.1.0" },
      { pending: [] },
    );
    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(uninstall).toHaveBeenCalledWith("moonlight");
  });

  test("rejette quand brew refuse la desinstallation", async () => {
    uninstall.mockImplementationOnce(async () => 1);
    await expect(
      moonlightInstallStep.restore(
        CONFIG,
        { installed: false, version: null },
        { pending: [] },
      ),
    ).rejects.toThrow(/Homebrew a refusé/);
  });
});
