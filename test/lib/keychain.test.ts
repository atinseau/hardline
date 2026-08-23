import { test, expect, describe, spyOn, beforeEach, afterEach } from "bun:test";
import {
  KEYCHAIN_SERVICE,
  generatePassword,
  generatePin,
  getSecret,
  setSecret,
} from "../../src/lib/keychain";

describe("KEYCHAIN_SERVICE", () => {
  test("vaut hardline, l'étiquette de service commune à tous les secrets", () => {
    expect(KEYCHAIN_SERVICE).toBe("hardline");
  });
});

describe("generatePassword", () => {
  test("rend une chaîne de la longueur par défaut", () => {
    expect(generatePassword()).toHaveLength(24);
  });

  test("respecte une longueur explicite", () => {
    expect(generatePassword(12)).toHaveLength(12);
  });

  test("ne contient que des caractères imprimables, sans espace ni guillemet", () => {
    const password = generatePassword(64);
    expect(password).toMatch(/^[A-Za-z0-9!@#$%^&*\-_=+]+$/);
  });

  test("deux tirages successifs ne coïncident jamais", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

describe("generatePin", () => {
  test("rend toujours quatre chiffres", () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePin()).toMatch(/^\d{4}$/);
    }
  });

  test("conserve les zéros en tête", () => {
    // Force la valeur tiree pour prouver que le remplissage a zero fonctionne,
    // au lieu d'attendre au hasard un tirage qui commence par zero.
    const spy = spyOn(crypto, "getRandomValues").mockImplementation(
      (<T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint32Array) array[0] = 7;
        return array;
      }) as typeof crypto.getRandomValues,
    );
    try {
      expect(generatePin()).toBe("0007");
    } finally {
      spy.mockRestore();
    }
  });

  test("deux tirages non forcés ne coïncident pas systématiquement", () => {
    const pins = new Set(Array.from({ length: 20 }, () => generatePin()));
    expect(pins.size).toBeGreaterThan(1);
  });
});

// --- setSecret : le secret passe par l'entree standard, et la relecture fait foi. ---

type SpawnCall = { cmd: string[]; stdin: unknown; detached: boolean | undefined };

let spawnCalls: SpawnCall[];
let lastInput: string;
/** Ce que le trousseau simule contient. La chaine vide vaut « absent ». */
let stored: string;
let addExit: number;
/**
 * Reproduit le piege observe sur la machine : quand security ne recoit pas
 * deux lignes identiques, il range un mot de passe VIDE et sort en code 0.
 */
let avaleLaConfirmation: boolean;
let originalSpawn: typeof Bun.spawn;

beforeEach(() => {
  spawnCalls = [];
  lastInput = "";
  stored = "";
  addExit = 0;
  avaleLaConfirmation = false;
  originalSpawn = Bun.spawn;

  Bun.spawn = ((cmd: string[], options?: { stdin?: unknown; detached?: boolean }) => {
    spawnCalls.push({ cmd, stdin: options?.stdin, detached: options?.detached });

    if (cmd[1] === "add-generic-password") {
      const input = options?.stdin;
      const exited = (async () => {
        lastInput = input instanceof Response ? await input.text() : "";
        const [first, second] = lastInput.split("\n");
        const complet =
          !avaleLaConfirmation && first !== undefined && first !== "" && first === second;
        stored = complet ? first : "";
        return addExit;
      })();
      return { stdout: "", stderr: "", exited };
    }

    if (cmd[1] === "find-generic-password") {
      return stored === ""
        ? { stdout: "", stderr: "", exited: Promise.resolve(44) }
        : { stdout: `${stored}\n`, stderr: "", exited: Promise.resolve(0) };
    }

    return { stdout: "", stderr: "", exited: Promise.resolve(0) };
  }) as unknown as typeof Bun.spawn;
});

afterEach(() => {
  Bun.spawn = originalSpawn;
});

