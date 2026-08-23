import { $ } from "bun";

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

/** Range un secret. Ecrase silencieusement s'il existe deja. */
export async function setSecret(name: SecretName, value: string): Promise<void> {
  await $`/usr/bin/security add-generic-password -a ${name} -s ${KEYCHAIN_SERVICE} -w ${value} -U`
    .quiet();
}

/** Relit un secret. `null` s'il n'existe pas. Ne leve jamais pour une absence. */
export async function getSecret(name: SecretName): Promise<string | null> {
  const { stdout, exitCode } =
    await $`/usr/bin/security find-generic-password -a ${name} -s ${KEYCHAIN_SERVICE} -w`
      .quiet()
      .nothrow();
  if (exitCode !== 0) return null;
  const value = stdout.toString().replace(/\n$/, "");
  return value === "" ? null : value;
}

/** Retire un secret. Rend `true` s'il existait. */
export async function deleteSecret(name: SecretName): Promise<boolean> {
  const { exitCode } =
    await $`/usr/bin/security delete-generic-password -a ${name} -s ${KEYCHAIN_SERVICE}`
      .quiet()
      .nothrow();
  return exitCode === 0;
}
