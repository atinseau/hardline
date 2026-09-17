/**
 * La version du binaire, lue par `--version` et comparee a la derniere
 * publication par `hardline update`. Isolee de `cli.ts` pour qu'une commande
 * puisse la lire sans importer le programme qui l'enregistre.
 */
export const VERSION = "0.1.18";
