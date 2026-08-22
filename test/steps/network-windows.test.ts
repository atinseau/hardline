import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";
import type { WindowsNetworkState } from "../../src/steps/network-windows";

let remoteState: unknown[];
const runRemoteChecked = mock(async (..._args: unknown[]) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../../src/lib/ssh", () => ({
  runRemoteJson: async () => remoteState,
  runRemoteChecked,
}));

const { windowsNetworkStep } = await import("../../src/steps/network-windows");

const CONFORME: WindowsNetworkState = {
  adapterPresent: true,
  adapterStatus: "Up",
  addresses: ["10.10.10.1/24"],
  manualAddresses: ["10.10.10.1/24"],
  dhcpEnabled: false,
  category: "Private",
};

beforeEach(() => runRemoteChecked.mockClear());

function scriptOf(call: number): string {
  return String((runRemoteChecked.mock.calls[call] as unknown[])[1]);
}

describe("inspect", () => {
  test("declare conforme quand adresse et profil sont corrects", async () => {
    remoteState = [CONFORME];
    expect((await windowsNetworkStep.inspect(CONFIG)).conforming).toBe(true);
  });

  test("declare non conforme quand le profil est public", async () => {
    // Cas le plus important : l'adresse est bonne mais le pare-feu est ferme.
    remoteState = [{ ...CONFORME, category: "Public" }];
    expect((await windowsNetworkStep.inspect(CONFIG)).conforming).toBe(false);
  });

  test("declare non conforme quand l'adresse cible est absente", async () => {
    remoteState = [
      { ...CONFORME, addresses: ["169.254.168.1/16"], manualAddresses: [] },
    ];
    expect((await windowsNetworkStep.inspect(CONFIG)).conforming).toBe(false);
  });

  test("tolere des adresses supplementaires si la cible est presente", async () => {
    remoteState = [
      { ...CONFORME, addresses: ["169.254.168.1/16", "10.10.10.1/24"] },
    ];
    expect((await windowsNetworkStep.inspect(CONFIG)).conforming).toBe(true);
  });

  test("declare non conforme quand le client DHCP est reste actif", async () => {
    remoteState = [{ ...CONFORME, dhcpEnabled: true }];
    expect((await windowsNetworkStep.inspect(CONFIG)).conforming).toBe(false);
  });

  test("conserve l'etat anterieur complet pour la restauration", async () => {
    remoteState = [
      {
        adapterPresent: true,
        adapterStatus: "Up",
        addresses: ["192.168.1.48/24"],
        manualAddresses: [],
        dhcpEnabled: true,
        category: "Public",
      },
    ];
    const state = await windowsNetworkStep.inspect(CONFIG);
    expect(state.current.dhcpEnabled).toBe(true);
    expect(state.current.manualAddresses).toEqual([]);
    expect(state.current.category).toBe("Public");
  });

  test("echoue explicitement si l'interface n'existe pas", async () => {
    remoteState = [
      {
        adapterPresent: false,
        adapterStatus: null,
        addresses: [],
        manualAddresses: [],
        dhcpEnabled: false,
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
  test("pose l'adresse cible avec le bon prefixe sur la bonne interface", async () => {
    await windowsNetworkStep.apply(CONFIG);
    expect(runRemoteChecked).toHaveBeenCalledTimes(1);
    const script = scriptOf(0);
    expect(script).toContain("New-NetIPAddress");
    expect(script).toContain("-InterfaceAlias 'Ethernet'");
    expect(script).toContain("-IPAddress '10.10.10.1'");
    expect(script).toContain("-PrefixLength 24");
  });

  test("desactive le client DHCP avant de poser l'adresse", async () => {
    // Sinon l'interface conserve une adresse APIPA a cote de la notre.
    await windowsNetworkStep.apply(CONFIG);
    const script = scriptOf(0);
    expect(script).toContain("-Dhcp Disabled");
    expect(script.indexOf("-Dhcp Disabled")).toBeLessThan(
      script.indexOf("New-NetIPAddress"),
    );
  });

  test("bascule le profil en prive dans le meme script", async () => {
    const script = (await windowsNetworkStep.apply(CONFIG), scriptOf(0));
    expect(script).toMatch(
      /Set-NetConnectionProfile[^\n]*-InterfaceAlias 'Ethernet'[^\n]*Private/,
    );
  });

  test("propage l'echec d'une commande distante", async () => {
    runRemoteChecked.mockImplementationOnce(async () => {
      throw new Error("acces refuse");
    });
    expect(windowsNetworkStep.apply(CONFIG)).rejects.toThrow("acces refuse");
  });
});

describe("restore", () => {
  test("reactive le DHCP si l'interface etait en DHCP", async () => {
    await windowsNetworkStep.restore(CONFIG, {
      ...CONFORME,
      addresses: [],
      manualAddresses: [],
      dhcpEnabled: true,
      category: "Public",
    });
    const script = scriptOf(0);
    expect(script).toContain("-Dhcp Enabled");
    expect(script).not.toContain("-Dhcp Disabled");
  });

  test("rend une adresse statique preexistante au lieu de basculer en DHCP", async () => {
    // Le PC pouvait porter une IP fixe avant hardline : la remplacer par du
    // DHCP serait deviner, pas restaurer.
    await windowsNetworkStep.restore(CONFIG, {
      ...CONFORME,
      addresses: ["192.168.50.10/24"],
      manualAddresses: ["192.168.50.10/24"],
      dhcpEnabled: false,
      category: "Private",
    });
    const script = scriptOf(0);
    expect(script).toContain("-IPAddress '192.168.50.10'");
    expect(script).toContain("-PrefixLength 24");
    expect(script).not.toContain("-Dhcp Enabled");
  });

  test("restitue la categorie reseau d'origine", async () => {
    await windowsNetworkStep.restore(CONFIG, {
      ...CONFORME,
      dhcpEnabled: true,
      category: "Public",
    });
    expect(scriptOf(0)).toMatch(
      /Set-NetConnectionProfile[^\n]*-InterfaceAlias 'Ethernet'[^\n]*Public/,
    );
  });

  test("ne tente pas de restituer une categorie inconnue", async () => {
    await windowsNetworkStep.restore(CONFIG, {
      ...CONFORME,
      dhcpEnabled: true,
      category: null,
    });
    expect(scriptOf(0)).not.toContain("Set-NetConnectionProfile");
  });

  test("propage l'echec d'une commande distante", async () => {
    runRemoteChecked.mockImplementationOnce(async () => {
      throw new Error("acces refuse");
    });
    expect(
      windowsNetworkStep.restore(CONFIG, { ...CONFORME, dhcpEnabled: true }),
    ).rejects.toThrow("acces refuse");
  });
});
