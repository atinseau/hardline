import { test, expect, describe, mock, beforeEach } from "bun:test";

/** Aucune etape ne suit : cette restauration est la derniere a passer. */
const NO_PENDING = { pending: [] as string[] };
import { CONFIG } from "../../src/config";
import type { WindowsNetworkState } from "../../src/steps/network-windows";

let remoteState: unknown[];
/** Ce que le PC repond : c'est lui qui choisit la branche de la queue. */
let remoteStdout = "";
const runRemoteChecked = mock(async (..._args: unknown[]) => ({
  exitCode: 0,
  stdout: remoteStdout,
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

beforeEach(() => {
  runRemoteChecked.mockClear();
  remoteStdout = "";
});

function scriptOf(call: number): string {
  return String((runRemoteChecked.mock.calls[call] as unknown[])[1]);
}

/**
 * $sshLocal doit etre affecte avant sa premiere lecture. Une simple assertion
 * de presence laisserait passer l'affectation deplacee apres son usage : la
 * comparaison serait alors faite contre $null, l'adresse de la session serait
 * traitee comme n'importe quelle autre, et le script la supprimerait.
 */
function sshLocalIsAssignedBeforeUse(script: string): boolean {
  const assignment = script.indexOf("$sshLocal = ");
  const firstUse = script.search(/\$sshLocal(?!\s*=)/);
  return assignment >= 0 && firstUse >= 0 && assignment < firstUse;
}

/**
 * La branche EXECUTEE EN LIGNE de la queue : celle qui suit le "} else {" de
 * la garde sur $sshLocal.
 *
 * Elle est designee par sa garde, et non par sa position : un `split` sur
 * "} else {" suivi d'un `pop` prenait le DERNIER else du script, quel qu'il
 * soit. La repose d'adresses en emet deja un, et il suffisait qu'une instruction
 * en ajoute un apres pour que ces tests changent silencieusement de sujet.
 */
function inlineBranch(script: string): string {
  const garde = script.indexOf("if ($sshLocal -eq ");
  expect(garde).toBeGreaterThanOrEqual(0);
  const branche = script.indexOf("} else {", garde);
  expect(branche).toBeGreaterThan(garde);
  return script.slice(branche + "} else {".length);
}

/** La ligne du processus detache, seule ligne ou les $ doivent etre echappes. */
function detachedLine(script: string): string {
  const line = script
    .split("\n")
    .find((candidate) => candidate.includes("Start-Process powershell"));
  expect(line).toBeDefined();
  return line as string;
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
    // Lue apres avoir servi, la variable vaut $null et le filtre ne protege
    // plus rien : l'ordre est la substance de ce test.
    expect(sshLocalIsAssignedBeforeUse(script)).toBe(true);
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
    }, NO_PENDING);
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
    }, NO_PENDING);
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
    }, NO_PENDING);
    expect(scriptOf(0)).toMatch(
      /Set-NetConnectionProfile[^\n]*-InterfaceAlias 'Ethernet'[^\n]*Public/,
    );
  });

  test("ne tente pas de restituer une categorie inconnue", async () => {
    await windowsNetworkStep.restore(CONFIG, {
      ...CONFORME,
      dhcpEnabled: true,
      category: null,
    }, NO_PENDING);
    expect(scriptOf(0)).not.toContain("Set-NetConnectionProfile");
  });

  test("propage l'echec d'une commande distante", async () => {
    runRemoteChecked.mockImplementationOnce(async () => {
      throw new Error("acces refuse");
    });
    await expect(
      windowsNetworkStep.restore(CONFIG, { ...CONFORME, dhcpEnabled: true }, NO_PENDING),
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
      }, NO_PENDING),
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
    }, NO_PENDING);
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

  test("retablit l'etat anterieur avant tout ce qui peut couper le canal", async () => {
    await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE, NO_PENDING);
    const script = scriptOf(0);

    const cut = script.indexOf("$sshLocal");
    expect(cut).toBeGreaterThan(0);
    expect(script.indexOf("-IPAddress '192.168.1.48'")).toBeLessThan(cut);
    expect(script.indexOf("-Dhcp Enabled")).toBeLessThan(cut);
    expect(script.indexOf("Remove-NetIPAddress")).toBeGreaterThan(cut);
    expect(script.indexOf("-NetworkCategory Public")).toBeGreaterThan(cut);
  });

  test("repose les adresses enregistrees avant de rallumer le DHCP", async () => {
    // Sinon l'invariant repose sur une affirmation non verifiee : que
    // -Dhcp Enabled laisse les adresses Manual en place.
    await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE, NO_PENDING);
    const script = scriptOf(0);
    expect(script.indexOf("-IPAddress '192.168.1.48'")).toBeLessThan(
      script.indexOf("-Dhcp Enabled"),
    );
  });

  test("corrige le prefixe d'une adresse anterieure encore presente", async () => {
    // Meme traitement que dans apply : on corrige sur place, on ne retire pas
    // pour reposer.
    await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE, NO_PENDING);
    const script = scriptOf(0);
    expect(script).toMatch(
      /if \(\$prev\.PrefixLength -ne 24\)[\s\S]{0,140}Set-NetIPAddress[^\n]*-IPAddress '192\.168\.1\.48'[^\n]*-PrefixLength 24/,
    );
  });

  test("ne flippe jamais le profil avant d'avoir retire l'adresse", async () => {
    // La regle de pare-feu qui ouvre le port 22 est portee par le profil
    // Private, et la tache de maintien vient d'etre supprimee : passer le
    // profil en Public tue la session a cette instruction meme. Tout ce qui
    // suivrait — le retrait de 10.10.10.1 — ne serait jamais execute.
    await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE, NO_PENDING);
    const script = scriptOf(0);
    expect(script.indexOf("-NetworkCategory Public")).toBeGreaterThan(
      script.indexOf("Remove-NetIPAddress"),
    );
  });

  test("retrait et profil partent ensemble dans la queue detachee", async () => {
    await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE, NO_PENDING);
    const line = detachedLine(scriptOf(0));

    expect(line).toContain("Start-Sleep -Seconds 2");
    expect(line.indexOf("Remove-NetIPAddress")).toBeGreaterThan(0);
    expect(line.indexOf("-NetworkCategory Public")).toBeGreaterThan(
      line.indexOf("Remove-NetIPAddress"),
    );
  });

  test("detache la queue quand elle couperait la session en cours", async () => {
    // Executee en ligne, elle tuerait la commande SSH : runRemoteChecked
    // remonterait un echec pour une restauration pourtant reussie, et
    // l'orchestrateur garderait l'entree de manifeste.
    await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE, NO_PENDING);
    const script = scriptOf(0);

    expect(script).toContain("Get-NetTCPConnection -LocalPort 22");
    expect(script).toMatch(/if \(\$sshLocal -eq '10\.10\.10\.1'\)/);
    expect(sshLocalIsAssignedBeforeUse(script)).toBe(true);
  });

  test("echappe les $ confies au processus detache", async () => {
    // Sans le backtick, le shell appelant developpe $false en chaine vide et
    // Remove-NetIPAddress reclame une confirmation que personne ne donnera.
    const line = detachedLine((await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE, NO_PENDING), scriptOf(0)));

    expect(line).toContain("-Confirm:`$false");
    expect(line).not.toContain("-Confirm:$false");
  });

  test("n'echappe pas les $ de la branche executee en ligne", async () => {
    // Contre-epreuve de l'assertion precedente : le backtick est une exigence
    // du seul chemin detache, pas une decoration a semer partout.
    await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE, NO_PENDING);
    const inline = inlineBranch(scriptOf(0));
    expect(inline).toContain("-Confirm:$false");
    expect(inline).not.toContain("-Confirm:`$false");
  });

  test("execute la queue en ligne quand la session n'utilise pas l'adresse", async () => {
    await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE, NO_PENDING);
    const inline = inlineBranch(scriptOf(0));
    expect(inline).toContain(
      "Remove-NetIPAddress -InterfaceAlias 'Ethernet' -IPAddress '10.10.10.1'",
    );
    expect(inline).toContain("-NetworkCategory Public");
    expect(inline).not.toContain("Start-Process");
  });

  test("n'ecrit aucune instruction de profil pour DomainAuthenticated", async () => {
    // Set-NetConnectionProfile n'accepte que Public et Private :
    // DomainAuthenticated est une erreur de liaison de parametre, que
    // -ErrorAction SilentlyContinue ne peut pas etouffer. L'uninstall
    // echouait a tous les coups sur un PC joint a un domaine.
    await windowsNetworkStep.restore(CONFIG, {
      ...SANS_NOTRE_ADRESSE,
      category: "DomainAuthenticated",
    }, NO_PENDING);
    const script = scriptOf(0);
    expect(script).not.toContain("Set-NetConnectionProfile");
    expect(script).not.toContain("DomainAuthenticated");
    // Le reste de la restauration a bien lieu.
    expect(script).toContain("Remove-NetIPAddress");
    expect(script).toContain("-Dhcp Enabled");
  });

  test("ne retire pas une adresse que le PC portait deja avant hardline", async () => {
    await windowsNetworkStep.restore(CONFIG, {
      ...CONFORME,
      addresses: ["10.10.10.1/24"],
      manualAddresses: ["10.10.10.1/24"],
      dhcpEnabled: false,
      category: "Private",
    }, NO_PENDING);
    expect(scriptOf(0)).not.toContain("Remove-NetIPAddress");
  });

  test("n'emet aucune queue quand il n'y a rien a couper", async () => {
    // L'adresse cible preexistait a hardline (rien a retirer) et la categorie
    // n'est pas assignable (rien a reposer). La queue est vide. L'emettre quand
    // meme lancerait un processus detache pour ne rien faire, et la garde sur
    // $sshLocal annoncerait une coupure qui n'aura pas lieu.
    await windowsNetworkStep.restore(CONFIG, {
      ...CONFORME,
      addresses: ["10.10.10.1/24"],
      manualAddresses: ["10.10.10.1/24"],
      dhcpEnabled: true,
      category: "DomainAuthenticated",
    }, NO_PENDING);
    const script = scriptOf(0);

    expect(script).not.toContain("Start-Process");
    expect(script).not.toContain("$sshLocal");
    expect(script).not.toContain("Get-NetTCPConnection");
    // Et la moitie non coupante est bien emise : l'etape a fait son travail.
    expect(script).toContain("-Dhcp Enabled");
    expect(script).toContain("-IPAddress '10.10.10.1'");
  });

  test("annonce la branche empruntee, des deux cotes de la garde", async () => {
    // Le Mac ne peut pas deviner sur quelle adresse roulait la session : c'est
    // le PC qui tranche, a l'execution. Sans ce mot dans le script, l'etape
    // devrait supposer le pire dans les deux cas.
    await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE, NO_PENDING);
    const script = scriptOf(0);
    expect(detachedLine(script)).toBeDefined();
    expect(script).toContain("Write-Output 'hardline:queue-detachee'");
    expect(inlineBranch(script)).toContain("Write-Output 'hardline:queue-en-ligne'");
  });

  test("se declare lancee, non restauree, quand le PC a detache la queue", async () => {
    remoteStdout = "hardline:queue-detachee\n";
    const outcome = await windowsNetworkStep.restore(
      CONFIG,
      SANS_NOTRE_ADRESSE,
      NO_PENDING,
    );
    expect(outcome).toEqual({
      detached:
        "retrait de l'adresse et retour du profil confiés à un processus détaché sur le PC",
    });
  });

  test("ne se declare pas lancee quand le PC a tout fait en ligne", async () => {
    // Le controle. Cette branche est verifiee par le code de retour de la
    // session : elle est OBSERVEE, et la rapporter comme incertaine ferait
    // garder au manifeste un enregistrement dont on n'a plus besoin.
    remoteStdout = "hardline:queue-en-ligne\n";
    expect(
      await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE, NO_PENDING),
    ).toBeUndefined();
  });

  test("ne supprime jamais en bloc les adresses de l'interface", async () => {
    // La forme fautive : un Get-NetIPAddress sans filtre pipe dans
    // Remove-NetIPAddress, qui emporte l'adresse de la session SSH.
    await windowsNetworkStep.restore(CONFIG, SANS_NOTRE_ADRESSE, NO_PENDING);
    expect(scriptOf(0)).not.toMatch(
      /Get-NetIPAddress[^|]*\|\s*\n?\s*Remove-NetIPAddress/,
    );
  });
});
