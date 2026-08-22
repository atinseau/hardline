import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";
import type {
  BootstrapCapture,
  BootstrapState,
} from "../../src/steps/bootstrap-windows";

let remoteState: unknown[];
let inspectScript = "";
const runRemoteChecked = mock(async (..._args: unknown[]) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../../src/lib/ssh", () => ({
  runRemoteJson: async (_target: unknown, script: string) => {
    inspectScript = script;
    return remoteState;
  },
  runRemoteChecked,
}));

const { bootstrapWindowsStep } = await import(
  "../../src/steps/bootstrap-windows"
);

const KEY_PATH = "C:\\ProgramData\\ssh\\administrators_authorized_keys";
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1 arthur@mac";
const SDDL = "O:BAG:SYD:P(A;;FA;;;BA)(A;;FA;;;SY)";

/**
 * Le cas du PC de bureau : un lien Ethernet qui portait deja une adresse fixe
 * de reseau local, pas de serveur SSH, pas de regle de pare-feu, pas de fichier
 * de cles. Tout ce que l'amorcage touche, il l'a donc cree ou remplace.
 */
const CAPTURE: BootstrapCapture = {
  version: 1,
  capturedAt: "2026-08-22T09:00:00",
  interfaceAlias: "Ethernet",
  capability: { name: "OpenSSH.Server~~~~0.0.1.0", state: "NotPresent", changed: true },
  sshd: {
    present: false,
    startupType: null,
    status: null,
    startupChanged: true,
    statusChanged: true,
  },
  firewall: { name: "hardline-sshd", existed: false, changed: true },
  authorizedKeys: {
    path: KEY_PATH,
    publicKey: PUBLIC_KEY,
    fileExisted: false,
    keyPresent: false,
    aclSddl: null,
    changed: true,
    aclChanged: false,
  },
  network: {
    addresses: ["192.168.1.50/24"],
    manualAddresses: ["192.168.1.50/24"],
    dhcp: "Disabled",
    category: "Public",
    addressingChanged: true,
    categoryChanged: true,
  },
};

const capture = (patch: Partial<BootstrapCapture>): BootstrapCapture => ({
  ...CAPTURE,
  ...patch,
});

beforeEach(() => {
  runRemoteChecked.mockClear();
  remoteState = [];
});

function scriptOf(call: number): string {
  return String((runRemoteChecked.mock.calls[call] as unknown[])[1]);
}

/** La ligne du processus detache : tout ce qui peut couper le canal y vit. */
function detachedLine(script: string): string {
  const line = script
    .split("\n")
    .find((candidate) => candidate.includes("Start-Process powershell"));
  expect(line).toBeDefined();
  return line as string;
}

/** Ce qui reste du script une fois la queue detachee retiree. */
function inSession(script: string): string {
  return script
    .split("\n")
    .filter((line) => !line.includes("Start-Process powershell"))
    .join("\n");
}

async function restoreWith(patch: Partial<BootstrapCapture>): Promise<string> {
  await bootstrapWindowsStep.restore(CONFIG, {
    capture: capture(patch),
    acknowledged: true,
  });
  return scriptOf(0);
}

