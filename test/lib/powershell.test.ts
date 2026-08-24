import { test, expect, describe } from "bun:test";
import {
  assertNoApostrophe,
  assertNoDoubleQuote,
  psInteger,
  psDoubleQuote,
  psKeyword,
  psQuote,
} from "../../src/lib/powershell";

/**
 * Le script d'amorcage refusait deja toute valeur a apostrophe ; le chemin
 * RETOUR — les valeurs du releve recousues dans un script de restauration —
 * n'avait pas cette rigueur. Ce n'est pas une barriere de securite : le releve
 * n'est modifiable que par un administrateur du PC. C'est ce qui separe une
 * erreur nommee d'une instruction muette qui ne repose jamais l'adresse.
 */
describe("assertNoApostrophe", () => {
  test("laisse passer une valeur ordinaire", () => {
    expect(() => assertNoApostrophe("Ethernet", "alias")).not.toThrow();
  });

  test("refuse une apostrophe, et nomme la valeur fautive", () => {
    expect(() => assertNoApostrophe("Réseau d'Arthur", "alias")).toThrow(
      /alias.*Arthur/s,
    );
  });
});

describe("psQuote", () => {
  test("rend la valeur entre apostrophes", () => {
    expect(psQuote("Ethernet", "alias")).toBe("'Ethernet'");
  });

  test("double une apostrophe pour qu'elle reste dans la chaine", () => {
    expect(psQuote("a'b", "alias")).toBe("'a''b'");
  });
});

describe("psInteger", () => {
  test("accepte un entier dans les bornes, chaine comprise", () => {
    expect(psInteger("24", "préfixe", 32)).toBe(24);
    expect(psInteger(0, "préfixe", 32)).toBe(0);
    expect(psInteger(32, "préfixe", 32)).toBe(32);
  });

  test("refuse un préfixe absent", () => {
    // Le cas reel : manualAddresses: ["10.0.0.1"] sans préfixe produisait
    // « -PrefixLength undefined », instruction qui echoue en silence dans une
    // queue tournant en Continue. L'adresse n'etait jamais reposee et personne
    // ne le savait.
    expect(() => psInteger(undefined, "préfixe", 32)).toThrow(/préfixe/);
    expect(() => psInteger("", "préfixe", 32)).toThrow(/préfixe/);
  });

  test("refuse hors bornes et non entier", () => {
    expect(() => psInteger(33, "préfixe", 32)).toThrow();
    expect(() => psInteger(-1, "préfixe", 32)).toThrow();
    expect(() => psInteger("24.5", "préfixe", 32)).toThrow();
    expect(() => psInteger("Private", "préfixe", 32)).toThrow();
  });
});

describe("psKeyword", () => {
  test("laisse passer un mot-cle de l'ensemble", () => {
    expect(psKeyword("Manual", "démarrage", ["Automatic", "Manual"])).toBe("Manual");
  });

  test("refuse tout le reste, puisqu'il est interpole hors apostrophes", () => {
    expect(() =>
      psKeyword("Automatic; Remove-Item C:\\", "démarrage", ["Automatic", "Manual"]),
    ).toThrow(/démarrage/);
  });
});

describe("psDoubleQuote", () => {
  /** Le contenu, sans les guillemets qui l'entourent. */
  const inner = (value: string): string => psDoubleQuote(value).slice(1, -1);

  test("entoure de guillemets", () => {
    expect(psDoubleQuote("Start-Sleep -Seconds 2")).toBe('"Start-Sleep -Seconds 2"');
  });

  test("soustrait chaque dollar au shell appelant", () => {
    // Sans cela, $false devient chaine vide et Remove-NetIPAddress reclame une
    // confirmation interactive que personne ne donnera jamais.
    expect(inner("-Confirm:$false; $x = $y")).toBe("-Confirm:`$false; `$x = `$y");
  });

  test("echappe le guillemet, que le remplacement en bloc ignorait", () => {
    // Le defaut concret : la chaine se refermait au milieu de la queue, et tout
    // ce qui suivait devenait des arguments du shell appelant.
    expect(inner('Write-Host "fini"')).toBe("Write-Host `\"fini`\"");
  });

  test("echappe l'accent grave, que le remplacement en bloc ignorait", () => {
    // Laisse tel quel, il mangeait le caractere suivant.
    expect(inner("a`b")).toBe("a``b");
  });

  test("echappe l'accent grave AVANT le reste", () => {
    // L'ordre est la substance : traiter le dollar d'abord donnerait "a``$b",
    // c'est-a-dire un accent grave litteral suivi d'une interpolation de $b.
    // PowerShell lit ici deux accents graves (un litteral) puis `$ (un dollar
    // litteral) : le contenu rendu est exactement "a`$b".
    expect(inner("a`$b")).toBe("a```$b");
  });

  test("laisse l'apostrophe intacte", () => {
    // Elle n'est pas speciale dans une chaine entre guillemets, et psQuote s'en
    // sert pour citer les valeurs cousues DANS la charge.
    expect(inner("-IPAddress '10.10.10.1'")).toBe("-IPAddress '10.10.10.1'");
  });

  test("ne touche a rien quand rien n'est special", () => {
    expect(inner("Stop-Service -Name sshd -Force")).toBe(
      "Stop-Service -Name sshd -Force",
    );
  });
});

describe("assertNoDoubleQuote", () => {
  test("laisse passer ce que Start-Process saura transmettre", () => {
    expect(() =>
      assertNoDoubleQuote("Stop-Service -Name sshd -Force", "charge"),
    ).not.toThrow();
    // L'apostrophe, elle, traverse sans encombre les deux sauts.
    expect(() =>
      assertNoDoubleQuote("-IPAddress '10.10.10.1'", "charge"),
    ).not.toThrow();
  });

  test("refuse le guillemet, que le second saut ne recite pas", () => {
    // Start-Process concatene sa liste d'arguments par des espaces sans les
    // reciter : le guillemet arriverait nu au processus fils et couperait sa
    // ligne de commande. Aucun echappement ne rend ce saut sur, le decoupage
    // ayant lieu avant toute citation.
    expect(() => assertNoDoubleQuote('Write-Host "x"', "charge")).toThrow(
      /guillemet/,
    );
    expect(() => assertNoDoubleQuote('Write-Host "x"', "charge")).toThrow(
      /charge/,
    );
  });
});
