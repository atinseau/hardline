export const KEYCHAIN_SERVICE = "hardline";

export type SecretName = "apollo-web" | "windows-account";

const PASSWORD_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_=+";
const DEFAULT_PASSWORD_LENGTH = 24;
const PIN_MODULUS = 10000;
const PIN_DIGITS = 4;

/** Un mot de passe aleatoire imprimable, pour l'interface d'Apollo. */
export function generatePassword(length = DEFAULT_PASSWORD_LENGTH): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET[bytes[i]! % PASSWORD_ALPHABET.length];
  }
  return out;
}

/** Un code d'appairage a quatre chiffres, zeros en tete compris. */
export function generatePin(): string {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  const value = buffer[0]! % PIN_MODULUS;
  return value.toString().padStart(PIN_DIGITS, "0");
}

// --- Frontiere systeme. Aucune logique ici, seulement l'appel a /usr/bin/security. ---

const SECURITY = "/usr/bin/security";

/**
 * Un appel a security. `input`, quand il est fourni, part sur l'entree
 * standard : c'est le seul chemin par lequel un secret atteint l'outil sans
 * apparaitre dans la liste des processus de la machine.
 *
 * `detached: true` n'est pas un detail d'ordonnancement, c'est ce qui empeche
 * « password data for new item: » et « retype password for new item: » de
 * s'afficher en anglais au milieu de l'interface. security demande le secret
 * par getpass(3), qui ecrit ses invites sur /dev/tty et non sur la sortie
 * standard ni sur la sortie d'erreur : AUCUNE redirection de flux ne les
 * supprime. Un processus detache perd son terminal de controle, /dev/tty ne
 * s'ouvre plus, et getpass bascule sur l'entree standard - celle qu'on lui
 * fournit deja. Le mode interactif de security a ete ecarte : il TRONQUE le
 * secret a la premiere espace.
 */
async function security(
  args: string[],
  input?: string,
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn([SECURITY, ...args], {
    stdin: input === undefined ? "ignore" : new Response(input),
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });

  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { exitCode, stdout };
}

/**
 * Range un secret. Ecrase silencieusement s'il existe deja.
 *
 * Le mot de passe part sur l'ENTREE STANDARD : `-w` place en derniere position
 * et sans valeur fait lire le secret la, y compris quand l'entree n'est pas un
 * terminal. Passe en argument, il serait lisible par n'importe quel processus
 * de la machine le temps de l'appel.
 *
 * security attend DEUX lignes, saisie et confirmation. Une seule ligne, ou
 * deux lignes differentes, rangent un mot de passe VIDE et sortent en code 0 :
 * le code de retour ne prouve donc rien. Seule la relecture fait foi, et c'est
 * elle qui porte le contrat de cette fonction, la seule du module qui leve.
 */
export async function setSecret(name: SecretName, value: string): Promise<void> {
  const { exitCode } = await security(
    ["add-generic-password", "-a", name, "-s", KEYCHAIN_SERVICE, "-U", "-w"],
    `${value}\n${value}\n`,
  );
  if (exitCode !== 0) {
    throw new Error(
      `Le trousseau a refusé le secret «\u00a0${name}\u00a0» (code ${exitCode}).`,
    );
  }

  if ((await getSecret(name)) !== value) {
    throw new Error(
      `Le secret «\u00a0${name}\u00a0» n'a pas été rangé tel quel au trousseau\u00a0: ` +
        "la relecture ne rend pas la valeur écrite.",
    );
  }
}

/** Relit un secret. `null` s'il n'existe pas. Ne leve jamais pour une absence. */
export async function getSecret(name: SecretName): Promise<string | null> {
  const { stdout, exitCode } = await security([
    "find-generic-password",
    "-a",
    name,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (exitCode !== 0) return null;
  const value = stdout.replace(/\n$/, "");
  return value === "" ? null : value;
}

/** Retire un secret. Rend `true` s'il existait. */
export async function deleteSecret(name: SecretName): Promise<boolean> {
  const { exitCode } = await security([
    "delete-generic-password",
    "-a",
    name,
    "-s",
    KEYCHAIN_SERVICE,
  ]);
  return exitCode === 0;
}