describe("inspect", () => {
  test("est non conforme tant que le releve n'est pas acquitte", async () => {
    // Sinon applySteps ne l'enregistre jamais : il n'enregistre que ce qu'il
    // applique reellement. Une etape toujours conforme n'entrerait jamais
    // dans le manifeste, et le releve resterait sur le PC sans copie.
    remoteState = [{ capture: CAPTURE, acknowledged: false }];
    const state = await bootstrapWindowsStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
  });

  test("devient conforme une fois le releve acquitte", async () => {
    remoteState = [{ capture: CAPTURE, acknowledged: true }];
    expect((await bootstrapWindowsStep.inspect(CONFIG)).conforming).toBe(true);
  });

  test("emporte le releve entier dans le manifeste", async () => {
    remoteState = [{ capture: CAPTURE, acknowledged: false }];
    const state = await bootstrapWindowsStep.inspect(CONFIG);
    expect(state.current.capture).toEqual(CAPTURE);
  });

  test("ne bloque pas l'installation quand le PC n'a aucun releve", async () => {
    // Un PC amorce par une version anterieure de hardline. Bloquer ici
    // interdirait toute installation sur une machine deja amorcee.
    remoteState = [{ capture: null, acknowledged: false }];
    const state = await bootstrapWindowsStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
  });

  test("dit franchement qu'il n'y a rien a defaire, au lieu d'inventer", async () => {
    remoteState = [{ capture: null, acknowledged: false }];
    const state = await bootstrapWindowsStep.inspect(CONFIG);
    expect(state.current.capture).toBeNull();
    expect(state.detail).toContain("aucun relevé");
    expect(state.detail).toContain("ne pourra pas être défait");
  });

  test("lit le releve la ou l'amorcage l'ecrit, sans rien modifier", async () => {
    remoteState = [{ capture: null, acknowledged: false }];
    await bootstrapWindowsStep.inspect(CONFIG);

    expect(inspectScript).toContain(
      "(Join-Path (Join-Path $env:ProgramData 'hardline') 'bootstrap-state.json')",
    );
    expect(inspectScript).toContain("bootstrap-state.acknowledged");
    expect(inspectScript).toContain("ConvertFrom-Json");
    // inspect n'a pas le droit d'ecrire : c'est apply qui acquitte.
    expect(inspectScript).not.toContain("Set-Content");
    expect(inspectScript).not.toContain("New-Item");
    expect(inspectScript).not.toContain("Remove-Item");
  });

  test("echoue explicitement si le PC ne repond rien", async () => {
    remoteState = [];
    expect(bootstrapWindowsStep.inspect(CONFIG)).rejects.toThrow(/amorçage/);
  });
});

describe("apply", () => {
  test("ne fait qu'acquitter : il ne modifie rien du PC", async () => {
    await bootstrapWindowsStep.apply(CONFIG);
    const script = scriptOf(0);
    expect(script).toContain("bootstrap-state.acknowledged");
    // Aucun des gestes de l'amorcage n'est rejoue, ni defait.
    expect(script).not.toContain("Set-Service");
    expect(script).not.toContain("NetIPAddress");
    expect(script).not.toContain("NetFirewallRule");
    expect(script).not.toContain("NetConnectionProfile");
  });

  test("n'ecrit jamais par-dessus le releve lui-meme", async () => {
    // Le releve est la seule description du PC d'avant hardline.
    await bootstrapWindowsStep.apply(CONFIG);
    expect(scriptOf(0)).not.toContain("bootstrap-state.json");
  });

  test("cree le repertoire s'il manque, et reste rejouable", async () => {
    await bootstrapWindowsStep.apply(CONFIG);
    const script = scriptOf(0);
    expect(script).toContain("New-Item -ItemType Directory");
    // Set-Content ecrase, Add-Content accumulerait : rejouer install ne doit
    // pas empiler les accuses de reception.
    expect(script).toContain("Set-Content");
    expect(script).not.toContain("Add-Content");
  });

  test("propage l'echec d'une commande distante", async () => {
    runRemoteChecked.mockImplementationOnce(async () => {
      throw new Error("acces refuse");
    });
    expect(bootstrapWindowsStep.apply(CONFIG)).rejects.toThrow("acces refuse");
  });
});

