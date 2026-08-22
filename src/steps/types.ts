import type { Config } from "../config";

export type StepState<P> = {
  /** true si l'etat cible est deja atteint : apply ne doit pas etre appele. */
  conforming: boolean;
  /** L'etat actuel, conserve dans le manifeste pour permettre la restauration. */
  current: P;
  /** Une ligne lisible decrivant ce qui a ete constate. */
  detail: string;
};

/**
 * Ce qu'une restauration doit savoir de celles qui la suivent.
 *
 * Une etape qui delegue a un processus detache — le seul moyen d'executer sur
 * le PC des instructions qui coupent le canal SSH qui les transporte — rend la
 * main AVANT que sa charge n'ait agi. Si une autre etape doit encore ouvrir une
 * session, les deux comptes a rebours se recouvrent et la seconde session peut
 * mourir au milieu de son propre travail. La regle du projet est donc : une
 * seule queue detachee coupante par desinstallation, et elle appartient a la
 * DERNIERE restauration qui passe. `pending` est ce qui permet a une etape de
 * savoir qu'elle n'est pas la derniere.
 */
export type RestoreContext = {
  /** Les etapes qui seront restaurees APRES celle-ci, dans cette execution. */
  readonly pending: readonly string[];
};

export type Step<P> = {
  /** Identifiant stable, utilise comme cle dans le manifeste. */
  readonly name: string;
  /** Libelle affiche a l'utilisateur. */
  readonly label: string;
  inspect(config: Config): Promise<StepState<P>>;
  apply(config: Config): Promise<void>;
  restore(config: Config, previous: P, context: RestoreContext): Promise<void>;
};
