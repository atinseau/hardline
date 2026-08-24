import { deleteSecret, getSecret, setSecret } from "../lib/keychain";
import type { Config } from "../config";
import type { Step } from "./types";

export type CredentialState = { present: boolean };

/**
 * L'etape ne dialogue jamais : c'est une regle absolue du projet. Le mot de
 * passe est donc recueilli par la commande, AVANT que la convergence ne
 * commence, et depose ici par ce pont. apply() le consomme puis l'efface de
 * la memoire : il ne doit jamais survivre au-dela d'un seul appel.
 */
let pendingPassword: string | null = null;

/** Appele par la commande install, avant de lancer la convergence locale. */
export function providePassword(value: string): void {
  pendingPassword = value;
}

/**
 * Efface le mot de passe garde en memoire de module. apply() le fait deja
 * quand il s'execute, mais l'orchestrateur le saute quand l'etape est deja
 * conforme : le secret survivrait alors jusqu'a la fin du processus sans que
 * rien ne l'ait jamais range. La commande appelle donc ceci en fin de
 * convergence, quel que soit le chemin de sortie.
 */
export function forgetPassword(): void {
  pendingPassword = null;
}

export const smbCredentialsStep: Step<CredentialState> = {
  name: "smb-credentials",
  label: "Identifiants des partages au trousseau (Mac)",

  async inspect(config: Config) {
    if (config.smb.shares.length === 0) {
      return {
        conforming: true,
        current: { present: false },
        detail: "aucun partage SMB configuré",
      };
    }
    const present = (await getSecret("windows-account")) !== null;
    return {
      conforming: present,
      current: { present },
      detail: present
        ? "mot de passe déjà au trousseau"
        : "aucun mot de passe au trousseau",
    };
  },

  async apply(config: Config) {
    if (config.smb.shares.length === 0) return;
    if (pendingPassword === null) {
      throw new Error(
        "Mot de passe Windows manquant\u00a0: providePassword() doit être appelé " +
          "avant la convergence locale.",
      );
    }
    await setSecret("windows-account", pendingPassword);
    pendingPassword = null;
  },

  async restore(config: Config, previous: CredentialState) {
    if (config.smb.shares.length === 0) return;
    // Un mot de passe deja present avant hardline n'est jamais le notre a
    // effacer : seul celui que apply() a cree est retire.
    if (previous.present) return;
    await deleteSecret("windows-account");
  },
};
