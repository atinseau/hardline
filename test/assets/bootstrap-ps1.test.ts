import { test, expect, describe } from "bun:test";
import { renderBootstrapScript } from "../../src/lib/bootstrap-server";

/**
 * Ces tests portent sur le VRAI gabarit livre, pas sur une fixture. Le defaut
 * que l'etape d'amorcage existe pour fermer etait entierement dans ce fichier :
 * il modifiait cinq choses sur le PC sans en relever une seule.
 */
const TEMPLATE = await Bun.file(
  new URL("../../src/assets/bootstrap.ps1", import.meta.url),
).text();

const VARS = {
  publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1 arthur@mac",
  interfaceAlias: "Ethernet",
  windowsIp: "10.10.10.1",
  prefixLength: 24,
};

const SCRIPT = renderBootstrapScript(TEMPLATE, VARS);

/** Tout ce que l'amorcage modifie sur le PC, sans exception. */
const MODIFICATIONS = [
  "Add-WindowsCapability",
  "Set-Service -Name sshd -StartupType Automatic",
  "Start-Service sshd",
  "New-NetFirewallRule",
  "Add-Content -Path $keyFile",
  "icacls $keyFile",
  "Remove-NetIPAddress",
  "New-NetIPAddress",
  "Set-NetConnectionProfile",
];

const CAPTURE_WRITE = "Move-Item -Path $tmp -Destination $statePath -Force";

describe("releve de l'etat d'origine", () => {
  test("le releve est ecrit avant TOUTE modification", () => {
    // C'est la substance de l'etape : apres la premiere modification, l'etat
    // d'origine n'est plus observable, ni depuis le PC ni depuis le Mac.
    const written = SCRIPT.indexOf(CAPTURE_WRITE);
    expect(written).toBeGreaterThan(0);

    for (const statement of MODIFICATIONS) {
      const at = SCRIPT.indexOf(statement);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeGreaterThan(written);
    }
  });

  test("le controle de l'interface precede le releve", () => {
    // Sur une machine ou l'amorcage ne peut pas aboutir, mieux vaut ne rien
    // ecrire du tout qu'y laisser un releve d'un etat qu'on n'a pas touche.
    expect(SCRIPT.indexOf("aucune interface nommee")).toBeLessThan(
      SCRIPT.indexOf(CAPTURE_WRITE),
    );
  });

  test("un releve deja present n'est jamais reecrit", () => {
    // Un second amorcage capturerait l'etat d'APRES amorcage, et l'etat
    // d'origine serait perdu pour toujours.
    const guard = SCRIPT.indexOf("if (Test-Path $statePath) {");
    expect(guard).toBeGreaterThan(0);
    expect(SCRIPT.indexOf(CAPTURE_WRITE)).toBeGreaterThan(guard);
    // La seule ecriture du releve est celle qui suit la garde.
    expect(SCRIPT.split(CAPTURE_WRITE)).toHaveLength(2);
  });

  test("le releve est ecrit a cote puis renomme", () => {
    // Un releve tronque serait pire que pas de releve : il empecherait
    // l'amorcage suivant d'en ecrire un valide.
    expect(SCRIPT.indexOf("Set-Content -Path $tmp")).toBeLessThan(
      SCRIPT.indexOf(CAPTURE_WRITE),
    );
  });

  test("le releve va la ou l'etape le lit", () => {
    expect(SCRIPT).toContain("Join-Path $env:ProgramData 'hardline'");
    expect(SCRIPT).toContain("Join-Path $stateDir 'bootstrap-state.json'");
  });

  test("l'accuse de reception n'est jamais ecrit par l'amorcage", () => {
    // C'est le Mac qui acquitte, une fois le releve dans son manifeste.
    expect(SCRIPT).not.toContain("bootstrap-state.acknowledged");
  });
});

