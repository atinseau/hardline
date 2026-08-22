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

  test("pose l'adresse cible AVANT de retirer quoi que ce soit", async () => {
    // Le defaut le plus grave du programme etait ici : apply commencait par
    // supprimer toutes les adresses IPv4 de l'interface, dont 10.10.10.1 qui
    // porte la session SSH. Windows coupait la connexion, sshd tuait le
    // processus, et New-NetIPAddress n'etait jamais atteint : le PC restait
    // sans aucune adresse sur le lien direct.
    await windowsNetworkStep.apply(CONFIG);
    const script = scriptOf(0);

    const created = script.indexOf("New-NetIPAddress");
    const removed = script.indexOf("Remove-NetIPAddress");
    const dhcpOff = script.indexOf("-Dhcp Disabled");

    expect(created).toBeGreaterThanOrEqual(0);
    expect(removed).toBeGreaterThan(created);
    expect(dhcpOff).toBeGreaterThan(created);
  });

  test("desactive le client DHCP, apres avoir pose l'adresse", async () => {
    // Sinon l'interface conserve une adresse APIPA a cote de la notre.
    await windowsNetworkStep.apply(CONFIG);
    expect(scriptOf(0)).toContain("-Dhcp Disabled");
  });

  test("epargne l'adresse qui porte la session SSH lors du menage", async () => {
    // Le filtre est auto-corrigeant : des que la session roule sur l'adresse
    // cible, l'exception coincide avec elle et tout le reste est nettoye.
    await windowsNetworkStep.apply(CONFIG);
    const script = scriptOf(0);

    expect(script).toContain("Get-NetTCPConnection -LocalPort 22");
    expect(script).toMatch(/\$_\.IPAddress -ne \$sshLocal/);
    expect(script).toMatch(/\$_\.IPAddress -ne '10\.10\.10\.1'/);
  });

  test("ne recree pas une adresse cible deja presente", async () => {
    // New-NetIPAddress sur une adresse existante leve, et $ErrorActionPreference
    // vaut 'Stop' cote runRemoteChecked : apply doit rester idempotent.
    await windowsNetworkStep.apply(CONFIG);
    const script = scriptOf(0);
    expect(script).toMatch(
      /Get-NetIPAddress[^\n]*-IPAddress '10\.10\.10\.1'[^\n]*SilentlyContinue/,
    );
    expect(script).toContain("} else {");
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
    await expect(
      windowsNetworkStep.restore(CONFIG, { ...CONFORME, dhcpEnabled: true }),
    ).rejects.toThrow("acces refuse");
  });

  test("n'avale pas un code de retour non nul", async () => {
    // runRemoteChecked leve sur code non nul ; restore ne doit ni le rattraper
    // ni retomber sur runRemote. Sans quoi l'orchestrateur appelle forgetStep
    // sur une restauration qui n'a pas eu lieu.
    runRemoteChecked.mockImplementationOnce(async () => {
      throw new Error("Commande distante en echec (code 1) : Access is denied");
    });
    await expect(
      windowsNetworkStep.restore(CONFIG, {
        ...CONFORME,
        addresses: [],
        manualAddresses: [],
        dhcpEnabled: true,
      }),
    ).rejects.toThrow(/code 1/);
  });

  test("rend les adresses manuelles ET le DHCP quand les deux etaient actifs", async () => {
    // Windows accepte les deux en meme temps : ne rendre que le DHCP jetait
    // les adresses fixes que la machine portait avant hardline.
    await windowsNetworkStep.restore(CONFIG, {
      ...CONFORME,
      addresses: ["192.168.1.48/24", "10.10.10.1/24"],
      manualAddresses: ["192.168.1.48/24"],
      dhcpEnabled: true,
      category: "Public",
    });
    const script = scriptOf(0);
    expect(script).toContain("-Dhcp Enabled");
    expect(script).toContain("-IPAddress '192.168.1.48'");
    expect(script).toContain("-PrefixLength 24");
  });
});

// L'invariant que ces tests protegent : a aucun instant le PC ne doit se
// retrouver sans son adressage anterieur NI celui de hardline. Toute
// interruption — coupure de session, echec d'une commande — doit le laisser
// joignable sur l'un des deux.
describe("restore, ordre des operations", () => {
  const SANS_NOTRE_ADRESSE = {
    ...CONFORME,
    addresses: ["192.168.1.48/24"],
    manualAddresses: ["192.168.1.48/24"],
    dhcpEnabled: true,
    category: "Public" as const,
  };

  test("retablit l'etat anterieur avant de retirer l'adresse de hardline", async () => {
    await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE);
    const script = scriptOf(0);

    const drop = script.indexOf("Remove-NetIPAddress");
    expect(drop).toBeGreaterThan(0);
    expect(script.indexOf("-Dhcp Enabled")).toBeLessThan(drop);
    expect(script.indexOf("-IPAddress '192.168.1.48'")).toBeLessThan(drop);
    expect(script.indexOf("-NetworkCategory Public")).toBeLessThan(drop);
  });

  test("detache le retrait quand il couperait la session en cours", async () => {
    // Retire en ligne, ce retrait tuerait la commande SSH : runRemoteChecked
    // remonterait un echec pour une restauration pourtant reussie, et
    // l'orchestrateur garderait l'entree de manifeste.
    await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE);
    const script = scriptOf(0);

    expect(script).toContain("Get-NetTCPConnection -LocalPort 22");
    expect(script).toMatch(/if \(\$sshLocal -eq '10\.10\.10\.1'\)/);
    expect(script).toContain("Start-Process powershell");
    expect(script).toContain("Start-Sleep -Seconds 2");
  });

  test("retire l'adresse de hardline en ligne quand la session ne l'utilise pas", async () => {
    await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE);
    const script = scriptOf(0);
    const branches = script.split("} else {");
    expect(branches).toHaveLength(2);
    expect(branches[1]).toContain(
      "Remove-NetIPAddress -InterfaceAlias 'Ethernet' -IPAddress '10.10.10.1'",
    );
  });

  test("ne retire pas une adresse que le PC portait deja avant hardline", async () => {
    await windowsNetworkStep.restore(CONFIG, {
      ...CONFORME,
      addresses: ["10.10.10.1/24"],
      manualAddresses: ["10.10.10.1/24"],
      dhcpEnabled: false,
      category: "Private",
    });
    expect(scriptOf(0)).not.toContain("Remove-NetIPAddress");
  });

  test("ne supprime jamais en bloc les adresses de l'interface", async () => {
    // La forme fautive : un Get-NetIPAddress sans filtre pipe dans
    // Remove-NetIPAddress, qui emporte l'adresse de la session SSH.
    await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE);
    expect(scriptOf(0)).not.toMatch(
      /Get-NetIPAddress[^|]*\|\s*\n?\s*Remove-NetIPAddress/,
    );
  });
});
