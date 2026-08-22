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

  /** Etat "rien a faire". Doit rester visible : c'est une information utile. */
  skipped({ label, detail }: StepReport): void {
    log.step(`${label} — deja conforme (${detail})`);
  },

  applied({ label, detail }: StepReport): void {
    log.success(`${label} — applique (${detail})`);
  },

  failed({ label, detail }: StepReport): void {
    log.error(`${label} — echec : ${detail}`);
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
    s.error(`${label} — echec`);
    throw error;
  }
}

export async function confirmOrExit(
  message: string,
  assumeYes: boolean,
): Promise<boolean> {
  if (assumeYes || !isInteractive()) return true;

  const answer = await confirm({ message });
  if (isCancel(answer)) {
    cancel("Interrompu.");
    process.exit(1);
  }
  return answer;
}
