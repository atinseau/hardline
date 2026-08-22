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

/**
 * Ce qu'une restauration rend d'elle-meme. Trois reponses, et une seule veut
 * dire que le programme a VU l'etat anterieur revenir.
 *
 * Ne rien rendre veut dire "j'ai fait mon travail, et je l'ai vu se faire" :
 * les instructions sont parties dans la session SSH et leur code de retour a
 * ete verifie. L'enregistrement du manifeste peut partir.
 *
 * `{ yielded }` veut dire "je n'ai rien fait, et voici pourquoi" : l'etape a
 * cede sa place a une restauration plus profonde, qui connait mieux qu'elle
 * l'etat d'origine. L'enregistrement part aussi, puisque la couche profonde le
 * supplante. Mais donner cette etape pour restauree quand elle n'a pas ouvert
 * une seule session serait un mensonge visible a l'ecran.
 *
 * `{ detached }` veut dire "j'ai LANCE quelque chose que je ne verrai jamais
 * finir". Les instructions qui coupent le canal SSH sont confiees a un
 * processus detache sur le PC ; il rend la main des qu'il est lance, dort deux
 * secondes, puis retire l'adresse qui portait la session. A partir de la, le
 * Mac ne peut plus rien observer. Un lancement n'est pas un achevement :
 * l'enregistrement du manifeste est CONSERVE, parce qu'il est la seule
 * description de l'etat d'origine et qu'on ne l'echange pas contre l'espoir
 * qu'une charge a abouti.
 */
export type RestoreOutcome =
  | { readonly yielded: string }
  | { readonly detached: string }
  | void;

export type Step<P> = {
  /** Identifiant stable, utilise comme cle dans le manifeste. */
  readonly name: string;
  /** Libelle affiche a l'utilisateur. */
  readonly label: string;
  inspect(config: Config): Promise<StepState<P>>;
  apply(config: Config): Promise<void>;
  restore(
    config: Config,
    previous: P,
    context: RestoreContext,
  ): Promise<RestoreOutcome>;
};
