import { test, expect, describe, mock, beforeEach } from "bun:test";
import type { ServiceIPConfig } from "../../src/lib/shell";
import { CONFIG } from "../../src/config";

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
});

describe("restore", () => {
  test("remet le service en DHCP si c'est ce qu'il etait", async () => {
    await macNetworkStep.restore(CONFIG, {
      mode: "dhcp",
      ip: null,
      subnetMask: null,
      router: null,
    });
    expect(setDhcp).toHaveBeenCalledTimes(1);
    expect(setManual).not.toHaveBeenCalled();
  });

  test("remet l'adresse manuelle d'origine si c'est ce qu'elle etait", async () => {
    await macNetworkStep.restore(CONFIG, {
      mode: "manual",
      ip: "192.168.5.5",
      subnetMask: "255.255.255.0",
      router: null,
    });
    expect(setManual).toHaveBeenCalledWith("AX88179A", "192.168.5.5", "255.255.255.0");
  });

  test("redesactive IPv4 si le service etait desactive avant l'installation", async () => {
    // Le remettre en DHCP serait deviner a la place de l'utilisateur.
    await macNetworkStep.restore(CONFIG, {
      mode: "off",
      ip: null,
      subnetMask: null,
      router: null,
    });
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
    });
    expect(setDhcp).toHaveBeenCalledTimes(1);
  });
});
