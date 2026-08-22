/**
 * Rend un message lisible pour n'importe quelle valeur levee. `throw` accepte
 * n'importe quoi en JavaScript : une chaine, un objet, undefined. Lire
 * `.message` sans verifier affiche « undefined » a l'utilisateur, ce qui est
 * la pire chose a montrer au moment ou quelque chose vient d'echouer.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
