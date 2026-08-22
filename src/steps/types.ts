import type { Config } from "../config";

export type StepState<P> = {
  /** true si l'etat cible est deja atteint : apply ne doit pas etre appele. */
  conforming: boolean;
  /** L'etat actuel, conserve dans le manifeste pour permettre la restauration. */
  current: P;
  /** Une ligne lisible decrivant ce qui a ete constate. */
  detail: string;
};

export type Step<P> = {
  /** Identifiant stable, utilise comme cle dans le manifeste. */
  readonly name: string;
  /** Libelle affiche a l'utilisateur. */
  readonly label: string;
  inspect(config: Config): Promise<StepState<P>>;
  apply(config: Config): Promise<void>;
  restore(config: Config, previous: P): Promise<void>;
};
