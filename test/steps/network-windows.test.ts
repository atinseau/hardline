import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";

let remoteState: unknown[];
const runRemote = mock(async (..._args: unknown[]) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../../src/lib/ssh", () => ({
  runRemoteJson: async () => remoteState,
  runRemote,
}));

const { windowsNetworkStep } = await import("../../src/steps/network-windows");

beforeEach(() => runRemote.mockClear());

describe("inspect", () => {
  test("declare conforme quand adresse et profil sont corrects", async () => {
    remoteState = [
      {
        adapterPresent: true,
        adapterStatus: "Up",
        addresses: ["10.10.10.1/24"],
        category: "Private",
      },
    ];
    const state = await windowsNetworkStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
  });

  test("declare non conforme quand le profil est public", async () => {
    // Cas le plus important : l'adresse est bonne mais le pare-feu est ferme.
    remoteState = [
      {
        adapterPresent: true,
        adapterStatus: "Up",
        addresses: ["10.10.10.1/24"],
        category: "Public",
      },
    ];
    expect((await windowsNetworkStep.inspect(CONFIG)).conforming).toBe(false);
  });

  test("declare non conforme quand l'adresse cible est absente", async () => {
    remoteState = [
      {
        adapterPresent: true,
        adapterStatus: "Up",
        addresses: ["169.254.168.1/16"],
        category: "Private",
      },
    ];
    expect((await windowsNetworkStep.inspect(CONFIG)).conforming).toBe(false);
  });

  test("tolere des adresses supplementaires si la cible est presente", async () => {
    remoteState = [
      {
        adapterPresent: true,
        adapterStatus: "Up",
        addresses: ["169.254.168.1/16", "10.10.10.1/24"],
        category: "Private",
      },
    ];
    expect((await windowsNetworkStep.inspect(CONFIG)).conforming).toBe(true);
  });

  test("echoue explicitement si l'interface n'existe pas", async () => {
    remoteState = [
      {
        adapterPresent: false,
        adapterStatus: null,
        addresses: [],
        category: null,
      },
    ];
    expect(windowsNetworkStep.inspect(CONFIG)).rejects.toThrow(/Ethernet/);
  });

  test("echoue explicitement si le PC ne repond rien", async () => {
    remoteState = [];
    expect(windowsNetworkStep.inspect(CONFIG)).rejects.toThrow();
  });
});

describe("apply", () => {
  test("envoie un script qui pose l'adresse et bascule le profil", async () => {
    await windowsNetworkStep.apply(CONFIG);
    expect(runRemote).toHaveBeenCalledTimes(1);
    const script = String((runRemote.mock.calls[0] as unknown[])[1]);
    expect(script).toContain("New-NetIPAddress");
    expect(script).toContain("10.10.10.1");
    expect(script).toContain("Set-NetConnectionProfile");
    expect(script).toContain("Private");
  });
});

describe("restore", () => {
  test("remet l'interface en DHCP et restitue la categorie d'origine", async () => {
    await windowsNetworkStep.restore(CONFIG, {
      adapterPresent: true,
      adapterStatus: "Up",
      addresses: [],
      category: "Public",
    });
    const script = String((runRemote.mock.calls[0] as unknown[])[1]);
    expect(script).toContain("Dhcp Enabled");
    expect(script).toContain("Public");
  });

  test("ne tente pas de restituer une categorie inconnue", async () => {
    await windowsNetworkStep.restore(CONFIG, {
      adapterPresent: true,
      adapterStatus: "Up",
      addresses: [],
      category: null,
    });
    const script = String((runRemote.mock.calls[0] as unknown[])[1]);
    expect(script).not.toContain("Set-NetConnectionProfile");
  });
});