describe("restore, ce qui est defait et ce qui ne l'est pas", () => {
  test("ne parle pas au PC quand aucun releve n'a ete enregistre", async () => {
    const previous: BootstrapState = { capture: null, acknowledged: true };
    await bootstrapWindowsStep.restore(CONFIG, previous);
    expect(runRemoteChecked).not.toHaveBeenCalled();
  });

  test("rend l'adressage d'avant amorcage", async () => {
    const script = await restoreWith({});
    expect(script).toContain("-IPAddress '192.168.1.50'");
    expect(script).toContain("-PrefixLength 24");
  });

  test("retire l'adresse posee par l'amorcage", async () => {
    const script = await restoreWith({});
    expect(script).toMatch(
      /Remove-NetIPAddress[^;]*-IPAddress '10\.10\.10\.1'/,
    );
  });

  test("ne touche pas a une adresse que le PC portait deja", async () => {
    // addressingChanged = false : l'amorcage a trouve 10.10.10.1 en place et
    // n'a rien change. La retirer serait detruire l'etat anterieur.
    const script = await restoreWith({
      network: { ...CAPTURE.network, addressingChanged: false },
    });
    expect(script).not.toContain("Remove-NetIPAddress");
    expect(script).not.toContain("New-NetIPAddress");
  });

  test("rallume le client DHCP quand il etait allume", async () => {
    const script = await restoreWith({
      network: {
        ...CAPTURE.network,
        addresses: [],
        manualAddresses: [],
        dhcp: "Enabled",
      },
    });
    expect(script).toContain("-Dhcp Enabled");
  });

  test("ne rallume pas un client DHCP qui etait eteint", async () => {
    expect(await restoreWith({})).not.toContain("-Dhcp Enabled");
  });

  test("rend la categorie reseau d'origine", async () => {
    expect(await restoreWith({})).toMatch(
      /Set-NetConnectionProfile[^;]*-NetworkCategory Public/,
    );
  });

  test("ne rend pas une categorie que l'amorcage n'a pas changee", async () => {
    const script = await restoreWith({
      network: { ...CAPTURE.network, category: "Private", categoryChanged: false },
    });
    expect(script).not.toContain("Set-NetConnectionProfile");
  });

  test("n'ecrit aucune instruction de profil pour DomainAuthenticated", async () => {
    // Valeur que Set-NetConnectionProfile refuse a la liaison de parametre, et
    // qu'aucun -ErrorAction ne peut etouffer.
    const script = await restoreWith({
      network: { ...CAPTURE.network, category: "DomainAuthenticated" },
    });
    expect(script).not.toContain("Set-NetConnectionProfile");
    expect(script).not.toContain("DomainAuthenticated");
    // Le reste de la restauration a bien lieu.
    expect(script).toContain("Remove-NetIPAddress");
    expect(script).toContain("Remove-NetFirewallRule");
  });

  test("supprime la regle de pare-feu creee par l'amorcage", async () => {
    expect(await restoreWith({})).toContain(
      "Remove-NetFirewallRule -Name 'hardline-sshd'",
    );
  });

  test("epargne une regle homonyme preexistante", async () => {
    const script = await restoreWith({
      firewall: { name: "hardline-sshd", existed: true, changed: false },
    });
    expect(script).not.toContain("Remove-NetFirewallRule");
  });

  test("supprime le fichier de cles que l'amorcage avait cree", async () => {
    const script = await restoreWith({});
    expect(script).toContain(`Remove-Item -Path '${KEY_PATH}'`);
    // Rien a reecrire ni a re-permissionner : le fichier n'existe plus.
    expect(script).not.toContain("Set-Acl");
    expect(script).not.toContain(`Set-Content -Path '${KEY_PATH}'`);
  });

  test("retire la seule ligne du Mac d'un fichier de cles preexistant", async () => {
    // Un compte administrateur peut y avoir d'autres cles : emporter le
    // fichier entier couperait l'acces de quelqu'un d'autre.
    const script = await restoreWith({
      authorizedKeys: {
        ...CAPTURE.authorizedKeys,
        fileExisted: true,
        aclSddl: SDDL,
        aclChanged: true,
      },
    });
    expect(script).not.toContain(`Remove-Item -Path '${KEY_PATH}'`);
    expect(script).toContain(`Get-Content -Path '${KEY_PATH}'`);
    expect(script).toContain(`-ne '${PUBLIC_KEY}'`);
  });

  test("reecrit le fichier de cles en ascii, jamais en utf8", async () => {
    // Add-Content -Encoding utf8 pose une marque d'ordre des octets qui rend
    // le fichier silencieusement illisible pour OpenSSH.
    const script = await restoreWith({
      authorizedKeys: {
        ...CAPTURE.authorizedKeys,
        fileExisted: true,
        aclSddl: SDDL,
        aclChanged: true,
      },
    });
    expect(script).toMatch(
      new RegExp(`Set-Content[^;]*${KEY_PATH.replaceAll("\\", "\\\\")}[^;]*-Encoding ascii`),
    );
    expect(script).not.toContain("-Encoding utf8");
  });

  test("laisse la cle d'un fichier ou elle etait deja, mais rend les droits", async () => {
    // keyPresent : l'amorcage n'a pas ajoute la ligne, il n'a donc pas a la
    // retirer. icacls a en revanche bien reecrit les droits du fichier.
    const script = await restoreWith({
      authorizedKeys: {
        ...CAPTURE.authorizedKeys,
        fileExisted: true,
        keyPresent: true,
        changed: false,
        aclSddl: SDDL,
        aclChanged: true,
      },
    });
    expect(script).not.toContain("Get-Content");
    expect(script).toContain(`SetSecurityDescriptorSddlForm('${SDDL}')`);
    expect(script).toContain("Set-Acl");
  });

  test("rend a sshd son type de demarrage d'origine", async () => {
    const script = await restoreWith({
      sshd: {
        present: true,
        startupType: "Manual",
        status: "Stopped",
        startupChanged: true,
        statusChanged: true,
      },
    });
    expect(script).toContain("Set-Service -Name sshd -StartupType Manual");
  });

  test("desactive sshd quand le PC n'avait aucun service sshd", async () => {
    // Le releve n'a pas de type de demarrage a rendre. Laisser le service en
    // Automatic reviendrait a laisser en ecoute permanente un serveur SSH que
    // la machine n'avait pas.
    const script = await restoreWith({});
    expect(script).toContain("Set-Service -Name sshd -StartupType Disabled");
  });

  test("ne touche pas au demarrage de sshd s'il etait deja Automatic", async () => {
    const script = await restoreWith({
      sshd: {
        present: true,
        startupType: "Automatic",
        status: "Running",
        startupChanged: false,
        statusChanged: false,
      },
    });
    expect(script).not.toContain("Set-Service");
    expect(script).not.toContain("Stop-Service");
  });

  test("arrete sshd seulement si l'amorcage l'avait demarre", async () => {
    expect(await restoreWith({})).toContain("Stop-Service -Name sshd");
    const dejaLance = await (async () => {
      runRemoteChecked.mockClear();
      return restoreWith({
        sshd: {
          present: true,
          startupType: "Manual",
          status: "Running",
          startupChanged: true,
          statusChanged: false,
        },
      });
    })();
    expect(dejaLance).toContain("Set-Service");
    expect(dejaLance).not.toContain("Stop-Service");
  });

  test("ne desinstalle JAMAIS la capacite Windows OpenSSH", async () => {
    // Retirer une capacite est invasif, peut exiger un redemarrage, et
    // l'utilisateur peut legitimement vouloir garder un serveur SSH.
    const script = await restoreWith({});
    expect(script).not.toContain("Remove-WindowsCapability");
    expect(script).not.toContain("WindowsCapability");
    expect(script).not.toContain("WindowsOptionalFeature");
  });

  test("ne supprime pas le releve, seulement son accuse de reception", async () => {
    // La queue est detachee : son echec n'est pas observable depuis le Mac,
    // qui aura pourtant deja oublie l'entree du manifeste. Le releve reste
    // alors la seule trace de l'etat d'avant amorcage.
    const script = await restoreWith({});
    expect(script).toContain(
      "Remove-Item -Path (Join-Path (Join-Path $env:ProgramData 'hardline') 'bootstrap-state.acknowledged')",
    );
    expect(script).not.toContain("bootstrap-state.json");
  });

  test("n'avale pas un code de retour non nul", async () => {
    runRemoteChecked.mockImplementationOnce(async () => {
      throw new Error("Commande distante en echec (code 1) : Access is denied");
    });
    await expect(
      bootstrapWindowsStep.restore(CONFIG, {
        capture: CAPTURE,
        acknowledged: true,
      }),
    ).rejects.toThrow(/code 1/);
  });
});

