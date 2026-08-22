import {
  intro,
  outro,
  note,
  log,
  spinner,
  confirm,
  isCancel,
  cancel,
} from "@clack/prompts";

export type StepReport = { label: string; detail: string };

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * A appeler une fois au demarrage. Clack ne teste que process.env.CI et jamais
 * isTTY : sans cela, `hardline install > journal.txt` produit un fichier rempli
 * de sequences d'echappement de deplacement du curseur.
 */
export function configureOutput(interactive: boolean = isInteractive()): void {
  if (!interactive) {
    process.env.CI = "true";
  }
}

export const ui = {
  start(title: string): void {
    intro(title);
  },

  finish(message: string): void {
    outro(message);
  },

  /** État "rien à faire". Doit rester visible : c'est une information utile. */
  skipped({ label, detail }: StepReport): void {
    log.step(`${label} — déjà conforme (${detail})`);
  },

  applied({ label, detail }: StepReport): void {
    log.success(`${label} — appliqué (${detail})`);
  },

  restored({ label, detail }: StepReport): void {
    log.success(`${label} — restauré (${detail})`);
  },

  /**
   * Une etape qui a cede sa place. Ni succes ni echec : elle n'a rien fait, et
   * c'est le bon geste. L'annoncer "restaure" ferait croire a une session
   * ouverte et a un etat rendu qui n'ont jamais eu lieu.
   */
  yielded({ label, detail }: StepReport): void {
    log.step(`${label} — cédé (${detail})`);
  },

  failed({ label, detail }: StepReport): void {
    log.error(`${label} — échec\u00a0: ${detail}`);
  },

  info(message: string): void {
    log.info(message);
  },

  warn(message: string): void {
    log.warn(message);
  },

  report(title: string, lines: string[]): void {
    note(lines.join("\n"), title);
  },
};

/**
 * Enveloppe une operation longue. Toute commande systeme lancee a l'interieur
 * doit avoir sa sortie capturee et non heritee, sinon son ecriture sur stdout
 * entrelace le rendu du spinner et desynchronise le curseur.
 */
export async function withSpinner<T>(
  label: string,
  run: (progress: (message: string) => void) => Promise<T>,
): Promise<T> {
  const s = spinner();
  s.start(label);
  try {
    const result = await run((message) => s.message(message));
    s.stop(label);
    return result;
  } catch (error) {
    s.error(`${label} — échec`);
    throw error;
  }
}

/** Levee quand l'utilisateur annule une invite. L'appelant decide du sort. */
export class CancelledError extends Error {
  constructor() {
    super("Interrompu par l'utilisateur.");
    this.name = "CancelledError";
  }
}

export type ConfirmOptions = {
  /** Passe outre l'invite : le drapeau --yes. */
  assumeYes: boolean;
  /** Injectable pour les tests ; par defaut, detection du terminal. */
  interactive?: boolean;
};

/**
 * Ne sort pas du processus elle-meme : elle leve. Un appel a process.exit
 * ici rendrait la fonction intestable et court-circuiterait tout traitement
 * de nettoyage de l'appelant.
 */
export async function askConfirmation(
  message: string,
  options: ConfirmOptions,
): Promise<boolean> {
  const interactive = options.interactive ?? isInteractive();
  if (options.assumeYes || !interactive) return true;

  const answer = await confirm({ message });
  if (isCancel(answer)) {
    cancel("Interrompu.");
    throw new CancelledError();
  }
  return answer;
}