describe("contenu du releve", () => {
  const champs = [
    "capability",
    "sshd",
    "firewall",
    "authorizedKeys",
    "network",
  ];

  for (const champ of champs) {
    test(`consigne ${champ}`, () => {
      expect(SCRIPT).toMatch(new RegExp(`${champ}\\s+=`));
    });
  }

  test("consigne l'etat de la capacite OpenSSH telle que trouvee", () => {
    expect(SCRIPT).toMatch(/state\s+= if \(\$capability\)/);
  });

  test("consigne le type de demarrage ET l'etat de sshd", () => {
    expect(SCRIPT).toMatch(/startupType\s+= if \(\$service\)/);
    expect(SCRIPT).toMatch(/status\s+= if \(\$service\)/);
  });

  test("consigne si la regle de pare-feu existait deja", () => {
    expect(SCRIPT).toMatch(/existed\s+= \[bool\]\$rule/);
  });

  test("consigne si le fichier de cles et la ligne du Mac existaient deja", () => {
    expect(SCRIPT).toMatch(/fileExisted\s+= \[bool\]\$keyFileExisted/);
    expect(SCRIPT).toMatch(/keyPresent\s+= \[bool\]\$keyPresent/);
  });

  test("consigne les adresses IPv4 et leur origine de prefixe", () => {
    expect(SCRIPT).toContain("$_.PrefixOrigin -eq 'Manual'");
    expect(SCRIPT).toMatch(/addresses\s+= @\(\$addresses/);
    expect(SCRIPT).toMatch(/manualAddresses\s+= @\(\$addresses/);
  });

  test("consigne le client DHCP et la categorie reseau", () => {
    expect(SCRIPT).toMatch(/dhcp\s+= if \(\$netInterface\)/);
    expect(SCRIPT).toMatch(/category\s+= \$category/);
  });

  test("consigne, pour chaque element, si l'amorcage en est l'auteur", () => {
    // Defaire ce que l'amorcage n'a pas fait serait un degat d'un genre
    // nouveau : chaque drapeau est ce qui l'en empeche.
    for (const flag of [
      /capability\s+= \[pscustomobject\]@\{[\s\S]{0,200}changed\s+=/,
      /startupChanged\s+= if \(\$service\)/,
      /statusChanged\s+= if \(\$service\)/,
      /firewall\s+= \[pscustomobject\]@\{[\s\S]{0,200}changed\s+= \[bool\]\(-not \$rule\)/,
      /changed\s+= \[bool\]\(-not \$keyPresent\)/,
      /addressingChanged\s+= \[bool\]\(-not \$hasTarget\)/,
      /categoryChanged\s+= \[bool\]\(\$category -ne 'Private'\)/,
    ]) {
      expect(SCRIPT).toMatch(flag);
    }
  });

  test("le releve est pris avant toute modification, donc les drapeaux sont des previsions", () => {
    // $hasTarget se calcule sur les adresses relevees, pas sur celles d'apres
    // amorcage : un drapeau deduit apres coup dirait toujours « rien change ».
    expect(SCRIPT.indexOf("$hasTarget = ")).toBeLessThan(
      SCRIPT.indexOf("New-NetIPAddress"),
    );
  });
});

/**
 * Un second amorcage d'un PC deja amorce ne reecrit pas le releve : il decrit
 * donc le PC d'AVANT le premier amorcage. Un menage inconditionnel emporterait
 * toute adresse posee depuis, sans qu'elle figure dans aucun releve. Le menage
 * ne s'autorise donc que ce dont le releve rend compte.
 */
describe("le menage n'emporte que ce dont le releve rend compte", () => {
  /** La section 5 seule : du filtre sur l'adresse cible au profil reseau. */
  function menage(script: string): string {
    const from = script.indexOf("Where-Object { $_.IPAddress -ne $target }");
    const to = script.indexOf("Set-NetConnectionProfile");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    return script.slice(from, to);
  }

  test("aucun retrait n'est emis hors de la garde sur le releve", () => {
    const bloc = menage(SCRIPT);
    expect(bloc).toContain("if ($known -contains $_.IPAddress) {");
    expect(bloc.indexOf("$known -contains")).toBeLessThan(
      bloc.indexOf("Remove-NetIPAddress"),
    );
    // Un seul retrait dans toute la section, et il est dans la garde.
    expect(bloc.split("Remove-NetIPAddress")).toHaveLength(2);
  });

  test("une adresse absente du releve est conservee et annoncee", () => {
    // Se taire serait retirer en silence sous un autre nom.
    expect(menage(SCRIPT)).toContain("absente du releve d'origine");
  });

  test("la liste des adresses retirables est relue sur le disque", () => {
    // Et non deduite des variables de la capture : celles-ci n'existent pas
    // quand le releve preexiste, c'est-a-dire dans le cas meme qui detruisait.
    expect(SCRIPT).toContain("$recorded = Get-Content -Path $statePath -Raw");
    expect(SCRIPT.indexOf("$recorded = Get-Content")).toBeLessThan(
      SCRIPT.indexOf("Where-Object { $_.IPAddress -ne $target }"),
    );
  });

  test("la relecture a lieu quel que soit l'etat du releve", () => {
    // Le point structurel : placee dans la branche "else", elle ne
    // s'executerait qu'au PREMIER amorcage, donc jamais quand elle sert.
    // La colonne zero est ce qui prouve qu'elle est hors du bloc de capture.
    const ligne = SCRIPT.split("\n").find((l) => l.includes("$known = @()"));
    expect(ligne).toBe("$known = @()");
    expect(SCRIPT.indexOf("$known = @()")).toBeGreaterThan(
      SCRIPT.indexOf(CAPTURE_WRITE),
    );
  });

  test("un releve illisible n'autorise aucun retrait", () => {
    // La liste part vide et le catch ne la remplit pas : rien n'est retire.
    const debut = SCRIPT.indexOf("$known = @()");
    const attrape = SCRIPT.indexOf("} catch {", debut);
    expect(attrape).toBeGreaterThan(debut);
    const rattrapage = SCRIPT.slice(attrape, SCRIPT.indexOf("\n}", attrape));
    expect(rattrapage).not.toContain("$known =");
    expect(rattrapage).toContain("aucune adresse ne sera retiree");
  });
});

describe("adressage du lien direct", () => {
  test("pose l'adresse cible AVANT de retirer quoi que ce soit", () => {
    // L'ordre inverse laissait l'interface sans AUCUNE adresse IPv4 des lors
    // que New-NetIPAddress echouait, $ErrorActionPreference valant 'Stop'.
    // C'est la discipline etablie par network-windows.ts, ici enfin appliquee.
    const pose = SCRIPT.indexOf("New-NetIPAddress -InterfaceAlias $alias -IPAddress $target");
    const menage = SCRIPT.indexOf("Remove-NetIPAddress -Confirm:$false");
    expect(pose).toBeGreaterThan(0);
    expect(menage).toBeGreaterThan(pose);
  });

  test("le menage epargne l'adresse qu'on vient de poser", () => {
    expect(SCRIPT).toContain("Where-Object { $_.IPAddress -ne $target }");
  });

  test("ne supprime jamais en bloc les adresses de l'interface", () => {
    // La forme fautive : un Get-NetIPAddress sans filtre pipe dans
    // Remove-NetIPAddress.
    expect(SCRIPT).not.toMatch(
      /Get-NetIPAddress[^|]*\|\s*\n?\s*Remove-NetIPAddress/,
    );
  });
});

describe("contraintes du terrain", () => {
  test("le script reste sans accents", () => {
    // Il s'affiche dans une console Windows en page de code OEM, ou les
    // accents sont mutiles.
    const hors = [...TEMPLATE].filter((c) => c.charCodeAt(0) > 127);
    expect(hors).toEqual([]);
  });

  test("pose ses propres preferences : c'est une charge autonome", () => {
    // Il n'est pas confie a runRemoteChecked, qui les prependrait.
    expect(SCRIPT).toContain("$ErrorActionPreference = 'Stop'");
  });

  test("n'utilise que des identifiants de securite avec icacls", () => {
    // "Administrators" n'existe pas sur un Windows francais, ou le groupe se
    // nomme "Administrateurs".
    const icacls = SCRIPT.split("\n").find((l) => l.startsWith("icacls "));
    expect(icacls).toContain("*S-1-5-32-544");
    expect(icacls).toContain("*S-1-5-18");
    expect(icacls).not.toMatch(/\/grant '[A-Za-z]/);
  });

  test("ecrit la cle publique en ascii, jamais en utf8", () => {
    expect(SCRIPT).toContain("Add-Content -Path $keyFile -Value $publicKey -Encoding ascii");
  });

  test("ne passe jamais DomainAuthenticated a Set-NetConnectionProfile", () => {
    expect(SCRIPT).not.toContain("DomainAuthenticated");
  });

  test("tous les marqueurs sont substituables", () => {
    expect(SCRIPT).not.toMatch(/@@[A-Z_]+@@/);
    expect(SCRIPT).toContain(VARS.publicKey);
    expect(SCRIPT).toContain("$target = '10.10.10.1'");
    expect(SCRIPT).toContain("$prefix = 24");
    expect(SCRIPT).toContain("$alias = 'Ethernet'");
  });
});