/**
 * L'invariant : a aucun instant le PC ne doit se retrouver sans adressage
 * connu, et les moyens d'y revenir — cle, regle de pare-feu, sshd — doivent
 * tomber en dernier. Les assertions comparent des INDEX : une assertion de
 * simple presence laisserait passer exactement l'ordre fautif.
 */
describe("restore, ordre des operations", () => {
  test("tout ce qui coupe le canal part dans la queue detachee", async () => {
    const script = await restoreWith({});
    const session = inSession(script);

    expect(session).not.toContain("Remove-NetIPAddress");
    expect(session).not.toContain("Remove-NetFirewallRule");
    expect(session).not.toContain("Stop-Service");
    expect(session).not.toContain("Set-NetConnectionProfile");
    expect(session).not.toContain("Set-Content -Path 'C:\\ProgramData\\ssh");
  });

  test("la queue est toujours detachee, sans condition sur l'adresse locale", async () => {
    // Contrairement a l'etape reseau, la session ne roule pas seulement sur
    // une adresse : elle roule aussi sur sshd, sur la regle de pare-feu et sur
    // la cle. Conditionner le detachement a $sshLocal serait executer en ligne
    // une queue qui coupe malgre tout.
    const script = await restoreWith({});
    expect(script).toContain("Start-Process powershell");
    expect(script).not.toContain("$sshLocal");
    expect(script).not.toContain("Get-NetTCPConnection");
  });

  test("l'accuse de reception part avant la queue", async () => {
    // Si la queue echoue, l'installation suivante doit retrouver un releve non
    // acquitte, donc non conforme, donc reenregistre.
    const script = await restoreWith({});
    expect(script.indexOf("bootstrap-state.acknowledged")).toBeLessThan(
      script.indexOf("Start-Process powershell"),
    );
  });

  test("repose l'adresse d'origine AVANT de retirer celle de l'amorcage", async () => {
    // Inverse, la sequence laisse l'interface sans aucune adresse pendant
    // l'intervalle — et definitivement si le processus detache meurt la.
    const line = detachedLine(await restoreWith({}));
    expect(line.indexOf("New-NetIPAddress")).toBeGreaterThan(0);
    expect(line.indexOf("Remove-NetIPAddress")).toBeGreaterThan(
      line.indexOf("New-NetIPAddress"),
    );
  });

  test("repose les adresses avant de rallumer le DHCP", async () => {
    const line = detachedLine(
      await restoreWith({
        network: { ...CAPTURE.network, dhcp: "Enabled" },
      }),
    );
    expect(line.indexOf("-IPAddress '192.168.1.50'")).toBeLessThan(
      line.indexOf("-Dhcp Enabled"),
    );
  });

  test("rend l'adressage avant de toucher au profil reseau", async () => {
    // Le profil Public referme le pare-feu : tout ce qui suivrait s'executerait
    // sur une machine deja injoignable.
    const line = detachedLine(await restoreWith({}));
    expect(line.indexOf("Remove-NetIPAddress")).toBeLessThan(
      line.indexOf("-NetworkCategory Public"),
    );
  });

  test("ne retire la cle qu'apres avoir rendu tout le reseau", async () => {
    const line = detachedLine(
      await restoreWith({
        authorizedKeys: {
          ...CAPTURE.authorizedKeys,
          fileExisted: true,
          aclSddl: SDDL,
          aclChanged: true,
        },
      }),
    );
    expect(line.indexOf("-NetworkCategory Public")).toBeLessThan(
      line.indexOf(`Get-Content -Path '${KEY_PATH}'`),
    );
  });

  test("supprime la regle de pare-feu apres la cle", async () => {
    const line = detachedLine(await restoreWith({}));
    expect(line.indexOf(`Remove-Item -Path '${KEY_PATH}'`)).toBeLessThan(
      line.indexOf("Remove-NetFirewallRule"),
    );
  });

  test("arrete sshd en tout dernier", async () => {
    // C'est l'instruction qui ferme definitivement la porte : tout ce qui la
    // precede doit avoir eu sa chance.
    const line = detachedLine(await restoreWith({}));
    const stop = line.indexOf("Stop-Service");

    expect(stop).toBeGreaterThan(0);
    for (const earlier of [
      "New-NetIPAddress",
      "Remove-NetIPAddress",
      "-NetworkCategory Public",
      `Remove-Item -Path '${KEY_PATH}'`,
      "Remove-NetFirewallRule",
      "Set-Service -Name sshd",
    ]) {
      expect(line.indexOf(earlier)).toBeGreaterThan(0);
      expect(line.indexOf(earlier)).toBeLessThan(stop);
    }
  });

  test("echappe les $ confies au processus detache", async () => {
    // Sans le backtick, le shell appelant developpe $false en chaine vide et
    // Remove-NetIPAddress reclame une confirmation que personne ne donnera.
    const line = detachedLine(await restoreWith({}));
    expect(line).toContain("-Confirm:`$false");
    expect(line).not.toContain("-Confirm:$false");
  });

  test("ne supprime jamais en bloc les adresses de l'interface", async () => {
    // La forme fautive : un Get-NetIPAddress sans filtre pipe dans
    // Remove-NetIPAddress, qui emporte l'adresse de la session SSH.
    expect(await restoreWith({})).not.toMatch(
      /Get-NetIPAddress[^|;]*\|\s*Remove-NetIPAddress/,
    );
  });
});
