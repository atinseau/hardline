import type { SSHTarget } from "./lib/ssh";
import type { LinkKind } from "./target-resolution/types";

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
  /** Empreinte SHA-256 de l'artefact, exigee de ce que Homebrew propose. */
  artifactSha256: string;
  /** Chemin du binaire en ligne de commande, pose par le cask. */
  binary: string;
  /** Nom sous lequel ce Mac s'annonce a Apollo. */
  clientName: string;
  /** Application Apollo a lancer. "Desktop" est cablee dans le binaire. */
  app: string;
};

export type Config = {
  /**
   * `direct` : hardline possede l'adressage du lien et le pose sur les deux
   * machines. `shared` : le lien preexistait, hardline l'observe et n'y touche
   * pas — les etapes qui adressent les interfaces ne s'executent alors pas.
   */
  linkKind: LinkKind;
  mac: { serviceName: string; ip: string; subnetMask: string };
  windows: {
    interfaceAlias: string;
    ip: string;
    prefixLength: number;
    /** Adresse matérielle persistée, disponible même quand ARP ne connaît plus le PC éteint. */
    macAddress: string;
    /** Vrai quand le PC est relié par radio : aucun paquet magique ne l'atteint. */
    wireless: boolean;
  };
  ssh: SSHTarget;
  bootstrapPort: number;
  apollo: ApolloConfig;
  moonlight: MoonlightConfig;
};
