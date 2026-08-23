import { homedir } from "node:os";
import { join } from "node:path";
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
  /** Nom du cask Homebrew. */
  cask: string;
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
  windows: { interfaceAlias: string; ip: string; prefixLength: number };
  ssh: SSHTarget;
  bootstrapPort: number;
  apollo: ApolloConfig;
  moonlight: MoonlightConfig;
  smb: SMBConfig;
};

export const CONFIG: Config = {
  mac: {
    serviceName: "AX88179A",
    ip: "10.10.10.2",
    subnetMask: "255.255.255.0",
  },
  windows: {
    interfaceAlias: "Ethernet",
    ip: "10.10.10.1",
    prefixLength: 24,
  },
  ssh: {
    host: "10.10.10.1",
    user: "arthur",
    identityFile: join(homedir(), ".ssh", "id_ed25519_winpc"),
    connectTimeoutSec: 8,
  },
  bootstrapPort: 8080,
  apollo: {
    version: "0.4.6",
    installerUrl:
      "https://github.com/ClassicOldSong/Apollo/releases/download/v0.4.6/Apollo-0.4.6.exe",
    installerSha256:
      "42b2aefaacb3474511517a56b96ee9f0517f30ac38b5dd2fda9fd5b478f5021a",
    installDir: "C:\\Program Files\\Apollo",
    serviceName: "ApolloService",
    apiPort: 47990,
    webUser: "hardline",
  },
  moonlight: {
    cask: "moonlight",
    // L'executable DANS le bundle, jamais le lien que Homebrew pose dans
    // /opt/homebrew/bin. Qt resout ses greffons relativement au chemin par
    // lequel le programme est lance : appele par le lien, il les cherche
    // dans /opt/homebrew/PlugIns, ne les trouve pas, et l'interface ne se
    // charge jamais — « module "QtQuick.Controls" plugin
    // "qtquickcontrols2plugin" not found », mesure sur le Mac. Le programme
    // reste alors muet, et l'appairage echoue sans que rien ne le dise.
    binary: "/Applications/Moonlight.app/Contents/MacOS/Moonlight",
    clientName: "hardline-mac",
    app: "Desktop",
  },
  smb: {
    user: "arthur",
    shares: [
      { name: "arthur", path: null, mountPoint: join(homedir(), "PC", "arthur") },
      { name: "hardline-d", path: "D:\\", mountPoint: join(homedir(), "PC", "d") },
      { name: "hardline-e", path: "E:\\", mountPoint: join(homedir(), "PC", "e") },
    ],
  },
};
