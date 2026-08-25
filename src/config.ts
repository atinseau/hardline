import type { SSHTarget } from "./lib/ssh";

export type ApolloConfig = {
  /** Version visee. Sert au controle d'idempotence et au message d'ecart. */
  version: string;
  /** URL exacte de l'artefact NSIS. */
  installerUrl: string;
  /** Empreinte SHA-256 minuscule, verifiee avant toute execution. */
  installerSha256: string;
  /** Repertoire d'installation impose par `/D=`. */
  installDir: string;
  /** Nom exact du service Windows. */
  serviceName: string;
  /** Port HTTPS de l'interface et de l'API. */
  apiPort: number;
  /** Compte de l'interface web, cree par hardline. */
  webUser: string;
};

export type MoonlightConfig = {
  /** Version exacte exigee pour declarer l'installation conforme. */
  version: string;
  /** Nom du cask Homebrew. */
  cask: string;
  /** Recette Homebrew immuable, epinglee a un commit du depot de casks. */
  recipeUrl: string;
  /** Empreinte SHA-256 de la recette, verifiee avant d'invoquer Homebrew. */
  recipeSha256: string;
  /** Empreinte SHA-256 de l'artefact, imposee par la recette authentifiee. */
  artifactSha256: string;
  /** Chemin du binaire en ligne de commande, pose par le cask. */
  binary: string;
  /** Nom sous lequel ce Mac s'annonce a Apollo. */
  clientName: string;
  /** Application Apollo a lancer. "Desktop" est cablee dans le binaire. */
  app: string;
};

export type SMBShare = {
  /** Nom du partage cote Windows. */
  name: string;
  /** Chemin Windows partage. `null` quand le partage preexiste et n'est pas a creer. */
  path: string | null;
  /** Point de montage sur le Mac, sous /Volumes. */
  mountPoint: string;
};

export type SMBConfig = {
  /** Compte Windows employe pour les partages. */
  user: string;
  /** Partages a monter, dans l'ordre. */
  shares: readonly SMBShare[];
};

export type Config = {
  mac: { serviceName: string; ip: string; subnetMask: string };
  windows: {
    interfaceAlias: string;
    ip: string;
    prefixLength: number;
    /** Adresse matérielle persistée, disponible même quand ARP ne connaît plus le PC éteint. */
    macAddress: string;
  };
  ssh: SSHTarget;
  bootstrapPort: number;
  apollo: ApolloConfig;
  moonlight: MoonlightConfig;
  smb: SMBConfig;
};