describe("setSecret", () => {
  const SECRET = "-aZ b!@#$%^&*-_=+9";

  test("ne laisse le mot de passe dans aucun argument de la ligne de commande", async () => {
    // Le coeur de la garantie : un argument est lisible par tout processus de
    // la machine le temps de l'appel. Le secret ne doit atteindre security que
    // par l'entree standard, donc `-w` reste en derniere position, sans valeur.
    await setSecret("apollo-web", SECRET);

    const add = spawnCalls.find((c) => c.cmd[1] === "add-generic-password");
    expect(add).toBeDefined();
    for (const arg of add?.cmd ?? []) {
      expect(arg).not.toContain(SECRET);
    }
    expect(add?.cmd.at(-1)).toBe("-w");
    expect(add?.stdin).toBeInstanceOf(Response);
  });

  test("ecrit la valeur deux fois, saisie et confirmation, sur l'entree standard", async () => {
    // Une seule ligne, ou deux lignes differentes, rangent un secret VIDE en
    // sortant en code 0 : le trousseau simule reproduit exactement ce piege.
    await setSecret("windows-account", SECRET);
    expect(lastInput).toBe(`${SECRET}\n${SECRET}\n`);
  });

  test("range effectivement la valeur, relisible telle quelle", async () => {
    await setSecret("apollo-web", SECRET);
    expect(await getSecret("apollo-web")).toBe(SECRET);
  });

  test("leve quand la relecture ne rend pas la valeur ecrite, malgre un code 0", async () => {
    // Le seul controle qui tienne : security a sorti 0 et n'a pourtant rien
    // range. Un setSecret qui croirait le code de retour rendrait ici sans
    // rien dire, et le mot de passe serait perdu en silence.
    avaleLaConfirmation = true;
    await expect(setSecret("apollo-web", SECRET)).rejects.toThrow(/relecture/);
  });

  test("leve quand security lui-meme refuse le secret", async () => {
    addExit = 1;
    await expect(setSecret("apollo-web", SECRET)).rejects.toThrow(/code 1/);
  });

  test("ne laisse pas fuir le secret dans son propre message d'erreur", async () => {
    avaleLaConfirmation = true;
    let caught: Error | null = null;
    try {
      await setSecret("apollo-web", SECRET);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught?.message).not.toContain(SECRET);
  });
});

/**
 * Les invites de security - « password data for new item: » et « retype
 * password for new item: » - sont ecrites par getpass(3) sur /dev/tty, jamais
 * sur la sortie standard ni sur la sortie d'erreur : les rediriger ne les
 * supprime pas, et l'utilisateur les a vues s'afficher en anglais au milieu de
 * l'interface. Un processus DETACHE perd son terminal de controle, /dev/tty ne
 * s'ouvre plus, et getpass bascule sur l'entree standard - celle qu'on lui
 * fournit deja. Retirer `detached` fait tomber ces trois controles.
 */
describe("security : aucune invite sur le terminal", () => {
  test("chaque appel a security est detache de son terminal de controle", async () => {
    await setSecret("apollo-web", "-aZ b!@#$%^&*-_=+9");
    expect(spawnCalls.length).toBeGreaterThan(0);
    for (const call of spawnCalls) {
      expect(call.detached).toBe(true);
    }
  });

  test("l'ecriture du secret, seul appel qui reclame une saisie, est detachee", async () => {
    await setSecret("windows-account", "hunter 2");
    const add = spawnCalls.find((c) => c.cmd[1] === "add-generic-password");
    expect(add?.detached).toBe(true);
  });

  /**
   * Le mode interactif de security a ete ecarte : il TRONQUE le secret a la
   * premiere espace. L'aller-retour reste donc exact sur un mot de passe qui
   * porte une espace, un tiret initial et des caracteres speciaux.
   */
  test("l'aller-retour reste exact sur un secret a espaces et tiret initial", async () => {
    const piege = "-mot de passe --avec espaces $ ' `!";
    await setSecret("apollo-web", piege);
    expect(await getSecret("apollo-web")).toBe(piege);
  });
});

describe("getSecret", () => {
  test("rend null quand security ne trouve rien", async () => {
    stored = "";
    expect(await getSecret("windows-account")).toBe(null);
  });

  test("retire le saut de ligne final que security ajoute", async () => {
    stored = "hunter2";
    expect(await getSecret("windows-account")).toBe("hunter2");
  });
});
