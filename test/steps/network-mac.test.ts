import { test, expect, describe, mock, beforeEach } from "bun:test";

/** Aucune etape ne suit : cette restauration est la derniere a passer. */
const NO_PENDING = { pending: [] as string[] };
import type { ServiceIPConfig } from "../../src/lib/shell";
import { CONFIG } from "../fixtures/config";

let currentInfo: ServiceIPConfig;
const setManual = mock(async (..._args: unknown[]) => 0);
const setDhcp = mock(async (..._args: unknown[]) => 0);
const setOff = mock(async (..._args: unknown[]) => 0);

mock.module("../../src/lib/shell", () => ({
  getServiceInfo: async () => currentInfo,
  setServiceManualIP: setManual,
  setServiceDHCP: setDhcp,
  setServiceIPv4Off: setOff,
}));

const { macNetworkStep } = await import("../../src/steps/network-mac");

beforeEach(() => {
  setManual.mockClear();
  setDhcp.mockClear();
  setOff.mockClear();
});

describe("inspect", () => {
  test("declare conforme quand l'adresse cible est deja posee", async () => {
    currentInfo = {
      mode: "manual",
      ip: "10.10.10.2",
      subnetMask: "255.255.255.0",
      router: null,
    };
    const state = await macNetworkStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
  });

  test("declare non conforme quand le service est en DHCP", async () => {
    currentInfo = {
      mode: "dhcp",
      ip: "169.254.168.226",
      subnetMask: "255.255.0.0",
      router: null,
    };
    const state = await macNetworkStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current.mode).toBe("dhcp");
  });

  test("declare non conforme quand l'adresse manuelle est la mauvaise", async () => {
    currentInfo = {
      mode: "manual",
      ip: "10.10.10.9",
      subnetMask: "255.255.255.0",
      router: null,
    };
    expect((await macNetworkStep.inspect(CONFIG)).conforming).toBe(false);
  });

  test("declare non conforme quand une passerelle est definie", async () => {
    // Une passerelle sur ce lien detournerait la route par defaut de macOS.
    currentInfo = {
      mode: "manual",
      ip: "10.10.10.2",
      subnetMask: "255.255.255.0",
      router: "10.10.10.1",
    };
    expect((await macNetworkStep.inspect(CONFIG)).conforming).toBe(false);
  });
});

describe("apply", () => {
  test("pose l'adresse cible sans passerelle", async () => {
    await macNetworkStep.apply(CONFIG);
    expect(setManual).toHaveBeenCalledTimes(1);
    expect(setManual).toHaveBeenCalledWith("AX88179A", "10.10.10.2", "255.255.255.0");
  });

  test("rejette quand networksetup echoue", async () => {
    setManual.mockImplementationOnce(async () => 1);
    await expect(macNetworkStep.apply(CONFIG)).rejects.toThrow(
      /networksetup a refusé/,
    );
  });
});

describe("restore", () => {
  test("remet le service en DHCP si c'est ce qu'il etait", async () => {
    await macNetworkStep.restore(CONFIG, {
      mode: "dhcp",
      ip: null,
      subnetMask: null,
      router: null,
    }, NO_PENDING);
    expect(setDhcp).toHaveBeenCalledTimes(1);
    expect(setManual).not.toHaveBeenCalled();
  });

  test("remet l'adresse manuelle d'origine si c'est ce qu'elle etait", async () => {
    await macNetworkStep.restore(CONFIG, {
      mode: "manual",
      ip: "192.168.5.5",
      subnetMask: "255.255.255.0",
      router: null,
    }, NO_PENDING);
    expect(setManual).toHaveBeenCalledWith("AX88179A", "192.168.5.5", "255.255.255.0");
  });

  test("redesactive IPv4 si le service etait desactive avant l'installation", async () => {
    // Le remettre en DHCP serait deviner a la place de l'utilisateur.
    await macNetworkStep.restore(CONFIG, {
      mode: "off",
      ip: null,
      subnetMask: null,
      router: null,
    }, NO_PENDING);
    expect(setOff).toHaveBeenCalledTimes(1);
    expect(setOff).toHaveBeenCalledWith("AX88179A");
    expect(setDhcp).not.toHaveBeenCalled();
  });

  test("retombe sur DHCP si l'etat anterieur est manuel mais incomplet", async () => {
    await macNetworkStep.restore(CONFIG, {
      mode: "manual",
      ip: null,
      subnetMask: null,
      router: null,
    }, NO_PENDING);
    expect(setDhcp).toHaveBeenCalledTimes(1);
  });
});

// Une restauration qui avale le code de retour est le pire defaut possible du
// programme : l'orchestrateur la croit reussie, appelle forgetStep, et efface
// la seule trace de l'etat anterieur pendant que la machine reste epinglee sur
// l'adresse de hardline. Chacun de ces tests echoue si une seule des trois
// branches de restore cesse de verifier son code de retour.
describe("restore, echec de networksetup", () => {
  const PREVIOUS = {
    manual: {
      mode: "manual" as const,
      ip: "192.168.5.5",
      subnetMask: "255.255.255.0",
      router: null,
    },
    off: { mode: "off" as const, ip: null, subnetMask: null, router: null },
    dhcp: { mode: "dhcp" as const, ip: null, subnetMask: null, router: null },
  };

  test("rejette quand -setmanual est refuse", async () => {
    setManual.mockImplementationOnce(async () => 1);
    await expect(
      macNetworkStep.restore(CONFIG, PREVIOUS.manual, NO_PENDING),
    ).rejects.toThrow(/networksetup a refusé/);
  });

  test("rejette quand -setv4off est refuse", async () => {
    setOff.mockImplementationOnce(async () => 1);
    await expect(macNetworkStep.restore(CONFIG, PREVIOUS.off, NO_PENDING)).rejects.toThrow(
      /networksetup a refusé/,
    );
  });

  test("rejette quand -setdhcp est refuse", async () => {
    // Le scenario exact observe en revue : cache sudo expire pendant
    // l'uninstall, -setdhcp sort en 1, et hardline annoncait la restauration.
    setDhcp.mockImplementationOnce(async () => 1);
    await expect(macNetworkStep.restore(CONFIG, PREVIOUS.dhcp, NO_PENDING)).rejects.toThrow(
      /networksetup a refusé/,
    );
  });

  test("rejette quand le repli sur DHCP est refuse", async () => {
    setDhcp.mockImplementationOnce(async () => 1);
    await expect(
      macNetworkStep.restore(CONFIG, {
        mode: "manual",
        ip: null,
        subnetMask: null,
        router: null,
      }, NO_PENDING),
    ).rejects.toThrow(/networksetup a refusé/);
  });

  test("le message porte le code de retour et l'insecable avant le point d'interrogation", async () => {
    // L'insecable ne peut venir que du module : le test ne fournit aucune
    // chaine, seulement le code 77.
    setDhcp.mockImplementationOnce(async () => 77);
    const error = await macNetworkStep
      .restore(CONFIG, PREVIOUS.dhcp, NO_PENDING)
      .then(() => null)
      .catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("(code 77)");
    expect(error?.message).toContain("Droits administrateur\u00a0?");
    expect(error?.message).toContain("«\u00a0AX88179A\u00a0»");
  });

  test("laisse passer une restauration acceptee", async () => {
    // Contre-epreuve : sans elle, un restore qui rejette toujours passerait
    // les tests ci-dessus.
    await macNetworkStep.restore(CONFIG, PREVIOUS.dhcp, NO_PENDING);
    expect(setDhcp).toHaveBeenCalledTimes(1);
  });
});
