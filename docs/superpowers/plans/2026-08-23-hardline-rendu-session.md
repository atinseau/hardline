# Plan d'implémentation — hardline plan 2 : rendu et session

> **Pour les exécutants agentiques :** SOUS-COMPÉTENCE REQUISE — utiliser
> `superpowers:subagent-driven-development` (recommandé) ou
> `superpowers:executing-plans` pour exécuter ce plan tâche par tâche. Les étapes
> emploient la syntaxe à cases (`- [ ]`) pour le suivi.

**But :** faire apparaître le bureau Windows sur l'écran du Mac par une seule
commande, sans jamais voir ni configurer Moonlight.

**Architecture :** sept étapes ajoutées au registre existant, chacune avec son
`inspect`, son `apply` et son `restore`, chacune consignant son état antérieur au
manifeste avant de modifier quoi que ce soit. Le serveur est Apollo, posé par
`hardline install` et non hérité, parce qu'il est le seul à savoir créer l'écran
virtuel à la définition que le client réclame. Deux mécanismes nouveaux et rien
d'autre : une sonde d'écran en Swift compilée au build et embarquée comme asset,
et un coffre adossé au trousseau macOS.

**Pile technique :** Bun 1.4, TypeScript, Clack pour l'interface, Commander pour
la ligne de commande, Swift pour la seule sonde CoreGraphics, PowerShell par SSH
pour tout ce qui touche au PC.

**Spec :** `docs/superpowers/specs/2026-08-23-hardline-rendu-session-design.md`
**Socle :** `docs/superpowers/specs/2026-08-22-hardline-design.md` — livré, fusionné,
et toujours en vigueur mot pour mot.

## Contraintes globales

Elles s'appliquent à **toutes** les tâches, implicitement. Une tâche qui les
enfreint est refusée en revue, même si elle fait ce qu'on lui demande.

- **Français avec tous les accents** dans les messages destinés à l'utilisateur.
  Espace insécable `\u00a0` avant les deux-points, comme partout dans le projet.
- **Les commentaires du code s'écrivent SANS accents.** Convention existante :
  voir `src/lib/throughput.ts`. Un commentaire dit POURQUOI, jamais QUOI.
- **`bun test --isolate` est obligatoire.** `mock.module` est global au processus ;
  sans `--isolate` les tests se contaminent. `bunfig.toml` n'y change rien.
- **`bunx tsc --noEmit` doit être totalement silencieux.** Ne jamais valider par
  le motif `&& echo "ok"` : il a déjà masqué une vraie erreur dans ce projet.
  Employer `bunx tsc --noEmit 2>&1 | tee /tmp/tsc.txt ; [ -s /tmp/tsc.txt ]`.
- **Aucun `any`**, hors des tableaux `Step<any>[]` déjà annotés dans
  `src/steps/index.ts`.
- **Les étapes n'impriment jamais et ne dialoguent jamais.** Elles rendent un
  état, l'orchestrateur affiche, la commande pose les questions.
- **L'état antérieur entre au manifeste AVANT la modification.** C'est
  l'orchestrateur qui s'en charge ; le devoir d'une étape est de rendre un relevé
  qui suffise réellement à restaurer.
- **Aucun secret dans le manifeste**, ni dans un message d'erreur, ni dans un
  journal. Les secrets vivent au trousseau et nulle part ailleurs.
- **Toute valeur cousue dans un script PowerShell passe par
  `src/lib/powershell.ts`.** Aucune interpolation à la main.
- **Aucun test n'atteint une vraie machine** ni le vrai trousseau : les frontières
  système se bouchonnent par `mock.module`.
- **Les tests doivent pouvoir échouer.** Ce projet a un historique documenté de
  tests qui passaient pour la mauvaise raison : `toContain` satisfait par la
  fixture elle-même, assertion sur une valeur que le test avait fabriquée,
  vérification de présence là où le défaut était la position. Assertions sur des
  valeurs exactes, et un test par comportement.
- **Le relâchement TLS reste confiné à `src/lib/apollo-api.ts`**, par
  `tls: { rejectUnauthorized: false }` sur chaque `fetch`. La variable
  d'environnement `NODE_TLS_REJECT_UNAUTHORIZED` est interdite : elle n'est pas
  fiable sous Bun et porterait bien au-delà de ce client.

## Valeurs exactes, à reprendre telles quelles

```
Apollo          0.4.6
Installeur      https://github.com/ClassicOldSong/Apollo/releases/download/v0.4.6/Apollo-0.4.6.exe
SHA-256         42b2aefaacb3474511517a56b96ee9f0517f30ac38b5dd2fda9fd5b478f5021a
Installation    C:\Program Files\Apollo
Service         ApolloService
API             https://10.10.10.1:47990, Basic, certificat auto-signé
Pilote virtuel  root\sudomaker\sudovda
Classe          4D36E968-E325-11CE-BFC1-08002BE10318
Moonlight       cask Homebrew « moonlight », binaire /opt/homebrew/bin/moonlight
Partages        arthur (préexistant), hardline-d (D:\), hardline-e (E:\)
```

## Les six clés imposées à `sunshine.conf`

```
headless_mode = enabled
dd_configuration_option = ensure_only_display
dd_resolution_option = auto
dd_refresh_rate_option = auto
dd_config_revert_on_disconnect = enabled
capture = ddx
```

`ensure_only_display` active l'écran virtuel et désactive tous les autres le temps
de la session, puis rétablit la topologie : c'est ce qui rend le PC headless sans
y toucher. `capture = ddx` est imposé parce que l'autre moteur de capture ne
fonctionne pas en mode service et qu'Apollo n'a pas corrigé ce bug.

## Les trois pièges de la désinstallation

Ils sont la raison d'être de la tâche 8 et doivent survivre à toute réécriture.

1. **`Uninstall.exe /S` sort en succès sans rien retirer d'essentiel.** Trois
   boîtes de dialogue gardent la suppression du pilote, du dossier et de ViGEmBus,
   et leur réponse par défaut en mode silencieux est « non ». La désinstallation
   complète est donc orchestrée pas à pas par hardline.
2. **`_?=<chemin>` est obligatoire.** Sans lui, le désinstalleur NSIS se recopie
   dans un dossier temporaire et se détache : la commande SSH rend la main
   immédiatement et l'étape suivante s'exécute pendant que la précédente tourne.
3. **`uninstall.bat` du pilote ne doit jamais être appelé.** Il se termine par un
   `pause` qui attendrait pour toujours un appui clavier sur un tube qui n'en
   fournira jamais. On appelle `nefconc.exe` en direct.

Et un quatrième, moins piège que oubli : **aucun script d'Apollo ne retire les
certificats** qu'il a importés. Deux `certutil -delstore` sont nécessaires.

## Ce qui ne s'éprouve que sur les machines

Trois choses ne se simulent pas. Elles ne bloquent aucune tâche, mais elles
doivent être essayées **tôt**, pas découvertes à la fin.

- Le plein écran quand le Mac a deux écrans. C'est la zone la plus buggée du
  client Moonlight sur macOS, et c'est une des raisons pour lesquelles le mode
  fenêtré est le mode par défaut.
- La capture quand aucun écran physique n'est allumé. Aucune source ne la
  confirme ; c'est le trou le plus important du dossier.
- Le redimensionnement pendant la session, annoncé par Apollo et non vérifié.


## Structure des fichiers et contrat d'interfaces

Source unique des noms, des types et des signatures. Une tâche qui a besoin
d'un nom le prend ici. Un nom qui n'y figure pas n'existe pas : il ne s'invente
ni ne se renomme au fil de l'implémentation.

## Fichiers créés

| Fichier | Responsabilité |
|---|---|
| `tools/display-probe.swift` | Source Swift : interroge CoreGraphics, imprime une ligne par écran |
| `src/lib/display.ts` | Lance la sonde embarquée, lit sa sortie, rend les écrans |
| `src/lib/keychain.ts` | Coffre : range et relit des secrets par `/usr/bin/security` |
| `src/lib/wol.ts` | Compose et envoie le paquet magique de réveil |
| `src/lib/apollo-api.ts` | Client REST d'Apollo, TLS relâché, authentification Basic |
| `src/lib/apollo-conf.ts` | Lecture et écriture de `sunshine.conf` (pur) |
| `src/lib/moonlight.ts` | Composition des lignes de commande Moonlight (pur) et exécution |
| `src/lib/smb.ts` | Montage et démontage des partages |
| `src/lib/brew.ts` | Lecture et pose d'un cask Homebrew |
| `src/lib/moonlight-plist.ts` | Lecture et retrait d'un hôte dans le plist de Moonlight |
| `src/steps/apollo-install.ts` | Étape : Apollo posé par hardline |
| `src/steps/apollo-config.ts` | Étape : identifiants web et six clés de configuration |
| `src/steps/apollo-service.ts` | Étape : service en démarrage automatique |
| `src/steps/smb-shares.ts` | Étape : partages de D: et E: créés sur le PC |
| `src/steps/moonlight-install.ts` | Étape : cask Homebrew posé |
| `src/steps/pairing.ts` | Étape : Mac appairé à Apollo |
| `src/steps/smb-credentials.ts` | Étape : mot de passe Windows au trousseau |
| `src/commands/up.ts` | La commande `hardline up` |

## Fichiers modifiés

| Fichier | Modification |
|---|---|
| `src/config.ts` | Ajout des blocs `apollo`, `moonlight`, `smb` au type `Config` et à `CONFIG` |
| `src/steps/index.ts` | Enregistrement des sept étapes dans `LOCAL_STEPS` et `REMOTE_STEPS` |
| `src/cli.ts` | La commande `up` remplace `NOT_IMPLEMENTED("up")` |
| `src/commands/doctor.ts` | Les nouvelles étapes apparaissent d'elles-mêmes ; rien à écrire |
| `package.json` | Le script `build` compile la sonde Swift avant `bun build` |
| `src/types/assets.d.ts` | Déclaration du module pour le binaire de la sonde |

## Additions à `src/config.ts`

```ts
export type Config = {
  mac: { serviceName: string; ip: string; subnetMask: string };
  windows: { interfaceAlias: string; ip: string; prefixLength: number };
  ssh: SSHTarget;
  bootstrapPort: number;
  apollo: ApolloConfig;
  moonlight: MoonlightConfig;
  smb: SMBConfig;
};

export type ApolloConfig = {
  /** Version visée. Sert au contrôle d'idempotence et au message d'écart. */
  version: string;
  /** URL exacte de l'artefact NSIS. */
  installerUrl: string;
  /** Empreinte SHA-256 minuscule, vérifiée avant toute exécution. */
  installerSha256: string;
  /** Répertoire d'installation imposé par `/D=`. */
  installDir: string;
  /** Nom exact du service Windows. */
  serviceName: string;
  /** Port HTTPS de l'interface et de l'API. */
  apiPort: number;
  /** Compte de l'interface web, créé par hardline. */
  webUser: string;
};

export type MoonlightConfig = {
  /** Nom du cask Homebrew. */
  cask: string;
  /** Chemin du binaire en ligne de commande, posé par le cask. */
  binary: string;
  /** Nom sous lequel ce Mac s'annonce à Apollo. */
  clientName: string;
  /** Application Apollo à lancer. "Desktop" est câblée dans le binaire. */
  app: string;
};

export type SMBConfig = {
  /** Compte Windows employé pour les partages. */
  user: string;
  /** Partages à monter, dans l'ordre. */
  shares: readonly SMBShare[];
};

export type SMBShare = {
  /** Nom du partage côté Windows. */
  name: string;
  /** Chemin Windows partagé. `null` quand le partage préexiste et n'est pas à créer. */
  path: string | null;
  /** Point de montage sur le Mac, sous /Volumes. */
  mountPoint: string;
};
```

Valeurs de `CONFIG` :

```ts
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
  binary: "/opt/homebrew/bin/moonlight",
  clientName: "hardline-mac",
  app: "Desktop",
},
smb: {
  user: "arthur",
  shares: [
    { name: "arthur", path: null, mountPoint: "/Volumes/pc-arthur" },
    { name: "hardline-d", path: "D:\\", mountPoint: "/Volumes/pc-d" },
    { name: "hardline-e", path: "E:\\", mountPoint: "/Volumes/pc-e" },
  ],
},
```

L'adresse matérielle du PC n'est PAS en configuration : elle est lue au moment
du réveil dans la table ARP, et le PC de référence répond `e8:9c:25:2a:70:e1`.
La coder en dur ferait mentir la promesse « un nouveau PC ».

## `src/lib/display.ts`

```ts
export type Display = {
  /** Définition réelle en pixels. */
  widthPx: number;
  heightPx: number;
  /** Fréquence en hertz. 0 quand le système ne la rapporte pas. */
  refreshHz: number;
  /** Taille en points, c'est-à-dire l'échelle vue par l'interface. */
  widthPt: number;
  heightPt: number;
  /** L'écran où s'ouvre une fenêtre neuve. */
  main: boolean;
};

/** Fonction pure. Lit la sortie de la sonde, une ligne par écran. */
export function parseDisplays(stdout: string): Display[];

/** Frontière système : lance la sonde embarquée et rend les écrans. */
export async function listDisplays(): Promise<Display[]>;

/** L'écran principal, ou le premier à défaut, ou null si aucun. */
export function mainDisplay(displays: Display[]): Display | null;
```

Format imposé de la sonde, une ligne par écran, champs séparés par une
tabulation, sans en-tête :

```
3456\t2234\t120.0\t1728\t1117\t1
2560\t1440\t144.0\t2560\t1440\t0
```

## `src/lib/keychain.ts`

```ts
/** Étiquette de service dans le trousseau. Préfixe commun à tous nos secrets. */
export const KEYCHAIN_SERVICE = "hardline";

export type SecretName = "apollo-web" | "windows-account";

/** Range un secret. Écrase silencieusement s'il existe déjà. */
export async function setSecret(name: SecretName, value: string): Promise<void>;

/** Relit un secret. `null` s'il n'existe pas. Ne lève jamais pour une absence. */
export async function getSecret(name: SecretName): Promise<string | null>;

/** Retire un secret. Rend `true` s'il existait. */
export async function deleteSecret(name: SecretName): Promise<boolean>;

/** Un mot de passe aléatoire imprimable, pour l'interface d'Apollo. */
export function generatePassword(length?: number): string;

/** Un code d'appairage à quatre chiffres, zéros en tête compris. */
export function generatePin(): string;
```

## `src/lib/wol.ts`

```ts
/** Fonction pure. Compose les 102 octets : 6 fois 0xFF puis 16 fois l'adresse. */
export function magicPacket(mac: string): Uint8Array;

/** Fonction pure. Lit une adresse matérielle dans la sortie de `arp -n`. */
export function parseArpMac(stdout: string): string | null;

/** Frontière système. Lit la table ARP pour une adresse IP. */
export async function lookupMac(ip: string): Promise<string | null>;

/** Frontière système. Émet le paquet en diffusion sur le port 9. */
export async function sendMagicPacket(mac: string, broadcast: string): Promise<void>;
```

## `src/lib/apollo-api.ts`

```ts
export type ApolloClient = { name: string; uuid: string };

export type ApolloCredentials = { user: string; password: string };

/** Fonction pure. Lit la réponse de /api/clients/list. */
export function parseClientList(body: unknown): ApolloClient[];

/** POST /api/pin. Rend ce que le serveur prétend, sans le croire. */
export async function sendPin(
  config: Config, creds: ApolloCredentials, pin: string, name: string,
): Promise<boolean>;

/** GET /api/clients/list. C'est LUI qui fait foi, pas la réponse de sendPin. */
export async function listClients(
  config: Config, creds: ApolloCredentials,
): Promise<ApolloClient[]>;

/** POST /api/clients/unpair pour un client donné. */
export async function unpairClient(
  config: Config, creds: ApolloCredentials, uuid: string,
): Promise<void>;

/** GET /api/config. Sert de test de vie authentifié. */
export async function apiReachable(
  config: Config, creds: ApolloCredentials,
): Promise<boolean>;
```

Le relâchement TLS est confiné à ce fichier, par `tls: { rejectUnauthorized: false }`
sur chaque appel `fetch`. La variable d'environnement `NODE_TLS_REJECT_UNAUTHORIZED`
est interdite : elle n'est pas fiable sous Bun et porterait bien au-delà de ce client.

## `src/lib/apollo-conf.ts`

```ts
/** Les six clés que hardline impose. Rien d'autre n'est touché. */
export const REQUIRED_CONF: Readonly<Record<string, string>>;

/** Fonction pure. Lit un sunshine.conf en paires clé/valeur. */
export function parseConf(text: string): Record<string, string>;

/** Fonction pure. Rend le texte du fichier avec les clés imposées, en
 *  préservant les clés et les commentaires que hardline ne gère pas. */
export function patchConf(text: string, required: Record<string, string>): string;

/** Fonction pure. Vrai si toutes les clés imposées ont déjà la bonne valeur. */
export function confConforms(text: string, required: Record<string, string>): boolean;
```

Valeur de `REQUIRED_CONF` :

```ts
{
  headless_mode: "enabled",
  dd_configuration_option: "ensure_only_display",
  dd_resolution_option: "auto",
  dd_refresh_rate_option: "auto",
  dd_config_revert_on_disconnect: "enabled",
  capture: "ddx",
}
```

## `src/lib/moonlight.ts`

```ts
export type StreamOptions = {
  /** Fenêtré redimensionnable par défaut ; plein écran sur demande. */
  fullscreen: boolean;
  /** Définition imposée, ou null pour celle de l'écran détecté. */
  resolution: { width: number; height: number } | null;
  /** Fréquence imposée, ou null pour celle de l'écran détecté. */
  fps: number | null;
};

/** Fonction pure. Compose `moonlight pair <hôte> --pin <code>`. */
export function pairArgs(config: Config, pin: string): string[];

/** Fonction pure. Compose la ligne de streaming à partir de l'écran et des options. */
export function streamArgs(
  config: Config, display: Display | null, options: StreamOptions,
): string[];

/** Fonction pure. Compose `moonlight quit <hôte>`. */
export function quitArgs(config: Config): string[];

/** Frontière système. Lance l'appairage sans attendre sa fin. */
export function spawnPair(config: Config, pin: string): { kill(): void };

/** Frontière système. Lance le flux et attend sa fin. Rend le code de sortie. */
export async function runStream(
  config: Config, display: Display | null, options: StreamOptions,
): Promise<number>;

/** Frontière système. Clôt la session côté serveur. */
export async function runQuit(config: Config): Promise<void>;
```

Le débit n'apparaît nulle part : la spec le laisse au choix de Moonlight.
Le HDR n'apparaît nulle part : il est hors périmètre v1.

## `src/lib/smb.ts`

```ts
/** Fonction pure. Compose l'URL smb://utilisateur:motdepasse@hôte/partage. */
export function smbUrl(
  host: string, user: string, password: string, share: string,
): string;

/** Frontière système. Monte un partage. Crée le point de montage au besoin. */
export async function mountShare(
  share: SMBShare, config: Config, password: string,
): Promise<void>;

/** Frontière système. Démonte. Ne lève pas si le partage n'était pas monté. */
export async function unmountShare(share: SMBShare): Promise<void>;

/** Frontière système. Vrai si le point de montage porte un volume SMB. */
export async function isMounted(share: SMBShare): Promise<boolean>;
```

Le mot de passe est cité pour une URL, jamais pour un shell : il passe par
`encodeURIComponent`. Il ne doit apparaître dans aucun message d'erreur.

## Étapes : noms et types de relevé

| `name` | `label` | Type du relevé `P` |
|---|---|---|
| `apollo-install` | `Serveur Apollo installé (PC)` | `ApolloInstallState` |
| `apollo-config` | `Configuration et identifiants Apollo (PC)` | `ApolloConfState` |
| `apollo-service` | `Service Apollo au démarrage (PC)` | `ServiceState` |
| `smb-shares` | `Partages des disques D: et E: (PC)` | `ShareState[]` |
| `moonlight-install` | `Client Moonlight installé (Mac)` | `MoonlightState` |
| `pairing` | `Mac appairé au serveur (Mac)` | `PairingState` |
| `smb-credentials` | `Identifiants des partages au trousseau (Mac)` | `CredentialState` |

```ts
export type ApolloInstallState = {
  /** Présent avant notre passage ? */
  installed: boolean;
  /** Version trouvée, ou null. */
  version: string | null;
  /** Posé par hardline lors d'une exécution antérieure ? */
  ours: boolean;
  /** Chemin de la sauvegarde de config d'un Apollo étranger, ou null. */
  backupPath: string | null;
  /** Nombre de clients appairés trouvés. Sert au message de confirmation. */
  pairedClients: number;
};

export type ApolloConfState = {
  /** Contenu intégral du sunshine.conf d'avant, ou null s'il n'existait pas. */
  conf: string | null;
  /** Des identifiants web existaient-ils ? */
  hadCredentials: boolean;
};

export type ServiceState = {
  /** `auto`, `demand`, `disabled`, ou null si le service n'existait pas. */
  startType: string | null;
  /** `Running`, `Stopped`, ou null. */
  status: string | null;
};

export type ShareState = { name: string; existed: boolean };

export type MoonlightState = { installed: boolean; version: string | null };

export type PairingState = {
  /** UUID des clients appairés avant notre passage. */
  clients: readonly string[];
  /** Le plist du Mac connaissait-il déjà cet hôte ? */
  hostKnown: boolean;
};

export type CredentialState = { present: boolean };
```

Le marqueur « posé par hardline » d'`ApolloInstallState.ours` est un fichier
`.hardline` déposé dans `installDir` à l'installation. Il ne s'appuie sur aucune
heuristique : soit le marqueur est là, soit l'installation est étrangère.

## Ordre d'application

```ts
LOCAL_STEPS  = [macNetworkStep, moonlightInstallStep, smbCredentialsStep]
CAPTURE_STEPS = [bootstrapWindowsStep]                     // inchangé
REMOTE_STEPS = [windowsNetworkStep, windowsProfileTaskStep,
                apolloInstallStep, apolloConfigStep, apolloServiceStep,
                smbSharesStep, pairingStep]
```

`pairingStep` est en DERNIER et parmi les étapes distantes, alors qu'il agit des
deux côtés : il exige qu'Apollo tourne, donc il ne peut passer avant
`apolloServiceStep`. La restauration se faisant en ordre inverse, il se défait en
premier — ce qui est également correct : on dépaire tant que le serveur répond.

---

### Tâche 1 : Détecteur d'écran

**Fichiers :**
- Créer : `tools/display-probe.swift`
- Créer : `src/lib/display.ts`
- Modifier : `package.json`
- Modifier : `src/types/assets.d.ts`
- Test : `test/lib/display.test.ts`

**Interfaces :**
- Consomme : rien des tâches antérieures.
- Produit : `Display` (type), `parseDisplays(stdout: string): Display[]`, `mainDisplay(displays: Display[]): Display | null`, `listDisplays(): Promise<Display[]>` — noms exacts d'`interfaces.md`, consommés plus tard par `src/lib/moonlight.ts` et `src/commands/up.ts` (hors périmètre de ce document).

Point de conception vérifié empiriquement (à ne pas rouvrir en cours d'exécution) : un `import ... with { type: "file" }` **statique** en tête de fichier fait échouer le chargement de **tout le module** dès que le binaire visé est absent du disque — donc `bun test` échouerait sur les fonctions pures elles-mêmes tant que `bun run build` n'a pas tourné une fois. La solution retenue, testée et confirmée par une compilation `bun build --compile` réelle qui a produit un exécutable extrayant, rendant exécutable, lançant et supprimant la sonde avec succès : l'import se fait en **dynamique**, à l'intérieur de `listDisplays`, avec `await import("../assets/display-probe.bin", { with: { type: "file" } })`. Les fonctions pures ne le déclenchent jamais.

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/lib/display.test.ts
import { test, expect, describe } from "bun:test";
import { parseDisplays, mainDisplay } from "../../src/lib/display";

const TWO_SCREENS =
  "3456\t2234\t120.0\t1728\t1117\t1\n2560\t1440\t144.0\t2560\t1440\t0\n";

const NO_MAIN_FLAGGED =
  "3456\t2234\t120.0\t1728\t1117\t0\n2560\t1440\t144.0\t2560\t1440\t0\n";

describe("parseDisplays", () => {
  test("lit les deux écrans de la machine de référence", () => {
    expect(parseDisplays(TWO_SCREENS)).toEqual([
      {
        widthPx: 3456,
        heightPx: 2234,
        refreshHz: 120.0,
        widthPt: 1728,
        heightPt: 1117,
        main: true,
      },
      {
        widthPx: 2560,
        heightPx: 1440,
        refreshHz: 144.0,
        widthPt: 2560,
        heightPt: 1440,
        main: false,
      },
    ]);
  });

  test("rend un tableau vide sur une sortie vide", () => {
    expect(parseDisplays("")).toEqual([]);
  });

  test("ignore une ligne à qui il manque un champ, sans lever", () => {
    const malformed =
      "3456\t2234\t120.0\t1728\t1117\n2560\t1440\t144.0\t2560\t1440\t0\n";
    expect(parseDisplays(malformed)).toEqual([
      {
        widthPx: 2560,
        heightPx: 1440,
        refreshHz: 144.0,
        widthPt: 2560,
        heightPt: 1440,
        main: false,
      },
    ]);
  });

  test("distingue 0 et 1 pour le drapeau principal", () => {
    const [first, second] = parseDisplays(TWO_SCREENS);
    expect(first?.main).toBe(true);
    expect(second?.main).toBe(false);
  });
});

describe("mainDisplay", () => {
  test("rend l'écran marqué principal", () => {
    const displays = parseDisplays(TWO_SCREENS);
    expect(mainDisplay(displays)?.widthPx).toBe(3456);
  });

  test("rend le premier écran si aucun n'est marqué principal", () => {
    const displays = parseDisplays(NO_MAIN_FLAGGED);
    expect(mainDisplay(displays)?.widthPx).toBe(3456);
  });

  test("rend null pour un tableau vide", () => {
    expect(mainDisplay([])).toBeNull();
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/lib/display.test.ts`
Attendu : ÉCHEC avec « Cannot find module '../../src/lib/display' » (le fichier n'existe pas encore).

- [ ] **Étape 3 : Écrire l'implémentation minimale**

D'abord la sonde Swift, adaptée du code déjà vérifié sur la machine de référence (elle y rendait `3456x2234 @ 120.0 Hz points=1728x1117 principal=true`) au format à six champs imposé par `interfaces.md`. `CGDisplayCopyDisplayMode` donne la définition en pixels et la fréquence ; `CGDisplayBounds`, dont le repère est en points, donne la taille en points ; `CGDisplayIsMain` donne le drapeau principal.

```swift
// tools/display-probe.swift
import CoreGraphics
import Foundation

// Interroge CoreGraphics et imprime une ligne par ecran actif, six champs
// separes par une tabulation, sans en-tete :
// largeur px, hauteur px, frequence Hz, largeur pt, hauteur pt, principal (1/0).

let maxDisplays: UInt32 = 16
var displayIDs = [CGDirectDisplayID](repeating: 0, count: Int(maxDisplays))
var displayCount: UInt32 = 0

let listResult = CGGetActiveDisplayList(maxDisplays, &displayIDs, &displayCount)
if listResult != .success {
    FileHandle.standardError.write("display-probe: CGGetActiveDisplayList a echoue\n".data(using: .utf8)!)
    exit(1)
}

for index in 0..<Int(displayCount) {
    let displayID = displayIDs[index]
    guard let mode = CGDisplayCopyDisplayMode(displayID) else { continue }

    let widthPx = mode.pixelWidth
    let heightPx = mode.pixelHeight
    let refreshHz = mode.refreshRate
    let bounds = CGDisplayBounds(displayID)
    let widthPt = Int(bounds.width.rounded())
    let heightPt = Int(bounds.height.rounded())
    let isMain = CGDisplayIsMain(displayID) != 0

    let refreshField = String(format: "%.1f", refreshHz)
    print("\(widthPx)\t\(heightPx)\t\(refreshField)\t\(widthPt)\t\(heightPt)\t\(isMain ? 1 : 0)")
}
```

Puis le module TypeScript :

```ts
// src/lib/display.ts
import { $ } from "bun";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Display = {
  /** Definition reelle en pixels. */
  widthPx: number;
  heightPx: number;
  /** Frequence en hertz. 0 quand le systeme ne la rapporte pas. */
  refreshHz: number;
  /** Taille en points, c'est-a-dire l'echelle vue par l'interface. */
  widthPt: number;
  heightPt: number;
  /** L'ecran ou s'ouvre une fenetre neuve. */
  main: boolean;
};

const FIELD_COUNT = 6;

/** Fonction pure. Lit la sortie de la sonde, une ligne par ecran. */
export function parseDisplays(stdout: string): Display[] {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const displays: Display[] = [];

  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length !== FIELD_COUNT) continue;

    const [widthPx, heightPx, refreshHz, widthPt, heightPt, main] = fields;

    displays.push({
      widthPx: Number(widthPx),
      heightPx: Number(heightPx),
      refreshHz: Number(refreshHz),
      widthPt: Number(widthPt),
      heightPt: Number(heightPt),
      main: main === "1",
    });
  }

  return displays;
}

/** L'ecran principal, ou le premier a defaut, ou null si aucun. */
export function mainDisplay(displays: Display[]): Display | null {
  return displays.find((display) => display.main) ?? displays[0] ?? null;
}

// --- Frontiere systeme. Aucune logique ici, seulement l'extraction et l'appel. ---

export async function listDisplays(): Promise<Display[]> {
  // Import dynamique et non statique : un import statique en tete de fichier
  // ferait echouer le chargement du module entier des que le binaire compile
  // est absent, ce qui casserait les tests des fonctions pures ci-dessus tant
  // que `bun run build` n'a pas tourne une fois.
  const probe = await import("../assets/display-probe.bin", {
    with: { type: "file" },
  });
  const embeddedPath: string = probe.default;

  const tmpPath = join(tmpdir(), `hardline-display-probe-${randomUUID()}`);
  await Bun.write(tmpPath, Bun.file(embeddedPath));
  await $`chmod +x ${tmpPath}`.quiet().nothrow();

  try {
    const { stdout } = await $`${tmpPath}`.quiet().nothrow();
    return parseDisplays(stdout.toString());
  } finally {
    await $`rm -f ${tmpPath}`.quiet().nothrow();
  }
}
```

Modifier `src/types/assets.d.ts` — ajouter la déclaration du module pour le binaire de la sonde, à la suite de celle de `*.ps1` déjà présente :

```ts
declare module "*.ps1" {
  const path: string;
  export default path;
}

declare module "*.bin" {
  const path: string;
  export default path;
}
```

Modifier `package.json` — dans `"scripts"`, remplacer la ligne `"build"` :

```diff
-    "build": "bun run scripts/build.ts"
+    "build": "swiftc -O tools/display-probe.swift -o src/assets/display-probe.bin && bun run scripts/build.ts"
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/lib/display.test.ts`
Attendu : 7 tests, 0 échec. Aucun n'exige que `src/assets/display-probe.bin` existe : ils n'exercent que `parseDisplays` et `mainDisplay`.

Vérifier ensuite la chaîne de construction réelle, qui n'est pas couverte par `bun test` :

Commande : `bun run build`
Attendu : `swiftc` compile sans avertissement, produit `src/assets/display-probe.bin` (environ 54 Ko), puis `bun run scripts/build.ts` produit `./dist/hardline` sans erreur.

Puis `bunx tsc --noEmit`
Attendu : silence complet.

- [ ] **Étape 5 : Commiter**

```bash
git add tools/display-probe.swift src/lib/display.ts test/lib/display.test.ts package.json src/types/assets.d.ts
git commit -m "$(cat <<'EOF'
Ajoute le detecteur d'ecran embarque (sonde Swift + parsing)

La sonde interroge CoreGraphics et est compilee au bun run build, puis
embarquee dans l'executable comme asset, sur le meme motif que
bootstrap.ps1. listDisplays l'extrait dans un fichier temporaire,
l'execute et le supprime ; parseDisplays et mainDisplay sont pures et
testees seules.
EOF
)"
```

---

### Tâche 2 : Coffre

**Fichiers :**
- Créer : `src/lib/keychain.ts`
- Test : `test/lib/keychain.test.ts`

**Interfaces :**
- Consomme : rien des tâches antérieures.
- Produit : `KEYCHAIN_SERVICE`, `SecretName`, `setSecret`, `getSecret`, `deleteSecret`, `generatePassword`, `generatePin` — noms exacts d'`interfaces.md`, consommés plus tard par `src/steps/apollo-config.ts`, `src/steps/smb-credentials.ts` et `src/steps/pairing.ts`.

Conformément au style du projet (`shell.ts`/`ssh.ts` : seules les fonctions pures sont testées, les frontières système restent en bas de fichier, non exercées par `bun test`), seules `generatePassword` et `generatePin` ont une logique propre à tester. `setSecret`, `getSecret` et `deleteSecret` ne font qu'appeler `/usr/bin/security` et transmettre son code de sortie ; les commandes exactes ont été vérifiées à la main sur ce Mac (`add-generic-password ... -U`, `find-generic-password ... -w`, `delete-generic-password`), y compris le comportement mesuré : `find-generic-password` sur un secret absent sort en code 44 sans rien écrire sur la sortie standard (d'où `getSecret` qui rend `null` sur tout code non nul, jamais une levée), et sur un secret présent la valeur revient suivie d'un saut de ligne à retirer.

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/lib/keychain.test.ts
import { test, expect, describe, spyOn } from "bun:test";
import { KEYCHAIN_SERVICE, generatePassword, generatePin } from "../../src/lib/keychain";

describe("KEYCHAIN_SERVICE", () => {
  test("vaut hardline, l'étiquette de service commune à tous les secrets", () => {
    expect(KEYCHAIN_SERVICE).toBe("hardline");
  });
});

describe("generatePassword", () => {
  test("rend une chaîne de la longueur par défaut", () => {
    expect(generatePassword()).toHaveLength(24);
  });

  test("respecte une longueur explicite", () => {
    expect(generatePassword(12)).toHaveLength(12);
  });

  test("ne contient que des caractères imprimables, sans espace ni guillemet", () => {
    const password = generatePassword(64);
    expect(password).toMatch(/^[A-Za-z0-9!@#$%^&*\-_=+]+$/);
  });

  test("deux tirages successifs ne coïncident jamais", () => {
    expect(generatePassword()).not.toBe(generatePassword());
  });
});

describe("generatePin", () => {
  test("rend toujours quatre chiffres", () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePin()).toMatch(/^\d{4}$/);
    }
  });

  test("conserve les zéros en tête", () => {
    // Force la valeur tiree pour prouver que le remplissage a zero fonctionne,
    // au lieu d'attendre au hasard un tirage qui commence par zero.
    const spy = spyOn(crypto, "getRandomValues").mockImplementation(
      (<T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint32Array) array[0] = 7;
        return array;
      }) as typeof crypto.getRandomValues,
    );
    try {
      expect(generatePin()).toBe("0007");
    } finally {
      spy.mockRestore();
    }
  });

  test("deux tirages non forcés ne coïncident pas systématiquement", () => {
    const pins = new Set(Array.from({ length: 20 }, () => generatePin()));
    expect(pins.size).toBeGreaterThan(1);
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/lib/keychain.test.ts`
Attendu : ÉCHEC avec « Cannot find module '../../src/lib/keychain' » (le fichier n'existe pas encore).

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/lib/keychain.ts
import { $ } from "bun";

export const KEYCHAIN_SERVICE = "hardline";

export type SecretName = "apollo-web" | "windows-account";

const PASSWORD_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*-_=+";
const DEFAULT_PASSWORD_LENGTH = 24;
const PIN_MODULUS = 10000;
const PIN_DIGITS = 4;

/** Un mot de passe aleatoire imprimable, pour l'interface d'Apollo. */
export function generatePassword(length = DEFAULT_PASSWORD_LENGTH): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PASSWORD_ALPHABET[bytes[i]! % PASSWORD_ALPHABET.length];
  }
  return out;
}

/** Un code d'appairage a quatre chiffres, zeros en tete compris. */
export function generatePin(): string {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  const value = buffer[0]! % PIN_MODULUS;
  return value.toString().padStart(PIN_DIGITS, "0");
}

// --- Frontiere systeme. Aucune logique ici, seulement l'appel a /usr/bin/security. ---

/** Range un secret. Ecrase silencieusement s'il existe deja. */
export async function setSecret(name: SecretName, value: string): Promise<void> {
  await $`/usr/bin/security add-generic-password -a ${name} -s ${KEYCHAIN_SERVICE} -w ${value} -U`
    .quiet();
}

/** Relit un secret. `null` s'il n'existe pas. Ne leve jamais pour une absence. */
export async function getSecret(name: SecretName): Promise<string | null> {
  const { stdout, exitCode } =
    await $`/usr/bin/security find-generic-password -a ${name} -s ${KEYCHAIN_SERVICE} -w`
      .quiet()
      .nothrow();
  if (exitCode !== 0) return null;
  const value = stdout.toString().replace(/\n$/, "");
  return value === "" ? null : value;
}

/** Retire un secret. Rend `true` s'il existait. */
export async function deleteSecret(name: SecretName): Promise<boolean> {
  const { exitCode } =
    await $`/usr/bin/security delete-generic-password -a ${name} -s ${KEYCHAIN_SERVICE}`
      .quiet()
      .nothrow();
  return exitCode === 0;
}
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/lib/keychain.test.ts`
Attendu : 8 tests, 0 échec.

Commande : `bunx tsc --noEmit`
Attendu : silence complet.

- [ ] **Étape 5 : Commiter**

```bash
git add src/lib/keychain.ts test/lib/keychain.test.ts
git commit -m "$(cat <<'EOF'
Ajoute le coffre : secrets par /usr/bin/security, jamais l'API native

setSecret, getSecret et deleteSecret passent exclusivement par le
binaire /usr/bin/security pour que l'application de confiance
inscrite dans la liste de controle d'acces reste la meme d'une
version de hardline a l'autre. generatePassword et generatePin
s'appuient sur crypto.getRandomValues, jamais Math.random.
EOF
)"
```

---

### Tâche 3 : Réveil réseau

**Fichiers :**
- Créer : `src/lib/wol.ts`
- Test : `test/lib/wol.test.ts`

**Interfaces :**
- Consomme : rien des tâches antérieures.
- Produit : `magicPacket`, `parseArpMac`, `lookupMac`, `sendMagicPacket` — noms exacts d'`interfaces.md`, consommés plus tard par `src/commands/up.ts`.

Point vérifié à la main sur cette machine : `arp -n 10.10.10.1` rend `? (10.10.10.1) at e8:9c:25:2a:70:e1 on en14 ifscope [ethernet]`. macOS abrège chaque octet à un seul chiffre hexadécimal quand le premier est nul (`8:0:27:12:34:56` plutôt que `08:00:27:12:34:56`) : `parseArpMac` ne normalise pas — il rend l'adresse telle qu'`arp` l'a écrite — et c'est `magicPacket` qui doit accepter les deux formes, ce que `parseInt(part, 16)` fait nativement pour `"8"` comme pour `"08"`.

Point vérifié empiriquement sur l'API : `Bun.udpSocket` **n'a pas** d'option `broadcast` à la création (`{ broadcast: true }` échoue au typage — `bun-types` ne connaît pas cette clé). La diffusion s'active après coup par `socket.setBroadcast(true)`. Un appel réel à `sendMagicPacket("e8:9c:25:2a:70:e1", "255.255.255.255")` a été exécuté sur cette machine et s'est terminé sans erreur.

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/lib/wol.test.ts
import { test, expect, describe } from "bun:test";
import { magicPacket, parseArpMac } from "../../src/lib/wol";

const ARP_FULL =
  "? (10.10.10.1) at e8:9c:25:2a:70:e1 on en14 ifscope [ethernet]\n";

const ARP_ABBREVIATED =
  "? (10.10.10.1) at 8:0:27:12:34:56 on en14 ifscope [ethernet]\n";

const ARP_NO_ENTRY = "10.10.10.1 (10.10.10.1) -- no entry\n";

describe("magicPacket", () => {
  test("fait exactement 102 octets", () => {
    expect(magicPacket("e8:9c:25:2a:70:e1")).toHaveLength(102);
  });

  test("commence par six octets 0xFF", () => {
    const packet = magicPacket("e8:9c:25:2a:70:e1");
    expect(Array.from(packet.slice(0, 6))).toEqual([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
  });

  test("répète l'adresse seize fois après le préambule", () => {
    const packet = magicPacket("e8:9c:25:2a:70:e1");
    const macBytes = [0xe8, 0x9c, 0x25, 0x2a, 0x70, 0xe1];
    for (let rep = 0; rep < 16; rep++) {
      const start = 6 + rep * 6;
      expect(Array.from(packet.slice(start, start + 6))).toEqual(macBytes);
    }
  });

  test("accepte les octets abrégés macOS à un seul chiffre", () => {
    const packet = magicPacket("8:0:27:12:34:56");
    const macBytes = [0x08, 0x00, 0x27, 0x12, 0x34, 0x56];
    expect(Array.from(packet.slice(6, 12))).toEqual(macBytes);
    expect(Array.from(packet.slice(96, 102))).toEqual(macBytes);
  });

  test("lève une erreur sur une adresse illisible", () => {
    expect(() => magicPacket("pas une adresse")).toThrow();
  });
});

describe("parseArpMac", () => {
  test("lit l'adresse matérielle complète de la sortie arp -n", () => {
    expect(parseArpMac(ARP_FULL)).toBe("e8:9c:25:2a:70:e1");
  });

  test("lit une adresse avec des octets abrégés à un chiffre", () => {
    expect(parseArpMac(ARP_ABBREVIATED)).toBe("8:0:27:12:34:56");
  });

  test("rend null quand arp ne connaît pas l'hôte", () => {
    expect(parseArpMac(ARP_NO_ENTRY)).toBeNull();
  });

  test("rend null sur une sortie vide", () => {
    expect(parseArpMac("")).toBeNull();
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/lib/wol.test.ts`
Attendu : ÉCHEC avec « Cannot find module '../../src/lib/wol' » (le fichier n'existe pas encore).

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/lib/wol.ts
import { $ } from "bun";

const MAGIC_PACKET_BYTES = 102;
const PREAMBLE_BYTES = 6;
const MAC_BYTES = 6;
const MAC_REPETITIONS = 16;
const WOL_PORT = 9;

const MAC_PATTERN = /^([0-9a-fA-F]{1,2}:){5}[0-9a-fA-F]{1,2}$/;

/** Fonction pure. Compose les 102 octets : 6 fois 0xFF puis 16 fois l'adresse. */
export function magicPacket(mac: string): Uint8Array {
  if (!MAC_PATTERN.test(mac)) {
    throw new Error(`Adresse matérielle illisible : ${mac}`);
  }

  const macBytes = mac.split(":").map((part) => Number.parseInt(part, 16));

  const packet = new Uint8Array(MAGIC_PACKET_BYTES);
  packet.fill(0xff, 0, PREAMBLE_BYTES);

  for (let rep = 0; rep < MAC_REPETITIONS; rep++) {
    packet.set(macBytes, PREAMBLE_BYTES + rep * MAC_BYTES);
  }

  return packet;
}

// Capture un octet a un ou deux chiffres hex pour le premier groupe, puis
// cinq groupes identiques prefixes de ":". macOS abrege chaque octet nul en
// tete a un seul chiffre (ex. "8:0:27:12:34:56").
const ARP_LINE =
  /^\S+\s+\([\d.]+\)\s+at\s+([0-9a-fA-F]{1,2}(?::[0-9a-fA-F]{1,2}){5})\s+on\s+\S+/;

/** Fonction pure. Lit une adresse materielle dans la sortie de `arp -n`. */
export function parseArpMac(stdout: string): string | null {
  const match = stdout.match(ARP_LINE);
  return match ? match[1]!.toLowerCase() : null;
}

// --- Frontiere systeme. Aucune logique ici, seulement l'appel et l'envoi. ---

/** Frontiere systeme. Lit la table ARP pour une adresse IP. */
export async function lookupMac(ip: string): Promise<string | null> {
  const { stdout } = await $`arp -n ${ip}`.quiet().nothrow();
  return parseArpMac(stdout.toString());
}

/** Frontiere systeme. Emet le paquet en diffusion sur le port 9. */
export async function sendMagicPacket(mac: string, broadcast: string): Promise<void> {
  const packet = magicPacket(mac);
  const socket = await Bun.udpSocket({});
  try {
    socket.setBroadcast(true);
    socket.send(packet, WOL_PORT, broadcast);
  } finally {
    socket.close();
  }
}
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/lib/wol.test.ts`
Attendu : 9 tests, 0 échec.

Commande : `bunx tsc --noEmit`
Attendu : silence complet.

- [ ] **Étape 5 : Commiter**

```bash
git add src/lib/wol.ts test/lib/wol.test.ts
git commit -m "$(cat <<'EOF'
Ajoute le reveil reseau : paquet magique de 102 octets, lecture ARP

magicPacket et parseArpMac sont pures ; magicPacket accepte les
octets abreges macOS a un seul chiffre. lookupMac lit la table ARP et
sendMagicPacket emet en diffusion UDP sur le port 9 via Bun.udpSocket.
EOF
)"
```

---

### Tâche 4 : Client API Apollo

**Fichiers :**
- Créer : `src/lib/apollo-api.ts`
- Test : `test/lib/apollo-api.test.ts`

**Interfaces :**
- Consomme : `Config` (`src/config.ts`, blocs `ssh.host` et `apollo.apiPort`).
- Produit : `ApolloClient`, `ApolloCredentials` (types), `parseClientList(body: unknown): ApolloClient[]`, `sendPin(config, creds, pin, name): Promise<boolean>`, `listClients(config, creds): Promise<ApolloClient[]>`, `unpairClient(config, creds, uuid): Promise<void>`, `apiReachable(config, creds): Promise<boolean>` — noms exacts d'`interfaces.md`, consommés plus tard par `src/steps/apollo-config.ts` et `src/steps/pairing.ts`.

Point de conception à respecter à la lettre : `POST /api/pin` est documenté comme répondant parfois « c'est fait » alors qu'aucune session d'appairage n'est en attente côté serveur. `sendPin` rend donc tel quel ce que le serveur prétend (son champ `status`), sans jamais le vérifier lui-même ; c'est `GET /api/clients/list`, via `listClients`, qui fait foi. Le test ci-dessous verrouille cette distinction en faisant mentir `sendPin` (il rend `true`) pendant que `listClients` rend une liste vide pour le même appairage : les deux doivent pouvoir diverger sans que l'un lève à la place de l'autre.

Le relâchement TLS (`tls: { rejectUnauthorized: false }` sur chaque `fetch`) reste confiné à ce fichier. `NODE_TLS_REJECT_UNAUTHORIZED` est interdit.

Forme de réponse retenue pour `/api/clients/list`, conforme à l'API Sunshine dont Apollo dérive : `{"status": true, "named_certs": [{"name": "...", "uuid": "..."}]}`. `parseClientList` ignore silencieusement toute entrée qui n'a pas les deux champs `name` et `uuid` en chaîne, sans jamais lever.

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/lib/apollo-api.test.ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { Config } from "../../src/config";
import {
  parseClientList,
  sendPin,
  listClients,
  unpairClient,
  apiReachable,
} from "../../src/lib/apollo-api";

const CONFIG: Config = {
  mac: { serviceName: "AX88179A", ip: "10.10.10.2", subnetMask: "255.255.255.0" },
  windows: { interfaceAlias: "Ethernet", ip: "10.10.10.1", prefixLength: 24 },
  ssh: { host: "10.10.10.1", user: "arthur", identityFile: "/dev/null", connectTimeoutSec: 8 },
  bootstrapPort: 8080,
  apollo: {
    version: "0.4.6",
    installerUrl: "https://example.invalid/Apollo-0.4.6.exe",
    installerSha256: "42b2aefaacb3474511517a56b96ee9f0517f30ac38b5dd2fda9fd5b478f5021a",
    installDir: "C:\\Program Files\\Apollo",
    serviceName: "ApolloService",
    apiPort: 47990,
    webUser: "hardline",
  },
  moonlight: {
    cask: "moonlight",
    binary: "/opt/homebrew/bin/moonlight",
    clientName: "hardline-mac",
    app: "Desktop",
  },
  smb: {
    user: "arthur",
    shares: [
      { name: "arthur", path: null, mountPoint: "/Volumes/pc-arthur" },
      { name: "hardline-d", path: "D:\\", mountPoint: "/Volumes/pc-d" },
      { name: "hardline-e", path: "E:\\", mountPoint: "/Volumes/pc-e" },
    ],
  },
};

const CREDS = { user: "hardline", password: "s3cret!pw" };

type FetchCall = { url: string; init: BunFetchRequestInit };

let calls: FetchCall[];
let responses: Response[];
let originalFetch: typeof fetch;

beforeEach(() => {
  calls = [];
  responses = [];
  originalFetch = globalThis.fetch;
  // Cast via unknown : typeof fetch exige une propriete statique
  // `preconnect` que ce mock n'a pas a fournir pour ce que ce test verifie.
  globalThis.fetch = (async (input: string | URL | Request, init?: BunFetchRequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const response = responses.shift();
    if (!response) throw new Error("aucune reponse simulee disponible");
    return response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("parseClientList", () => {
  test("lit les clients depuis named_certs", () => {
    const clients = parseClientList({
      status: true,
      named_certs: [
        { name: "hardline-mac", uuid: "uuid-1" },
        { name: "autre-client", uuid: "uuid-2" },
      ],
    });
    expect(clients).toEqual([
      { name: "hardline-mac", uuid: "uuid-1" },
      { name: "autre-client", uuid: "uuid-2" },
    ]);
  });

  test("rend un tableau vide quand named_certs est absent", () => {
    expect(parseClientList({ status: true })).toEqual([]);
  });

  test("ignore les entrees malformees sans planter", () => {
    const body = { named_certs: [{ name: "x" }, null, 42, { name: "y", uuid: "uuid-3" }] };
    expect(() => parseClientList(body)).not.toThrow();
    expect(parseClientList(body)).toEqual([{ name: "y", uuid: "uuid-3" }]);
  });
});

describe("sendPin et listClients", () => {
  test("sendPin envoie le PIN et le nom en JSON, authentifie et TLS relache", async () => {
    responses.push(new Response(JSON.stringify({ status: true }), { status: 200 }));

    const result = await sendPin(CONFIG, CREDS, "4821", "hardline-mac");

    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://10.10.10.1:47990/api/pin");
    expect(JSON.parse(String(call.init.body))).toEqual({ pin: "4821", name: "hardline-mac" });

    const expectedAuth = `Basic ${Buffer.from(`${CREDS.user}:${CREDS.password}`).toString("base64")}`;
    expect((call.init.headers as Record<string, string>).Authorization).toBe(expectedAuth);
    expect(call.init.tls?.rejectUnauthorized).toBe(false);
  });

  test("sendPin rend ce que le serveur pretend sans qu'aucun appairage ne soit reellement en cours : c'est listClients qui fait foi", async () => {
    responses.push(new Response(JSON.stringify({ status: true }), { status: 200 }));
    responses.push(
      new Response(JSON.stringify({ status: true, named_certs: [] }), { status: 200 }),
    );

    const claimed = await sendPin(CONFIG, CREDS, "4821", "hardline-mac");
    const actual = await listClients(CONFIG, CREDS);

    expect(claimed).toBe(true);
    expect(actual).toEqual([]);
  });

  test("sendPin rend false quand le serveur refuse la requete", async () => {
    responses.push(new Response("", { status: 401 }));
    const result = await sendPin(CONFIG, CREDS, "4821", "hardline-mac");
    expect(result).toBe(false);
  });

  test("listClients leve quand le serveur repond en echec", async () => {
    responses.push(new Response("", { status: 500 }));
    await expect(listClients(CONFIG, CREDS)).rejects.toThrow("500");
  });

  test("listClients confirme un appairage reussi via named_certs", async () => {
    responses.push(
      new Response(
        JSON.stringify({ status: true, named_certs: [{ name: "hardline-mac", uuid: "uuid-9" }] }),
        { status: 200 },
      ),
    );
    const clients = await listClients(CONFIG, CREDS);
    expect(clients).toEqual([{ name: "hardline-mac", uuid: "uuid-9" }]);
  });
});

describe("unpairClient", () => {
  test("poste l'uuid et n'echoue pas quand le serveur confirme", async () => {
    responses.push(new Response(JSON.stringify({ status: true }), { status: 200 }));
    await expect(unpairClient(CONFIG, CREDS, "uuid-9")).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe("https://10.10.10.1:47990/api/clients/unpair");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ uuid: "uuid-9" });
  });

  test("leve quand le depairage echoue", async () => {
    responses.push(new Response("", { status: 404 }));
    await expect(unpairClient(CONFIG, CREDS, "uuid-inconnu")).rejects.toThrow("404");
  });
});

describe("apiReachable", () => {
  test("rend true quand /api/config repond", async () => {
    responses.push(new Response(JSON.stringify({}), { status: 200 }));
    expect(await apiReachable(CONFIG, CREDS)).toBe(true);
  });

  test("rend false sans lever quand la requete echoue", async () => {
    globalThis.fetch = (async () => {
      throw new Error("certificat refuse");
    }) as unknown as typeof fetch;
    await expect(apiReachable(CONFIG, CREDS)).resolves.toBe(false);
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/lib/apollo-api.test.ts`
Attendu : ÉCHEC avec « Cannot find module '../../src/lib/apollo-api' » (le fichier n'existe pas encore).

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/lib/apollo-api.ts
import type { Config } from "../config";

export type ApolloClient = { name: string; uuid: string };

export type ApolloCredentials = { user: string; password: string };

type ApolloRequestInit = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};

function apolloUrl(config: Config, path: string): string {
  return `https://${config.ssh.host}:${config.apollo.apiPort}${path}`;
}

function authHeader(creds: ApolloCredentials): string {
  return `Basic ${Buffer.from(`${creds.user}:${creds.password}`).toString("base64")}`;
}

/**
 * Point d'entree unique des appels HTTP. Le relachement TLS est confine ici,
 * jamais par NODE_TLS_REJECT_UNAUTHORIZED : cette variable n'est pas fiable
 * sous Bun et porterait bien au-dela de ce client.
 */
async function apolloFetch(
  config: Config,
  creds: ApolloCredentials,
  path: string,
  init: ApolloRequestInit = {},
): Promise<Response> {
  return fetch(apolloUrl(config, path), {
    method: init.method,
    body: init.body,
    headers: { ...init.headers, Authorization: authHeader(creds) },
    tls: { rejectUnauthorized: false },
  });
}

/** Fonction pure. Lit la reponse de /api/clients/list. */
export function parseClientList(body: unknown): ApolloClient[] {
  if (typeof body !== "object" || body === null) return [];

  const namedCerts = (body as Record<string, unknown>).named_certs;
  if (!Array.isArray(namedCerts)) return [];

  const clients: ApolloClient[] = [];
  for (const entry of namedCerts) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name === "string" && typeof record.uuid === "string") {
      clients.push({ name: record.name, uuid: record.uuid });
    }
  }
  return clients;
}

/**
 * POST /api/pin. Rend ce que le serveur pretend, sans le croire : ce point
 * d'entree est documente comme repondant parfois "c'est fait" alors qu'aucune
 * session d'appairage n'est en attente. C'est listClients qui fait foi.
 */
export async function sendPin(
  config: Config,
  creds: ApolloCredentials,
  pin: string,
  name: string,
): Promise<boolean> {
  try {
    const response = await apolloFetch(config, creds, "/api/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin, name }),
    });
    if (!response.ok) return false;

    const body = (await response.json()) as unknown;
    if (typeof body === "object" && body !== null && "status" in body) {
      return Boolean((body as Record<string, unknown>).status);
    }
    return true;
  } catch {
    return false;
  }
}

/** GET /api/clients/list. C'est LUI qui fait foi, pas la reponse de sendPin. */
export async function listClients(
  config: Config,
  creds: ApolloCredentials,
): Promise<ApolloClient[]> {
  const response = await apolloFetch(config, creds, "/api/clients/list", {
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(
      `liste des clients Apollo illisible (code ${response.status})`,
    );
  }
  const body = (await response.json()) as unknown;
  return parseClientList(body);
}

/** POST /api/clients/unpair pour un client donne. */
export async function unpairClient(
  config: Config,
  creds: ApolloCredentials,
  uuid: string,
): Promise<void> {
  const response = await apolloFetch(config, creds, "/api/clients/unpair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uuid }),
  });
  if (!response.ok) {
    throw new Error(
      `échec du dépairage Apollo pour ${uuid} (code ${response.status})`,
    );
  }
}

/** GET /api/config. Sert de test de vie authentifie. */
export async function apiReachable(
  config: Config,
  creds: ApolloCredentials,
): Promise<boolean> {
  try {
    const response = await apolloFetch(config, creds, "/api/config", {
      method: "GET",
    });
    return response.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/lib/apollo-api.test.ts`
Attendu : 12 tests, 0 échec. Puis `bunx tsc --noEmit` : silence complet.

- [ ] **Étape 5 : Commiter**

```bash
git add src/lib/apollo-api.ts test/lib/apollo-api.test.ts
git commit -m "$(cat <<'EOF'
Ajoute le client REST d'Apollo, TLS relache et authentifie

sendPin rend tel quel ce que /api/pin pretend, sans le croire : le
point d'entree est documente comme repondant parfois succes sans
appairage reel en attente. listClients, sur /api/clients/list, est la
seule source de verite ; un test verrouille explicitement le cas ou
les deux divergent. Le relachement TLS reste confine a ce fichier.
EOF
)"
```

---

### Tâche 5 : Configuration Apollo

**Fichiers :**
- Créer : `src/lib/apollo-conf.ts`
- Test : `test/lib/apollo-conf.test.ts`

**Interfaces :**
- Consomme : rien des tâches antérieures.
- Produit : `REQUIRED_CONF` (constante), `parseConf(text: string): Record<string, string>`, `patchConf(text, required): string`, `confConforms(text, required): boolean` — noms exacts d'`interfaces.md`, consommés plus tard par `src/steps/apollo-config.ts`.

`sunshine.conf` est un fichier « clé = valeur », une paire par ligne, sans sections. `patchConf` doit préserver tout ce que hardline ne gère pas : le fichier du PC de référence porte déjà `server_cmd = [{"name":"Bubbles",...}]`, une clé dont la valeur contient elle-même des `=` internes (JSON), et cette ligne doit ressortir identique. Une clé imposée déjà présente est remplacée sur place, à son emplacement d'origine, jamais dupliquée en fin de fichier ; une clé absente est ajoutée à la fin, dans l'ordre de `REQUIRED_CONF`. Toutes les fonctions sont pures : aucune frontière système dans ce fichier.

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/lib/apollo-conf.test.ts
import { test, expect, describe } from "bun:test";
import { REQUIRED_CONF, parseConf, patchConf, confConforms } from "../../src/lib/apollo-conf";

// Le fichier du PC de reference : une cle imposee deja presente mais fausse
// (headless_mode), cinq absentes, un commentaire, une cle etrangere, et
// server_cmd dont la valeur JSON doit survivre intacte au passage.
const CONF_FIXTURE = [
  "# Fichier genere par Apollo",
  "sunshine_name = PC-ARTHUR",
  "headless_mode = disabled",
  'server_cmd = [{"name":"Bubbles","cmd":"start bubbles.exe","elevated":false}]',
  "",
].join("\n");

describe("REQUIRED_CONF", () => {
  test("contient exactement les six cles imposees par Apollo", () => {
    expect(REQUIRED_CONF).toEqual({
      headless_mode: "enabled",
      dd_configuration_option: "ensure_only_display",
      dd_resolution_option: "auto",
      dd_refresh_rate_option: "auto",
      dd_config_revert_on_disconnect: "enabled",
      capture: "ddx",
    });
  });
});

describe("parseConf", () => {
  test("lit les paires cle/valeur et ignore commentaires et lignes vides", () => {
    const parsed = parseConf(CONF_FIXTURE);
    expect(parsed).toEqual({
      sunshine_name: "PC-ARTHUR",
      headless_mode: "disabled",
      server_cmd: '[{"name":"Bubbles","cmd":"start bubbles.exe","elevated":false}]',
    });
  });

  test("rend un objet vide sur un texte vide", () => {
    expect(parseConf("")).toEqual({});
  });
});

describe("confConforms", () => {
  test("est faux tant que les six cles ne sont pas exactement imposees", () => {
    expect(confConforms(CONF_FIXTURE, REQUIRED_CONF)).toBe(false);
  });

  test("est vrai sur un texte qui porte deja toutes les valeurs imposees", () => {
    const conforming = [
      "headless_mode = enabled",
      "dd_configuration_option = ensure_only_display",
      "dd_resolution_option = auto",
      "dd_refresh_rate_option = auto",
      "dd_config_revert_on_disconnect = enabled",
      "capture = ddx",
    ].join("\n");
    expect(confConforms(conforming, REQUIRED_CONF)).toBe(true);
  });
});

describe("patchConf", () => {
  test("preserve server_cmd, le commentaire et la cle etrangere sunshine_name", () => {
    const patched = patchConf(CONF_FIXTURE, REQUIRED_CONF);

    expect(patched).toContain("# Fichier genere par Apollo");
    expect(patched).toContain("sunshine_name = PC-ARTHUR");
    expect(patched).toContain(
      'server_cmd = [{"name":"Bubbles","cmd":"start bubbles.exe","elevated":false}]',
    );
  });

  test("remplace une cle imposee deja presente sur place, sans la dupliquer", () => {
    const patched = patchConf(CONF_FIXTURE, REQUIRED_CONF);
    const lines = patched.split("\n");

    const headlessLines = lines.filter((line) => line.startsWith("headless_mode"));
    expect(headlessLines).toEqual(["headless_mode = enabled"]);

    // Remplacee en place, donc toujours avant server_cmd qui suit dans
    // la fixture d'origine - pas rejetee a la fin avec les cles ajoutees.
    const headlessIndex = lines.indexOf("headless_mode = enabled");
    const serverCmdIndex = lines.findIndex((line) => line.startsWith("server_cmd"));
    expect(headlessIndex).toBeGreaterThanOrEqual(0);
    expect(headlessIndex).toBeLessThan(serverCmdIndex);
  });

  test("ajoute a la fin les cinq cles absentes de la fixture, chacune une seule fois", () => {
    const patched = patchConf(CONF_FIXTURE, REQUIRED_CONF);

    for (const [key, value] of Object.entries(REQUIRED_CONF)) {
      if (key === "headless_mode") continue;
      const line = `${key} = ${value}`;
      expect(patched).toContain(line);
      const occurrences = patched.split(line).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  test("rend un texte qui satisfait ensuite confConforms", () => {
    const patched = patchConf(CONF_FIXTURE, REQUIRED_CONF);
    expect(confConforms(patched, REQUIRED_CONF)).toBe(true);
  });

  test("appliquer patchConf une seconde fois ne change plus rien", () => {
    const once = patchConf(CONF_FIXTURE, REQUIRED_CONF);
    const twice = patchConf(once, REQUIRED_CONF);
    expect(twice).toBe(once);
  });

  test("ajoute toutes les cles imposees sur un fichier vide", () => {
    const patched = patchConf("", REQUIRED_CONF);
    expect(patched).toBe(
      "headless_mode = enabled\n" +
        "dd_configuration_option = ensure_only_display\n" +
        "dd_resolution_option = auto\n" +
        "dd_refresh_rate_option = auto\n" +
        "dd_config_revert_on_disconnect = enabled\n" +
        "capture = ddx\n",
    );
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/lib/apollo-conf.test.ts`
Attendu : ÉCHEC avec « Cannot find module '../../src/lib/apollo-conf' » (le fichier n'existe pas encore).

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/lib/apollo-conf.ts
/** Les six cles que hardline impose. Rien d'autre n'est touche. */
export const REQUIRED_CONF: Readonly<Record<string, string>> = {
  headless_mode: "enabled",
  dd_configuration_option: "ensure_only_display",
  dd_resolution_option: "auto",
  dd_refresh_rate_option: "auto",
  dd_config_revert_on_disconnect: "enabled",
  capture: "ddx",
};

/** Fonction pure. Lit un sunshine.conf en paires cle/valeur. */
export function parseConf(text: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "") continue;

    result[key] = value;
  }

  return result;
}

/**
 * Fonction pure. Rend le texte du fichier avec les cles imposees, en
 * preservant les cles et les commentaires que hardline ne gere pas. Une cle
 * deja presente est remplacee sur place ; une cle absente est ajoutee a la
 * fin, dans l'ordre de `required`.
 */
export function patchConf(text: string, required: Record<string, string>): string {
  const remaining = new Set(Object.keys(required));
  const lines = text.split("\n");

  const patched = lines.map((rawLine) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return rawLine;

    const eq = line.indexOf("=");
    if (eq === -1) return rawLine;

    const key = line.slice(0, eq).trim();
    if (!(key in required)) return rawLine;

    remaining.delete(key);
    return `${key} = ${required[key]!}`;
  });

  let result = patched.join("\n");

  if (remaining.size > 0) {
    if (result !== "" && !result.endsWith("\n")) result += "\n";
    for (const key of remaining) {
      result += `${key} = ${required[key]!}\n`;
    }
  }

  return result;
}

/** Fonction pure. Vrai si toutes les cles imposees ont deja la bonne valeur. */
export function confConforms(text: string, required: Record<string, string>): boolean {
  const parsed = parseConf(text);
  return Object.entries(required).every(([key, value]) => parsed[key] === value);
}
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/lib/apollo-conf.test.ts`
Attendu : 10 tests, 0 échec. Puis `bunx tsc --noEmit` : silence complet.

- [ ] **Étape 5 : Commiter**

```bash
git add src/lib/apollo-conf.ts test/lib/apollo-conf.test.ts
git commit -m "$(cat <<'EOF'
Ajoute la lecture et l'ecriture pures de sunshine.conf

patchConf remplace les six cles imposees sur place quand elles
existent deja et les ajoute en fin de fichier sinon, sans jamais
toucher aux cles ou commentaires etrangers : le fichier de reference
porte deja server_cmd, une cle non geree dont la valeur JSON contient
des signes egal internes, et elle doit en ressortir intacte.
EOF
)"
```

---

### Tâche 6 : Lignes de commande Moonlight

**Fichiers :**
- Créer : `src/lib/moonlight.ts`
- Test : `test/lib/moonlight.test.ts`

**Interfaces :**
- Consomme : `Config` (`src/config.ts`, blocs `ssh.host`, `moonlight.binary`, `moonlight.app`) ; `Display` (`src/lib/display.ts`, Tâche 1).
- Produit : `StreamOptions` (type), `pairArgs(config, pin): string[]`, `streamArgs(config, display, options): string[]`, `quitArgs(config): string[]`, `spawnPair(config, pin): { kill(): void }`, `runStream(config, display, options): Promise<number>`, `runQuit(config): Promise<void>` — noms exacts d'`interfaces.md`, consommés plus tard par `src/steps/pairing.ts` et `src/commands/up.ts`.

Sous-commandes réelles : `moonlight pair <hôte> --pin <4 chiffres>`, `moonlight stream <hôte> "<app>" [options]`, `moonlight quit <hôte>`. `pairArgs`, `streamArgs` et `quitArgs` composent les arguments **après** le nom du binaire ; les trois fonctions frontière (`spawnPair`, `runStream`, `runQuit`) préfixent `config.moonlight.binary` avant de lancer `Bun.spawn`. Options de streaming réelles : `--display-mode fullscreen|windowed|borderless`, `--resolution <L>x<H>`, `--fps <n>`. Le mode par défaut est `windowed` ; `options.fullscreen` bascule en `--display-mode fullscreen`. Ni débit ni HDR n'apparaissent nulle part.

`streamArgs` prend l'écran détecté et les options : les options gagnent quand elles sont fournies, l'écran sert de défaut, et quand aucun écran n'est détecté et qu'aucune option n'impose de définition, aucune option `--resolution`/`--fps` n'est passée du tout — Moonlight se débrouille seul. Trois tests distincts verrouillent ces trois cas.

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/lib/moonlight.test.ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { Config } from "../../src/config";
import type { Display } from "../../src/lib/display";
import {
  pairArgs,
  streamArgs,
  quitArgs,
  spawnPair,
  runStream,
  runQuit,
} from "../../src/lib/moonlight";

const CONFIG: Config = {
  mac: { serviceName: "AX88179A", ip: "10.10.10.2", subnetMask: "255.255.255.0" },
  windows: { interfaceAlias: "Ethernet", ip: "10.10.10.1", prefixLength: 24 },
  ssh: { host: "10.10.10.1", user: "arthur", identityFile: "/dev/null", connectTimeoutSec: 8 },
  bootstrapPort: 8080,
  apollo: {
    version: "0.4.6",
    installerUrl: "https://example.invalid/Apollo-0.4.6.exe",
    installerSha256: "42b2aefaacb3474511517a56b96ee9f0517f30ac38b5dd2fda9fd5b478f5021a",
    installDir: "C:\\Program Files\\Apollo",
    serviceName: "ApolloService",
    apiPort: 47990,
    webUser: "hardline",
  },
  moonlight: {
    cask: "moonlight",
    binary: "/opt/homebrew/bin/moonlight",
    clientName: "hardline-mac",
    app: "Desktop",
  },
  smb: {
    user: "arthur",
    shares: [
      { name: "arthur", path: null, mountPoint: "/Volumes/pc-arthur" },
      { name: "hardline-d", path: "D:\\", mountPoint: "/Volumes/pc-d" },
      { name: "hardline-e", path: "E:\\", mountPoint: "/Volumes/pc-e" },
    ],
  },
};

const MAIN_DISPLAY: Display = {
  widthPx: 3456,
  heightPx: 2234,
  refreshHz: 120,
  widthPt: 1728,
  heightPt: 1117,
  main: true,
};

describe("pairArgs", () => {
  test("compose moonlight pair <hote> --pin <code>", () => {
    expect(pairArgs(CONFIG, "4821")).toEqual(["pair", "10.10.10.1", "--pin", "4821"]);
  });
});

describe("quitArgs", () => {
  test("compose moonlight quit <hote>", () => {
    expect(quitArgs(CONFIG)).toEqual(["quit", "10.10.10.1"]);
  });
});

describe("streamArgs", () => {
  test("les options gagnent sur l'ecran detecte quand elles sont fournies", () => {
    const args = streamArgs(CONFIG, MAIN_DISPLAY, {
      fullscreen: true,
      resolution: { width: 3840, height: 2160 },
      fps: 60,
    });

    expect(args).toEqual([
      "stream",
      "10.10.10.1",
      "Desktop",
      "--display-mode",
      "fullscreen",
      "--resolution",
      "3840x2160",
      "--fps",
      "60",
    ]);
  });

  test("l'ecran detecte sert de defaut quand aucune option n'impose de definition", () => {
    const args = streamArgs(CONFIG, MAIN_DISPLAY, {
      fullscreen: false,
      resolution: null,
      fps: null,
    });

    expect(args).toEqual([
      "stream",
      "10.10.10.1",
      "Desktop",
      "--display-mode",
      "windowed",
      "--resolution",
      "3456x2234",
      "--fps",
      "120",
    ]);
  });

  test("aucune option de definition n'est passee quand aucun ecran n'est detecte", () => {
    const args = streamArgs(CONFIG, null, {
      fullscreen: false,
      resolution: null,
      fps: null,
    });

    expect(args).toEqual(["stream", "10.10.10.1", "Desktop", "--display-mode", "windowed"]);
    expect(args).not.toContain("--resolution");
    expect(args).not.toContain("--fps");
  });
});

describe("frontiere systeme", () => {
  type SpawnCall = { cmd: string[] };

  let spawnCalls: SpawnCall[];
  let exitCode: number;
  let killCalls: number;
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    spawnCalls = [];
    exitCode = 0;
    killCalls = 0;
    originalSpawn = Bun.spawn;
    Bun.spawn = ((cmd: string[]) => {
      spawnCalls.push({ cmd });
      return {
        exited: Promise.resolve(exitCode),
        kill: () => {
          killCalls += 1;
        },
      };
    }) as unknown as typeof Bun.spawn;
  });

  afterEach(() => {
    Bun.spawn = originalSpawn;
  });

  test("spawnPair lance moonlight pair sans attendre et sait tuer le processus", () => {
    const handle = spawnPair(CONFIG, "4821");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.cmd).toEqual([
      "/opt/homebrew/bin/moonlight",
      "pair",
      "10.10.10.1",
      "--pin",
      "4821",
    ]);

    handle.kill();
    expect(killCalls).toBe(1);
  });

  test("runStream rend le code de sortie du processus moonlight", async () => {
    exitCode = 7;

    const code = await runStream(CONFIG, MAIN_DISPLAY, {
      fullscreen: false,
      resolution: null,
      fps: null,
    });

    expect(code).toBe(7);
    expect(spawnCalls[0]!.cmd).toEqual([
      "/opt/homebrew/bin/moonlight",
      "stream",
      "10.10.10.1",
      "Desktop",
      "--display-mode",
      "windowed",
      "--resolution",
      "3456x2234",
      "--fps",
      "120",
    ]);
  });

  test("runQuit attend la fin du processus moonlight quit", async () => {
    await runQuit(CONFIG);

    expect(spawnCalls[0]!.cmd).toEqual(["/opt/homebrew/bin/moonlight", "quit", "10.10.10.1"]);
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/lib/moonlight.test.ts`
Attendu : ÉCHEC avec « Cannot find module '../../src/lib/moonlight' » (le fichier n'existe pas encore).

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/lib/moonlight.ts
import type { Config } from "../config";
import type { Display } from "./display";

export type StreamOptions = {
  fullscreen: boolean;
  resolution: { width: number; height: number } | null;
  fps: number | null;
};

/** Fonction pure. Compose `moonlight pair <hote> --pin <code>`. */
export function pairArgs(config: Config, pin: string): string[] {
  return ["pair", config.ssh.host, "--pin", pin];
}

/**
 * Fonction pure. Compose la ligne de streaming a partir de l'ecran et des
 * options. Les options gagnent quand elles sont fournies, l'ecran sert de
 * defaut, et quand aucun ecran n'est detecte et qu'aucune option n'impose de
 * definition, aucune option de definition n'est passee du tout : Moonlight se
 * debrouille seul.
 */
export function streamArgs(
  config: Config,
  display: Display | null,
  options: StreamOptions,
): string[] {
  const args = [
    "stream",
    config.ssh.host,
    config.moonlight.app,
    "--display-mode",
    options.fullscreen ? "fullscreen" : "windowed",
  ];

  const resolution =
    options.resolution ??
    (display ? { width: display.widthPx, height: display.heightPx } : null);
  if (resolution) {
    args.push("--resolution", `${resolution.width}x${resolution.height}`);
  }

  const fps = options.fps ?? (display ? display.refreshHz : null);
  if (fps !== null) {
    args.push("--fps", String(fps));
  }

  return args;
}

/** Fonction pure. Compose `moonlight quit <hote>`. */
export function quitArgs(config: Config): string[] {
  return ["quit", config.ssh.host];
}

// --- Frontiere systeme. ---

/** Lance l'appairage sans attendre sa fin. */
export function spawnPair(config: Config, pin: string): { kill(): void } {
  const proc = Bun.spawn([config.moonlight.binary, ...pairArgs(config, pin)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return { kill: () => proc.kill() };
}

/** Lance le flux et attend sa fin. Rend le code de sortie. */
export async function runStream(
  config: Config,
  display: Display | null,
  options: StreamOptions,
): Promise<number> {
  const proc = Bun.spawn(
    [config.moonlight.binary, ...streamArgs(config, display, options)],
    { stdout: "inherit", stderr: "inherit" },
  );
  return await proc.exited;
}

/** Clot la session cote serveur. */
export async function runQuit(config: Config): Promise<void> {
  const proc = Bun.spawn([config.moonlight.binary, ...quitArgs(config)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/lib/moonlight.test.ts`
Attendu : 9 tests, 0 échec. Puis `bunx tsc --noEmit` : silence complet.

- [ ] **Étape 5 : Commiter**

```bash
git add src/lib/moonlight.ts test/lib/moonlight.test.ts
git commit -m "$(cat <<'EOF'
Ajoute la composition des lignes de commande Moonlight

pairArgs, streamArgs et quitArgs sont pures et composent les arguments
apres le binaire ; spawnPair, runStream et runQuit prefixent
config.moonlight.binary et lancent Bun.spawn. streamArgs fait gagner
les options explicites sur l'ecran detecte, retombe sur l'ecran quand
elles manquent, et ne passe aucune option de definition quand ni l'un
ni l'autre n'est disponible : trois tests distincts le verrouillent.
EOF
)"
```

---

### Tâche 7 : Montage SMB

**Fichiers :**
- Créer : `src/lib/smb.ts`
- Test : `test/lib/smb.test.ts`

**Interfaces :**
- Consomme : `Config`, `SMBShare` (`src/config.ts`, blocs `ssh.host`, `smb.user`).
- Produit : `smbUrl(host, user, password, share): string`, `mountShare(share, config, password): Promise<void>`, `unmountShare(share): Promise<void>`, `isMounted(share): Promise<boolean>` — noms exacts d'`interfaces.md`, consommés plus tard par `src/commands/up.ts`.

Montage par `mount_smbfs`, point de montage créé au besoin sous `/Volumes` (`mkdir` récursif). Le mot de passe est cité **pour une URL** par `encodeURIComponent`, jamais pour un shell : il n'est jamais interpolé dans une chaîne passée à un interpréteur de commandes, seulement encodé dans une URL passée en argument de tableau à `Bun.spawn`. Il ne doit apparaître dans **aucun** message d'erreur — `mount_smbfs` peut échoer l'URL complète, mot de passe compris, dans son flux d'erreur ; le message levé par `mountShare` retire donc le mot de passe (brut et encodé) du texte de `stderr` avant de le citer. Le test correspondant simule précisément cette fuite côté `stderr` pour vérifier que l'assainissement s'applique réellement, et non qu'il n'est simplement jamais sollicité. `unmountShare` ne lève pas quand rien n'était monté : il consulte `isMounted` d'abord et rend la main sans appeler `umount` si le point de montage ne porte aucun volume SMB.

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/lib/smb.test.ts
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import type { Config, SMBShare } from "../../src/config";

let mkdirCalls: string[];
const realFs = await import("node:fs/promises");

mock.module("node:fs/promises", () => ({
  ...realFs,
  mkdir: async (path: string) => {
    mkdirCalls.push(path);
  },
}));

const { smbUrl, mountShare, unmountShare, isMounted } = await import("../../src/lib/smb");

const CONFIG: Config = {
  mac: { serviceName: "AX88179A", ip: "10.10.10.2", subnetMask: "255.255.255.0" },
  windows: { interfaceAlias: "Ethernet", ip: "10.10.10.1", prefixLength: 24 },
  ssh: { host: "10.10.10.1", user: "arthur", identityFile: "/dev/null", connectTimeoutSec: 8 },
  bootstrapPort: 8080,
  apollo: {
    version: "0.4.6",
    installerUrl: "https://example.invalid/Apollo-0.4.6.exe",
    installerSha256: "42b2aefaacb3474511517a56b96ee9f0517f30ac38b5dd2fda9fd5b478f5021a",
    installDir: "C:\\Program Files\\Apollo",
    serviceName: "ApolloService",
    apiPort: 47990,
    webUser: "hardline",
  },
  moonlight: {
    cask: "moonlight",
    binary: "/opt/homebrew/bin/moonlight",
    clientName: "hardline-mac",
    app: "Desktop",
  },
  smb: {
    user: "arthur",
    shares: [
      { name: "arthur", path: null, mountPoint: "/Volumes/pc-arthur" },
      { name: "hardline-d", path: "D:\\", mountPoint: "/Volumes/pc-d" },
      { name: "hardline-e", path: "E:\\", mountPoint: "/Volumes/pc-e" },
    ],
  },
};

const SHARE_D: SMBShare = { name: "hardline-d", path: "D:\\", mountPoint: "/Volumes/pc-d" };

type SpawnCall = { cmd: string[] };

let spawnCalls: SpawnCall[];
let mountSmbfsExit: number;
let mountSmbfsStderr: string;
let mountOutput: string;
let originalSpawn: typeof Bun.spawn;

beforeEach(() => {
  mkdirCalls = [];
  spawnCalls = [];
  mountSmbfsExit = 0;
  mountSmbfsStderr = "";
  mountOutput = "";
  originalSpawn = Bun.spawn;
  Bun.spawn = ((cmd: string[]) => {
    spawnCalls.push({ cmd });
    if (cmd[0] === "mount_smbfs") {
      return {
        stdout: "",
        stderr: mountSmbfsStderr,
        exited: Promise.resolve(mountSmbfsExit),
      };
    }
    if (cmd[0] === "mount") {
      return {
        stdout: mountOutput,
        stderr: "",
        exited: Promise.resolve(0),
      };
    }
    return { stdout: "", stderr: "", exited: Promise.resolve(0) };
  }) as unknown as typeof Bun.spawn;
});

afterEach(() => {
  Bun.spawn = originalSpawn;
});

describe("smbUrl", () => {
  test("chiffre le mot de passe pour une URL, jamais pour un shell", () => {
    const password = "p@ss w0rd!#";
    const url = smbUrl("10.10.10.1", "arthur", password, "hardline-d");
    expect(url).toBe(`smb://arthur:${encodeURIComponent(password)}@10.10.10.1/hardline-d`);
  });
});

describe("mountShare", () => {
  test("cree le point de montage au besoin puis appelle mount_smbfs avec l'URL chiffree", async () => {
    await mountShare(SHARE_D, CONFIG, "s3cret!");

    expect(mkdirCalls).toEqual(["/Volumes/pc-d"]);

    const call = spawnCalls.find((c) => c.cmd[0] === "mount_smbfs");
    expect(call?.cmd[1]).toBe(smbUrl(CONFIG.ssh.host, CONFIG.smb.user, "s3cret!", SHARE_D.name));
    expect(call?.cmd[2]).toBe(SHARE_D.mountPoint);
  });

  test("ne laisse jamais le mot de passe fuir dans le message d'erreur", async () => {
    const password = "S3cretMotDePasse!";
    mountSmbfsExit = 68;
    mountSmbfsStderr =
      `mount_smbfs: server rejected the connection: Authentication error ` +
      `url=smb://arthur:${password}@10.10.10.1/hardline-d`;

    let caught: Error | null = null;
    try {
      await mountShare(SHARE_D, CONFIG, password);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught?.message).not.toContain(password);
    expect(caught?.message).not.toContain(encodeURIComponent(password));
  });
});

describe("unmountShare", () => {
  test("ne leve pas quand rien n'etait monte", async () => {
    mountOutput = "map -hosts on /net (autofs, nosuid, automounted)";

    await expect(unmountShare(SHARE_D)).resolves.toBeUndefined();
    expect(spawnCalls.some((c) => c.cmd[0] === "umount")).toBe(false);
  });

  test("demonte quand le partage est effectivement monte", async () => {
    mountOutput = `//arthur@10.10.10.1/hardline-d on ${SHARE_D.mountPoint} (smbfs, nodev, nosuid, mounted by arthur)`;

    await unmountShare(SHARE_D);

    expect(
      spawnCalls.some((c) => c.cmd[0] === "umount" && c.cmd[1] === SHARE_D.mountPoint),
    ).toBe(true);
  });
});

describe("isMounted", () => {
  test("lit la sortie de mount pour reconnaitre le volume", async () => {
    mountOutput = `//arthur@10.10.10.1/hardline-d on ${SHARE_D.mountPoint} (smbfs, nodev, nosuid, mounted by arthur)`;
    expect(await isMounted(SHARE_D)).toBe(true);
  });

  test("rend false quand le point de montage est absent de la sortie", async () => {
    mountOutput = "map -hosts on /net (autofs, nosuid, automounted)";
    expect(await isMounted(SHARE_D)).toBe(false);
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/lib/smb.test.ts`
Attendu : ÉCHEC avec « Cannot find module '../../src/lib/smb' » (le fichier n'existe pas encore).

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/lib/smb.ts
import { mkdir } from "node:fs/promises";
import type { Config, SMBShare } from "../config";

/** Fonction pure. Compose l'URL smb://utilisateur:motdepasse@hote/partage. */
export function smbUrl(
  host: string,
  user: string,
  password: string,
  share: string,
): string {
  return `smb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}/${encodeURIComponent(share)}`;
}

/**
 * Retire toute occurrence du secret, brut ou encode pour une URL, d'un texte
 * destine a un message d'erreur. mount_smbfs peut echoer l'URL complete dans
 * son flux d'erreur : le secret ne doit jamais y survivre.
 */
function stripSecret(text: string, secret: string): string {
  if (secret === "") return text;
  return text.split(secret).join("***").split(encodeURIComponent(secret)).join("***");
}

// --- Frontiere systeme. ---

/** Monte un partage. Cree le point de montage au besoin. */
export async function mountShare(
  share: SMBShare,
  config: Config,
  password: string,
): Promise<void> {
  await mkdir(share.mountPoint, { recursive: true });

  const url = smbUrl(config.ssh.host, config.smb.user, password, share.name);
  const proc = Bun.spawn(["mount_smbfs", url, share.mountPoint], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `impossible de monter le partage « ${share.name} » sur ${share.mountPoint} ` +
        `(code ${exitCode}) : ${stripSecret(stderr.trim(), password)}`,
    );
  }
}

/** Vrai si le point de montage porte un volume SMB. */
export async function isMounted(share: SMBShare): Promise<boolean> {
  const proc = Bun.spawn(["mount"], { stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  return stdout
    .split("\n")
    .some((line) => line.includes(` on ${share.mountPoint} (smbfs`));
}

/** Demonte. Ne leve pas si le partage n'etait pas monte. */
export async function unmountShare(share: SMBShare): Promise<void> {
  if (!(await isMounted(share))) return;

  const proc = Bun.spawn(["umount", share.mountPoint], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
}
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/lib/smb.test.ts`
Attendu : 7 tests, 0 échec. Puis `bunx tsc --noEmit` : silence complet.

- [ ] **Étape 5 : Commiter**

```bash
git add src/lib/smb.ts test/lib/smb.test.ts
git commit -m "$(cat <<'EOF'
Ajoute le montage et le demontage des partages SMB

Le mot de passe ne traverse jamais un shell : il est encodeURIComponent
dans l'URL smb:// passee en argument de tableau a Bun.spawn, et
retire (brut et encode) de tout message d'erreur avant qu'il ne soit
leve, y compris quand mount_smbfs echoe l'URL complete dans stderr.
unmountShare consulte isMounted et ne leve jamais sur un point de
montage deja libre.
EOF
)"
```

---

## Réserve

Vérification empirique faite en dehors du dépôt (compilation `bunx tsc --noEmit` et exécution `bun test --isolate` réelles des quatre fichiers ci-dessus, plus la suite complète existante) : les quatre implémentations et leurs 38 tests passent tels quels, sans ajustement après la première écriture — un seul point a demandé un correctif pendant la vérification, capturé directement dans le code livré ci-dessus :

- **`typeof fetch` exige une propriété statique `preconnect`.** Un mock direct de `globalThis.fetch` par simple affectation d'une fonction fléchée échoue la compilation (`TS2741`) parce que le type réel de `fetch` sous Bun porte une méthode statique `preconnect` qu'une fonction ordinaire n'a pas. Le contournement retenu, déjà dans le test de la Tâche 4 : caster via `unknown` (`as unknown as typeof fetch`), avec les paramètres du mock typés explicitement puisque le cast retire le typage contextuel qu'aurait donné une affectation directe.

Un second point, plus important, ne concerne aucun fichier de ce document mais doit être traité par la tâche — non couverte ici — qui ajoute les blocs `apollo`, `moonlight` et `smb` à `Config` dans `src/config.ts` :

- **Cet ajout casse la compilation de `test/lib/throughput.test.ts`.** Ce fichier construit sa propre valeur littérale `CONFIG: Config` (ligne ~34, avant l'ajout) sans les trois nouveaux blocs ; dès que `Config` les exige, `bunx tsc --noEmit` échoue sur ce fichier avec `TS2739 : ... is missing the following properties from type 'Config': apollo, moonlight, smb`. Vérifié : `bun test` seul ne le voit pas (TypeScript est effacé à l'exécution, la suite complète — 433 tests à ce moment — passe malgré tout), donc le défaut ne se révèle qu'à `bunx tsc --noEmit`, exactement le contrôle que ce projet a déjà appris à ne pas sauter. La tâche qui modifie `config.ts` doit donc, dans le même commit, étendre le littéral `CONFIG` de `test/lib/throughput.test.ts` avec des valeurs `apollo`/`moonlight`/`smb` cohérentes (celles de la section « Valeurs de `CONFIG` » d'`interfaces.md` conviennent), faute de quoi la première des tâches 4 à 7 qui tourne après elle trouve `bunx tsc --noEmit` déjà bruyant pour une raison qui ne lui appartient pas.

---

### Tâche 7bis : le manifeste ne se réécrit pas

**Correctif du socle, découvert en relisant ce plan.** Il ne relève pas du plan 2
mais le plan 2 bute dessus, et il vaut pour toutes les étapes, pas seulement les
nouvelles.

`applySteps` appelle `recordStep` **sans condition** dès qu'une étape n'est pas
conforme (`src/lib/orchestrator.ts:51`). Au second passage sur une étape dont
l'`apply` a échoué ou été interrompu, l'état constaté — donc déjà modifié — écrase
le relevé d'origine. Le manifeste cesse alors de décrire le PC d'avant `hardline`
pour décrire le PC à mi-chemin, et la désinstallation rend un état intermédiaire
en croyant rendre l'état initial.

Le plan 2 en fait un dommage certain, plus seulement latent : la commande
`install` efface un Apollo étranger puis relance la convergence, et la seconde
inspection enregistrerait « rien n'était installé », effaçant la seule trace
qu'un Apollo 0.4.5 existait. La spec (§11) promet exactement le contraire.

La règle correcte, et c'est celle qu'énonce déjà le commentaire de l'invariant
sans que le code la tienne : **un relevé, une fois écrit, ne se révise pas.**

**Fichiers :**
- Modifier : `src/lib/orchestrator.ts:44-57`
- Test : `test/lib/orchestrator.test.ts`

**Interfaces :**
- Consomme : `recordStep(manifest, name, previous, now)`, `readManifest`,
  `writeManifest` (`src/lib/manifest.ts`) — inchangés.
- Produit : aucun nouveau symbole. Le comportement d'`applySteps` change, sa
  signature non.

- [ ] **Étape 1 : Écrire le test qui échoue**

Ajouter à `test/lib/orchestrator.test.ts` :

```ts
test("un releve deja au manifeste n'est jamais reecrit par un second passage", async () => {
  const manifestPath = join(tmpdir(), `hardline-record-${Date.now()}.json`);
  let observed = "avant";

  const step: Step<{ valeur: string }> = {
    name: "cobaye",
    label: "Cobaye",
    async inspect() {
      return { conforming: false, current: { valeur: observed }, detail: observed };
    },
    async apply() {
      // Le premier passage echoue APRES avoir modifie : c'est exactement le
      // cas ou le releve d'origine devient irremplacable.
      observed = "a mi-chemin";
      throw new Error("boum");
    },
    async restore() {},
  };

  await expect(
    applySteps([step], CONFIG, manifestPath, silentReporter),
  ).rejects.toThrow("boum");

  const apresEchec = await readManifest(manifestPath);
  expect(apresEchec.steps["cobaye"]?.previous).toEqual({ valeur: "avant" });

  // Second passage : inspect voit desormais "a mi-chemin".
  const applyOk: Step<{ valeur: string }> = { ...step, async apply() {} };
  await applySteps([applyOk], CONFIG, manifestPath, silentReporter);

  const apresReprise = await readManifest(manifestPath);
  expect(apresReprise.steps["cobaye"]?.previous).toEqual({ valeur: "avant" });
  expect(apresReprise.steps["cobaye"]?.previous).not.toEqual({ valeur: "a mi-chemin" });

  await unlink(manifestPath).catch(() => {});
});
```

L'assertion qui compte est la dernière : sans le correctif, `previous` vaut
`{ valeur: "a mi-chemin" }` et le test échoue en le nommant.

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/lib/orchestrator.test.ts`
Attendu : ÉCHEC sur la dernière assertion, `{ valeur: "a mi-chemin" }` reçu là où
`{ valeur: "avant" }` était attendu.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Dans `src/lib/orchestrator.ts`, remplacer le bloc d'enregistrement :

```ts
    // Invariant de surete : le manifeste est ecrit AVANT la modification.
    // Une interruption pendant apply laisse alors une etape enregistree mais
    // non appliquee, que le passage suivant corrige de lui-meme.
    //
    // Et un releve, une fois ecrit, ne se revise pas. Au second passage,
    // inspect ne voit plus le PC d'avant hardline mais le PC a mi-chemin :
    // reenregistrer ce qu'il constate remplacerait la description de l'etat
    // initial par celle d'un etat intermediaire, et la desinstallation
    // rendrait cet etat-la en croyant rendre l'autre.
    if (manifest.steps[step.name] === undefined) {
      manifest = recordStep(
        manifest,
        step.name,
        state.current,
        new Date().toISOString(),
      );
      await writeManifest(manifestPath, manifest);
    }
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate && bunx tsc --noEmit 2>&1 | tee /tmp/tsc.txt ; [ -s /tmp/tsc.txt ] && echo "TSC KO" || echo "TSC OK"`
Attendu : toute la suite verte, `tsc` silencieux. Aucun test existant ne doit
casser : le cas nominal — première rencontre d'une étape — est inchangé.

- [ ] **Étape 5 : Commiter**

```bash
git add src/lib/orchestrator.ts test/lib/orchestrator.test.ts
git commit -m "fix(orchestrator): ne jamais réécrire un relevé déjà au manifeste

Au second passage sur une étape dont l'apply avait échoué, l'état constaté —
donc déjà modifié — écrasait le relevé d'origine. Le manifeste cessait de
décrire la machine d'avant hardline pour décrire la machine à mi-chemin, et la
désinstallation rendait cet état intermédiaire en croyant rendre l'initial.

Un relevé, une fois écrit, ne se révise pas."
```

---

### Tâche 8 : Étape `apollo-install`

**Fichiers :**
- Créer : `src/steps/apollo-install.ts`
- Test : `test/steps/apollo-install.test.ts`

**Interfaces :**
- Consomme :
  - `Config`, `config.apollo: ApolloConfig` (`src/config.ts`)
  - `Step<P>`, `StepState<P>`, `RestoreContext`, `RestoreOutcome` (`src/steps/types.ts`)
  - `psQuote(value, what): string` (`src/lib/powershell.ts`)
  - `runRemoteJson<T>(target, script): Promise<T[]>`,
    `runRemoteChecked(target, script): Promise<RemoteResult>` (`src/lib/ssh.ts`)
- Produit :
  - `export type ApolloInstallState = { installed: boolean; version: string | null; ours: boolean; backupPath: string | null; pairedClients: number }`
  - `export const MARKER_FILE = ".hardline"`
  - `export class ForeignApolloError extends Error { readonly state: ApolloInstallState; readonly hasConfig: boolean }`
  - `export async function backupApolloConfig(config: Config): Promise<string | null>`
  - `export async function uninstallApollo(config: Config): Promise<void>`
  - `export const apolloInstallStep: Step<ApolloInstallState>`

  `uninstallApollo` et `backupApolloConfig` sont exportées au-delà du strict
  besoin de cette étape : c'est ce que la tâche 12 devra appeler pour
  effacer une installation étrangère *après* que la commande a obtenu la
  confirmation de l'utilisateur. `apply()` ne le fait jamais de lui-même —
  voir la justification au cycle 2.

**Décisions de conception qui ne sont écrites nulle part ailleurs :**

- **`ours` vient d'un seul fichier marqueur**, `installDir\.hardline`,
  jamais d'une heuristique de date, de version ou de configuration — exigence
  du contrat d'interfaces, reprise ici au pied de la lettre.
- **Le nombre de clients appairés est lu sur disque**, dans
  `installDir\config\sunshine_state.json`, champ `root.named_certs` — jamais
  par l'API HTTP d'Apollo. Une installation étrangère a des identifiants web
  inconnus de hardline ; les lire par fichier, via la session SSH déjà
  administrateur, ne dépend d'aucun secret. C'est une hypothèse sur le format
  interne d'Apollo 0.4.6, à confirmer sur la machine de référence au premier
  essai réel — signalée en réserve dans le rapport de ce plan.
- **`nefconc.exe` est supposé vivre dans `installDir\tools\`.** La spec ne
  donne que le nom de l'outil, pas son chemin ; ce chemin n'est vérifiable
  que sur la machine réelle (section 14 de la spec le dit explicitement pour
  d'autres points du même genre). À confirmer au premier essai, sans quoi
  l'étape 3 de la désinstallation échoue silencieusement (voir plus bas
  pourquoi ce n'est pas bloquant).
- **Aucune queue détachée.** Contrairement à `network-windows.ts` et
  `bootstrap-windows.ts`, rien ici ne touche à l'interface qui porte la
  session SSH : la désinstallation d'Apollo ne coupe jamais le canal. Tout
  le script tourne en ligne, via `runRemoteChecked`, un seul aller-retour.
- **`apply()` ne bascule jamais un Apollo étranger en Apollo à nous.** Sur
  détection d'un `ours: false`, `apply()` lève `ForeignApolloError` et
  n'exécute STRICTEMENT rien d'autre — ni sauvegarde, ni retrait. C'est la
  commande (tâche 12) qui, après confirmation, appellera `uninstallApollo`
  puis relancera la convergence : à ce moment-là, `inspect()` ne verra plus
  qu'une machine sans Apollo, et `apply()` empruntera son chemin d'installation
  neuve, sans jamais avoir eu besoin de connaître la confirmation elle-même.
  Ce découplage respecte à la lettre « les étapes ne dialoguent jamais » :
  aucun champ de `Config` ne porte de confirmation, aucun état mutable
  n'est partagé entre deux appels d'`apply()`.

---

#### Cycle 1 — `inspect` : absent, étranger, à nous, mauvaise version

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/steps/apollo-install.test.ts
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";

let jsonQueue: unknown[][] = [];
const runRemoteJson = mock(async () => {
  const next = jsonQueue.shift();
  if (!next) throw new Error("file d'attente JSON vide dans le test");
  return next;
});
const runRemoteChecked = mock(async (..._args: unknown[]) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../../src/lib/ssh", () => ({
  runRemoteJson,
  runRemoteChecked,
}));

const { apolloInstallStep } = await import("../../src/steps/apollo-install");

beforeEach(() => {
  jsonQueue = [];
  runRemoteJson.mockClear();
  runRemoteChecked.mockClear();
});

describe("inspect", () => {
  test("absent", async () => {
    jsonQueue.push([
      { installed: false, version: null, ours: false, pairedClients: 0, hasConfig: false },
    ]);
    const state = await apolloInstallStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current.installed).toBe(false);
    expect(state.detail).toContain("absent");
  });

  test("etranger", async () => {
    jsonQueue.push([
      { installed: true, version: "0.4.6", ours: false, pairedClients: 3, hasConfig: true },
    ]);
    const state = await apolloInstallStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current.ours).toBe(false);
    expect(state.current.pairedClients).toBe(3);
    expect(state.detail).toContain("étranger");
    expect(state.detail).toContain("3 client");
  });

  test("nous, version conforme", async () => {
    jsonQueue.push([
      { installed: true, version: "0.4.6", ours: true, pairedClients: 1, hasConfig: true },
    ]);
    const state = await apolloInstallStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
  });

  test("nous, mauvaise version", async () => {
    jsonQueue.push([
      { installed: true, version: "0.4.5", ours: true, pairedClients: 1, hasConfig: true },
    ]);
    const state = await apolloInstallStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
  });

  test("echoue explicitement si le PC ne repond rien", async () => {
    jsonQueue.push([]);
    expect(apolloInstallStep.inspect(CONFIG)).rejects.toThrow();
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/apollo-install.test.ts`
Attendu : ÉCHEC — `Cannot find module '../../src/steps/apollo-install'` (le
fichier n'existe pas encore).

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/steps/apollo-install.ts
import { psQuote } from "../lib/powershell";
import { runRemoteJson } from "../lib/ssh";
import type { Config } from "../config";
import type { Step } from "./types";

/** Ce que hardline sait d'une installation d'Apollo, avant de la toucher. */
export type ApolloInstallState = {
  installed: boolean;
  version: string | null;
  ours: boolean;
  backupPath: string | null;
  pairedClients: number;
};

/**
 * Fichier marqueur depose dans installDir a l'installation par hardline.
 * Seule source de verite pour "ours" : aucune heuristique de date, de
 * version ou de configuration ne remplace ce fichier.
 */
export const MARKER_FILE = ".hardline";

type RemoteApolloState = {
  installed: boolean;
  version: string | null;
  ours: boolean;
  pairedClients: number;
  hasConfig: boolean;
};

const CONFIG_PATH_EXPR = (installDirQ: string) =>
  `(Join-Path ${installDirQ} (Join-Path 'config' 'sunshine.conf'))`;

const STATE_PATH_EXPR = (installDirQ: string) =>
  `(Join-Path ${installDirQ} (Join-Path 'config' 'sunshine_state.json'))`;

/**
 * Le nombre de clients apparies est lu dans sunshine_state.json, le fichier
 * ou Apollo persiste ses certificats client apparies (root.named_certs) :
 * aucune requete HTTP n'est necessaire, ce qui laisse ce releve fonctionner
 * meme quand les identifiants web d'un Apollo etranger sont inconnus de
 * hardline. Format interne d'Apollo 0.4.6, a confirmer sur la machine de
 * reference.
 */
const INSPECT = (installDir: string) => {
  const installDirQ = psQuote(installDir, "répertoire d'installation");
  return `
$installDir = ${installDirQ}
$exePath = Join-Path $installDir 'sunshine.exe'
$markerPath = Join-Path $installDir '${MARKER_FILE}'
$statePath = ${STATE_PATH_EXPR("$installDir")}
$confPath = ${CONFIG_PATH_EXPR("$installDir")}
$installed = Test-Path $exePath
$version = $null
if ($installed) { $version = (Get-Item $exePath).VersionInfo.ProductVersion }
$pairedClients = 0
if (Test-Path $statePath) {
  try {
    $state = Get-Content -Path $statePath -Raw | ConvertFrom-Json
    if ($state.root -and $state.root.named_certs) { $pairedClients = @($state.root.named_certs).Count }
  } catch {}
}
[pscustomobject]@{
  installed     = [bool]$installed
  version       = $version
  ours          = [bool](Test-Path $markerPath)
  pairedClients = [int]$pairedClients
  hasConfig     = [bool](Test-Path $confPath)
}`;
};

async function readRemote(config: Config): Promise<RemoteApolloState> {
  const rows = await runRemoteJson<RemoteApolloState>(
    config.ssh,
    INSPECT(config.apollo.installDir),
  );
  const current = rows[0];
  if (!current) {
    throw new Error(
      "Le PC n'a renvoyé aucun état d'Apollo. Vérifier la liaison SSH.",
    );
  }
  return current;
}

function toState(remote: RemoteApolloState): ApolloInstallState {
  return {
    installed: remote.installed,
    version: remote.version,
    ours: remote.ours,
    backupPath: null,
    pairedClients: remote.pairedClients,
  };
}

export const apolloInstallStep: Step<ApolloInstallState> = {
  name: "apollo-install",
  label: "Serveur Apollo installé (PC)",

  async inspect(config: Config) {
    const remote = await readRemote(config);
    const conforming =
      remote.installed && remote.ours && remote.version === config.apollo.version;

    return {
      conforming,
      current: toState(remote),
      detail: !remote.installed
        ? "Apollo absent du PC"
        : !remote.ours
          ? `Apollo étranger détecté (version ${remote.version ?? "inconnue"}, ${remote.pairedClients} client(s) appairé(s))`
          : conforming
            ? `Apollo ${config.apollo.version} déjà installé par hardline`
            : `Apollo ${remote.version ?? "inconnu"} installé par hardline, version ${config.apollo.version} attendue`,
    };
  },

  async apply(_config: Config) {
    throw new Error("pas encore implémenté");
  },

  async restore(_config: Config, _previous: ApolloInstallState) {
    throw new Error("pas encore implémenté");
  },
};
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/steps/apollo-install.test.ts`
Attendu : les 5 tests du `describe("inspect", ...)` passent.

- [ ] **Étape 5 : Commiter**

```bash
git add src/steps/apollo-install.ts test/steps/apollo-install.test.ts
git commit -m "$(cat <<'EOF'
feat(apollo-install): releve d'installation, sans heuristique sur "ours"

inspect() distingue absent / etranger / a nous par le seul marqueur
.hardline, jamais par une heuristique de version ou de date. Le nombre de
clients apparies est lu dans sunshine_state.json, sans dependre des
identifiants web d'une installation etrangere.
EOF
)"
```

---

#### Cycle 2 — `apply` : installation neuve, et refus net sur un Apollo étranger

- [ ] **Étape 1 : Écrire le test qui échoue**

Ajouter à `test/steps/apollo-install.test.ts`, après l'import (remplacer la
ligne d'import pour inclure `ForeignApolloError` et `MARKER_FILE`) :

```ts
const { apolloInstallStep, ForeignApolloError, MARKER_FILE } = await import(
  "../../src/steps/apollo-install"
);
```

Puis ajouter :

```ts
function checkedScript(call: number): string {
  return String((runRemoteChecked.mock.calls[call] as unknown[])[1]);
}

describe("apply - installation neuve", () => {
  test("telecharge, verifie l'empreinte avant execution, installe, depose le marqueur", async () => {
    jsonQueue.push([
      { installed: false, version: null, ours: false, pairedClients: 0, hasConfig: false },
    ]);
    await apolloInstallStep.apply(CONFIG);
    expect(runRemoteChecked).toHaveBeenCalledTimes(1);
    const script = checkedScript(0);

    const download = script.indexOf("Invoke-WebRequest");
    const hashCheck = script.indexOf("Get-FileHash");
    const compare = script.indexOf("if ($actual -ne");
    const install = script.indexOf("& $tempPath");
    const marker = script.indexOf(MARKER_FILE);

    expect(download).toBeGreaterThanOrEqual(0);
    expect(hashCheck).toBeGreaterThan(download);
    expect(compare).toBeGreaterThan(hashCheck);
    expect(install).toBeGreaterThan(compare);
    expect(marker).toBeGreaterThan(install);
    expect(script).toContain(CONFIG.apollo.installerUrl);
    expect(script).toContain(CONFIG.apollo.installerSha256);
    expect(script).toContain("'/S'");
    expect(script).toContain(`/D=${CONFIG.apollo.installDir}`);
  });
});

describe("apply - installation etrangere", () => {
  test("leve ForeignApolloError sans rien executer", async () => {
    jsonQueue.push([
      { installed: true, version: "0.4.6", ours: false, pairedClients: 2, hasConfig: true },
    ]);
    await expect(apolloInstallStep.apply(CONFIG)).rejects.toThrow(ForeignApolloError);
    expect(runRemoteChecked).not.toHaveBeenCalled();
  });

  test("l'erreur porte l'etat constate", async () => {
    jsonQueue.push([
      { installed: true, version: "0.4.6", ours: false, pairedClients: 5, hasConfig: true },
    ]);
    try {
      await apolloInstallStep.apply(CONFIG);
      throw new Error("aurait du lever");
    } catch (error) {
      expect(error).toBeInstanceOf(ForeignApolloError);
      const foreign = error as InstanceType<typeof ForeignApolloError>;
      expect(foreign.state.version).toBe("0.4.6");
      expect(foreign.state.pairedClients).toBe(5);
      expect(foreign.hasConfig).toBe(true);
      expect(foreign.message).toContain("5 client");
    }
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/apollo-install.test.ts`
Attendu : ÉCHEC — `apply()` lève `Error("pas encore implémenté")` au lieu du
comportement attendu ; `ForeignApolloError` n'existe pas encore dans le
module.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Remplacer dans `src/steps/apollo-install.ts` le bloc `async apply(_config:
Config) { throw ... }` et ajouter, avant `export const apolloInstallStep`,
la classe d'erreur et la fonction d'installation :

```ts
/**
 * Levee par apply() quand une installation d'Apollo non posee par hardline
 * est trouvee. L'etape ne dialogue jamais : elle nomme ce qu'elle a constate
 * et s'arrete la, sans rien executer d'autre. La confirmation et
 * l'effacement, une fois confirmes, sont du ressort de la commande (tache
 * 12), qui peut appeler uninstallApollo() puis relancer la convergence :
 * inspect() ne verra alors plus qu'une machine sans Apollo, et apply()
 * empruntera son chemin d'installation neuve.
 */
export class ForeignApolloError extends Error {
  constructor(
    message: string,
    readonly state: ApolloInstallState,
    readonly hasConfig: boolean,
  ) {
    super(message);
    this.name = "ForeignApolloError";
  }
}

function installScript(config: Config): string {
  const urlQ = psQuote(config.apollo.installerUrl, "URL de l'installateur");
  const sha256Q = psQuote(config.apollo.installerSha256, "empreinte SHA-256 attendue");
  const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
  const installArgQ = psQuote(`/D=${config.apollo.installDir}`, "argument d'installation");

  return `
$tempPath = Join-Path $env:TEMP 'apollo-installer.exe'
Invoke-WebRequest -Uri ${urlQ} -OutFile $tempPath -UseBasicParsing
$actual = (Get-FileHash -Path $tempPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne ${sha256Q}) {
  Remove-Item -Path $tempPath -Force -ErrorAction SilentlyContinue
  throw "Empreinte SHA-256 invalide pour l'installateur Apollo (obtenu $actual)"
}
& $tempPath '/S' ${installArgQ}
if ($LASTEXITCODE -ne 0) { throw "Echec de l'installateur Apollo (code $LASTEXITCODE)" }
Remove-Item -Path $tempPath -Force -ErrorAction SilentlyContinue
New-Item -ItemType File -Path (Join-Path ${installDirQ} '${MARKER_FILE}') -Force | Out-Null`;
}
```

Et remplacer le corps d'`apply` :

```ts
  async apply(config: Config) {
    const remote = await readRemote(config);

    if (remote.installed && !remote.ours) {
      throw new ForeignApolloError(
        `Apollo étranger trouvé (version ${remote.version ?? "inconnue"}, ` +
          `${remote.pairedClients} client(s) appairé(s), ` +
          `${remote.hasConfig ? "une configuration existe" : "aucune configuration"})` +
          ` : confirmation requise avant de l'effacer.`,
        toState(remote),
        remote.hasConfig,
      );
    }

    await runRemoteJsonHead(); // supprimé au cycle 3 — voir remplacement complet plus bas
  },
```

> Cette forme intermédiaire est délibérément incomplète sur le cas « à nous,
> mauvaise version » : ce cas n'est couvert qu'au cycle 3, où
> `runRemoteChecked` remplace l'appel ci-dessus. Pour ce cycle, écrire
> directement la version définitive du corps d'`apply`, qui satisfait déjà
> les deux tests de ce cycle :

```ts
  async apply(config: Config) {
    const remote = await readRemote(config);

    if (remote.installed && !remote.ours) {
      throw new ForeignApolloError(
        `Apollo étranger trouvé (version ${remote.version ?? "inconnue"}, ` +
          `${remote.pairedClients} client(s) appairé(s), ` +
          `${remote.hasConfig ? "une configuration existe" : "aucune configuration"})` +
          ` : confirmation requise avant de l'effacer.`,
        toState(remote),
        remote.hasConfig,
      );
    }

    await runRemoteChecked(config.ssh, installScript(config));
  },
```

(`runRemoteChecked` doit être importé aux côtés de `runRemoteJson` en tête
de fichier : `import { runRemoteChecked, runRemoteJson } from "../lib/ssh";`)

Le cas « à nous mais mauvaise version » repasse par cette même branche
`await runRemoteChecked(config.ssh, installScript(config))` sans jamais
désinstaller l'ancienne — ce qui est faux, et corrigé au cycle 3. Ce cycle
livre volontairement une version incomplète pour rester sur un
test-implémentation-test court ; le cycle 3 introduit la désinstallation
sans repasser par ce test-ci (déjà vert et non regressé).

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/steps/apollo-install.test.ts`
Attendu : tous les tests, y compris ceux du cycle 1, passent.

- [ ] **Étape 5 : Commiter**

```bash
git add src/steps/apollo-install.ts test/steps/apollo-install.test.ts
git commit -m "$(cat <<'EOF'
feat(apollo-install): installation neuve verifiee, refus net sur l'etranger

apply() telecharge l'installateur, verifie son empreinte SHA-256 AVANT
toute execution, l'installe en silence, et depose le marqueur .hardline.
Sur un Apollo etranger, apply() leve ForeignApolloError sans rien executer :
ni sauvegarde, ni retrait. La confirmation appartient a la commande.
EOF
)"
```

---

#### Cycle 3 — `apply` : remplacement d'une installation posée par hardline

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
describe("apply - remplacement d'une installation posee par hardline", () => {
  test("sauvegarde puis desinstalle puis reinstalle, dans cet ordre", async () => {
    jsonQueue.push([
      { installed: true, version: "0.4.5", ours: true, pairedClients: 1, hasConfig: true },
    ]);
    jsonQueue.push([
      { backupPath: "C:\\ProgramData\\hardline\\apollo-backup-20260101-000000.conf" },
    ]);

    await apolloInstallStep.apply(CONFIG);

    expect(runRemoteJson).toHaveBeenCalledTimes(2);
    expect(runRemoteChecked).toHaveBeenCalledTimes(2);
    expect(checkedScript(0)).toContain("Uninstall.exe");
    expect(checkedScript(1)).toContain("Invoke-WebRequest");
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/apollo-install.test.ts`
Attendu : ÉCHEC — `runRemoteJson` n'est appelé qu'une fois (pas de
sauvegarde), et `runRemoteChecked` réinstalle directement sur l'ancienne
installation au lieu de la retirer d'abord.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Ajouter, entre `toState` et `ForeignApolloError`, la sauvegarde et la
désinstallation complète — cette dernière étant réutilisée telle quelle au
cycle 5 pour `restore` :

```ts
/**
 * Sauvegarde sunshine.conf HORS de installDir, avant une desinstallation qui
 * va supprimer tout le dossier. Rend le chemin de la sauvegarde, ou null
 * quand il n'y avait rien a sauvegarder.
 */
export async function backupApolloConfig(config: Config): Promise<string | null> {
  const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
  const script = `
$confPath = ${CONFIG_PATH_EXPR(installDirQ)}
$backupPath = $null
if (Test-Path $confPath) {
  $dir = Join-Path $env:ProgramData 'hardline'
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
  $backupPath = Join-Path $dir "apollo-backup-$stamp.conf"
  Copy-Item -Path $confPath -Destination $backupPath -Force
}
[pscustomobject]@{ backupPath = $backupPath }`;
  const rows = await runRemoteJson<{ backupPath: string | null }>(config.ssh, script);
  return rows[0]?.backupPath ?? null;
}

/** Cf. section 10 de la spec : identifiants du pilote SudoVDA que Windows attribue. */
const SUDOVDA_HARDWARE_ID = "root\\sudomaker\\sudovda";
const SUDOVDA_CLASS_GUID = "4D36E968-E325-11CE-BFC1-08002BE10318";

/**
 * Desinstallation complete, dans l'ordre exact de la section 10 de la spec.
 * Reutilisee par apply() (remplacement d'une installation posee par
 * hardline dans une version differente) et par restore() (desinstallation
 * d'une installation posee par hardline). AUCUNE queue detachee :
 * contrairement au reseau ou a l'amorcage, rien ici ne touche a l'interface
 * qui porte la session SSH, donc rien ne la coupe.
 */
function uninstallScript(config: Config): string {
  const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
  const serviceNameQ = psQuote(config.apollo.serviceName, "nom du service");
  const uninstallArgQ = psQuote(
    `_?=${config.apollo.installDir}`,
    "argument de désinstallation",
  );

  return [
    // 1. Le service ne doit plus tourner pendant que Uninstall.exe retire
    //    les fichiers qu'il tient ouverts.
    `sc.exe stop ${serviceNameQ} | Out-Null`,
    // 2. _?= est OBLIGATOIRE. Sans lui, Uninstall.exe (un installateur NSIS)
    //    se recopie dans un dossier temporaire et se DETACHE aussitot : la
    //    commande SSH rend alors la main immediatement, pendant que la
    //    desinstallation tourne encore sur le PC, et l'etape suivante
    //    agirait sur des fichiers pas encore liberes. _?= force NSIS a
    //    s'executer EN PLACE, de facon synchrone.
    `& (Join-Path ${installDirQ} 'Uninstall.exe') '/S' ${uninstallArgQ}`,
    `if ($LASTEXITCODE -ne 0) { throw "Echec de Uninstall.exe (code $LASTEXITCODE)" }`,
    // 3. Le pilote SudoVDA n'est PAS retire par Uninstall.exe /S : c'est une
    //    des trois boites de dialogue que le mode silencieux refuse par
    //    defaut. nefconc.exe est appele EN DIRECT, jamais par uninstall.bat :
    //    ce script fourni par Apollo se termine par un `pause`, qui
    //    attendrait pour toujours un appui clavier sur un tube qui n'en
    //    fournira jamais, et figerait la session SSH de facon definitive.
    `& (Join-Path ${installDirQ} (Join-Path 'tools' 'nefconc.exe')) '--remove-device-node' '--hardware-id' '${SUDOVDA_HARDWARE_ID}' '--class-guid' '${SUDOVDA_CLASS_GUID}'`,
    // 4. Aucun script d'Apollo ne retire les certificats du pilote : sans
    //    ces deux lignes, deux certificats restent dans les magasins de
    //    confiance.
    `certutil.exe -delstore root sudovda.cer`,
    `certutil.exe -delstore TrustedPublisher sudovda.cer`,
    // 5. ViGEmBus est retire systematiquement (risque assume : pilote
    //    partage, voir section 10 de la spec).
    `& (Join-Path ${installDirQ} (Join-Path 'scripts' 'uninstall-gamepad.ps1'))`,
    // 6. Nettoyage du PATH puis du dossier, dans cet ordre : update-path.bat
    //    vit dans le dossier qu'il faut ensuite supprimer.
    `& (Join-Path ${installDirQ} 'update-path.bat') 'remove'`,
    `Remove-Item -Path ${installDirQ} -Recurse -Force -ErrorAction SilentlyContinue`,
    // 7. Filets de securite : rien de ce qui precede ne doit laisser un
    //    service fantome ou une regle de pare-feu ouverte si une etape a
    //    echoue en silence.
    `sc.exe delete ${serviceNameQ} | Out-Null`,
    `netsh.exe advfirewall firewall delete rule name=Apollo | Out-Null`,
  ].join("\n");
}

/**
 * Exportee au-dela du besoin strict de cette etape : c'est ce que la tache
 * 12 appelle apres confirmation de l'utilisateur, pour effacer une
 * installation etrangere. inspect() ne verra plus alors qu'une machine sans
 * Apollo, et apply() empruntera son chemin d'installation neuve.
 */
export async function uninstallApollo(config: Config): Promise<void> {
  await runRemoteChecked(config.ssh, uninstallScript(config));
}
```

Et remplacer le corps d'`apply` par sa forme définitive :

```ts
  async apply(config: Config) {
    const remote = await readRemote(config);

    if (remote.installed && !remote.ours) {
      throw new ForeignApolloError(
        `Apollo étranger trouvé (version ${remote.version ?? "inconnue"}, ` +
          `${remote.pairedClients} client(s) appairé(s), ` +
          `${remote.hasConfig ? "une configuration existe" : "aucune configuration"})` +
          ` : confirmation requise avant de l'effacer.`,
        toState(remote),
        remote.hasConfig,
      );
    }

    if (remote.installed) {
      // Ours, mais d'une version differente de la cible : la meme rigueur
      // que pour un etranger confirme par la commande, en une seule passe.
      await backupApolloConfig(config);
      await uninstallApollo(config);
    }

    await runRemoteChecked(config.ssh, installScript(config));
  },
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/steps/apollo-install.test.ts`
Attendu : tous les tests des cycles 1 à 3 passent.

- [ ] **Étape 5 : Commiter**

```bash
git add src/steps/apollo-install.ts test/steps/apollo-install.test.ts
git commit -m "$(cat <<'EOF'
feat(apollo-install): remplace une installation posee par hardline

apply() sauvegarde sunshine.conf HORS du dossier d'installation avant de
desinstaller completement une version posee par hardline mais differente de
la cible, puis reinstalle. uninstallApollo() et backupApolloConfig() sont
exportees : la commande (tache 12) les reutilisera pour l'etranger confirme.
EOF
)"
```

---

#### Cycle 4 — `restore` : désinstallation complète dans l'ordre exact, et Apollo étranger jamais remis

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
describe("restore", () => {
  test("nous : desinstallation complete dans l'ordre exact", async () => {
    await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "0.4.6", ours: true, backupPath: null, pairedClients: 0 },
      { pending: [] },
    );
    expect(runRemoteChecked).toHaveBeenCalledTimes(1);
    const script = checkedScript(0);

    const stop = script.indexOf("sc.exe stop");
    const uninstallArg = script.indexOf("_?=");
    const uninstallExe = script.indexOf("Uninstall.exe");
    const nefconc = script.indexOf("nefconc.exe");
    const certRoot = script.indexOf("-delstore root");
    const certTrusted = script.indexOf("-delstore TrustedPublisher");
    const gamepad = script.indexOf("uninstall-gamepad.ps1");
    const path = script.indexOf("update-path.bat");
    const remove = script.indexOf("Remove-Item");
    const scDelete = script.indexOf("sc.exe delete");
    const netsh = script.indexOf("netsh.exe");

    expect(stop).toBeGreaterThanOrEqual(0);
    expect(uninstallExe).toBeGreaterThan(stop);
    expect(uninstallArg).toBeGreaterThan(stop);
    expect(nefconc).toBeGreaterThan(uninstallExe);
    expect(certRoot).toBeGreaterThan(nefconc);
    expect(certTrusted).toBeGreaterThan(certRoot);
    expect(gamepad).toBeGreaterThan(certTrusted);
    expect(path).toBeGreaterThan(gamepad);
    expect(remove).toBeGreaterThan(path);
    expect(scDelete).toBeGreaterThan(remove);
    expect(netsh).toBeGreaterThan(scDelete);

    expect(script).not.toContain("uninstall.bat");
    expect(script).not.toContain("pause");
  });

  test("etranger : cede sans rien executer", async () => {
    const outcome = await apolloInstallStep.restore(
      CONFIG,
      { installed: true, version: "1.2.3", ours: false, backupPath: null, pairedClients: 4 },
      { pending: [] },
    );
    expect(runRemoteChecked).not.toHaveBeenCalled();
    expect(outcome).toBeDefined();
    expect(outcome && "yielded" in outcome ? outcome.yielded : "").toContain("4 client");
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/apollo-install.test.ts`
Attendu : ÉCHEC — `restore()` lève toujours `Error("pas encore implémenté")`.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Remplacer le corps de `restore` :

```ts
  /**
   * "ours" tranche tout : posee par hardline, elle est entierement retiree
   * dans l'ordre de la section 10 — la meme fonction que le remplacement
   * d'apply(). Etrangere, elle est laissee en place : hardline ne l'a pas
   * installee et ne sait pas la remettre. Le dire plutot que le taire.
   */
  async restore(config: Config, previous: ApolloInstallState) {
    if (!previous.ours) {
      return {
        yielded:
          `Apollo étranger laissé en place (version ${previous.version ?? "inconnue"}, ` +
          `${previous.pairedClients} client(s) appairé(s) au moment du constat)` +
          ` : hardline ne l'a pas installé et ne sait pas le remettre.`,
      };
    }

    await uninstallApollo(config);
  },
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/steps/apollo-install.test.ts`
Attendu : les 10 tests du fichier passent. `bunx tsc --noEmit` silencieux.

- [ ] **Étape 5 : Commiter**

```bash
git add src/steps/apollo-install.ts test/steps/apollo-install.test.ts
git commit -m "$(cat <<'EOF'
feat(apollo-install): desinstallation complete, Apollo etranger jamais remis

restore() retire tout ce que hardline a pose, dans l'ordre exact de la
section 10 : arret du service, Uninstall.exe /S avec _?= (sans quoi le
desinstalleur NSIS se detache et rend la main a la session SSH avant
d'avoir fini), retrait direct du pilote par nefconc.exe (jamais par
uninstall.bat, dont le `pause` figerait la session), deux certutil
-delstore, ViGEmBus, nettoyage du PATH et du dossier, filets de securite.
Un Apollo etranger n'est jamais remis : restore() le dit via { yielded }.
EOF
)"
```

---

### Tâche 9 : Étapes `apollo-config` et `apollo-service`

**Fichiers :**
- Créer : `src/steps/apollo-config.ts`, `src/steps/apollo-service.ts`
- Test : `test/steps/apollo-config.test.ts`, `test/steps/apollo-service.test.ts`

**Interfaces :**
- Consomme :
  - `Config`, `config.apollo: ApolloConfig` (`src/config.ts`)
  - `Step<P>`, `RestoreContext`, `RestoreOutcome` (`src/steps/types.ts`)
  - `psQuote`, `psDoubleQuote`, `psKeyword` (`src/lib/powershell.ts`)
  - `runRemoteJson`, `runRemoteChecked` (`src/lib/ssh.ts`)
  - `REQUIRED_CONF: Readonly<Record<string, string>>`, `patchConf(text, required): string`,
    `confConforms(text, required): boolean` (`src/lib/apollo-conf.ts`)
  - `generatePassword(length?): string`, `setSecret(name, value): Promise<void>`,
    `deleteSecret(name): Promise<boolean>` (`src/lib/keychain.ts`)
- Produit :
  - `export type ApolloConfState = { conf: string | null; hadCredentials: boolean }`
  - `export const apolloConfigStep: Step<ApolloConfState>`
  - `export type ServiceState = { startType: string | null; status: string | null }`
  - `export const apolloServiceStep: Step<ServiceState>`

**Décisions de conception :**

- **`hadCredentials` est lu dans `sunshine_state.json`**, champ
  `root.username` non vide — le même fichier que `pairedClients` dans
  `apollo-install.ts`. La logique n'est pas partagée entre les deux fichiers :
  chaque étape embarque son propre script d'inspection, à l'image de
  `network-windows.ts` et `bootstrap-windows.ts` qui ne partagent pas leurs
  `INSPECT` malgré leur ressemblance.
- **`patchConf` est une fonction pure : elle exige le contenu actuel en
  TypeScript.** Contrairement à `network-windows.ts`, qui décide tout en
  PowerShell dans un script unique, `apollo-config.ts` doit *lire* la
  configuration (un aller-retour SSH), la patcher *en TypeScript* via
  `patchConf`, puis *écrire* le résultat (un second aller-retour). C'est la
  seule étape à deux allers-retours du lot : c'est le prix de la réutilisation
  d'une fonction pure déjà testée ailleurs plutôt que de dupliquer sa logique
  en PowerShell.
- **Le mot de passe ne part vers `--creds` que si aucun identifiant
  n'existe déjà.** Un identifiant déjà présent n'est jamais régénéré : cela
  romprait un mot de passe déjà en service et déjà au trousseau, pour une
  étape qui ne serait non conforme que sur les six clés de configuration.
- **Le service est relancé après `--creds` seulement s'il tournait déjà.**
  `--creds` écrit sur disque mais ne recharge pas un service déjà en
  mémoire ; dans le déroulement normal, `apollo-config` s'applique avant
  qu'`apollo-service` n'ait jamais démarré le service pour la première fois,
  donc ce cas ne se présente qu'en réexécution partielle. La requête du
  statut du service se fait dans le même aller-retour que la lecture de la
  configuration, pour ne pas ajouter un troisième aller-retour SSH.
- **`apollo-service` ne dépend jamais d'`apollo-install`.** Son `restore`
  rend le couple `(startType, status)` relevé par `inspect`, sans se
  soucier de ce que fera `apollo-install.restore` ensuite (il s'exécute
  après, dans l'ordre inverse) : si Apollo est étranger et qu'`apollo-install`
  cède sa place, c'est `apollo-service.restore` qui reste seul responsable
  de rendre l'état du service.

---

#### Cycle 1 — `apollo-config.inspect`

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/steps/apollo-config.test.ts
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";

let jsonQueue: unknown[][] = [];
const runRemoteJson = mock(async () => {
  const next = jsonQueue.shift();
  if (!next) throw new Error("file d'attente JSON vide dans le test");
  return next;
});
const runRemoteChecked = mock(async (..._args: unknown[]) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../../src/lib/ssh", () => ({ runRemoteJson, runRemoteChecked }));

const setSecret = mock(async (..._args: unknown[]) => {});
const deleteSecret = mock(async (..._args: unknown[]) => true);
const generatePassword = mock(() => "S3cr3t-Passw0rd!");

mock.module("../../src/lib/keychain", () => ({
  setSecret,
  deleteSecret,
  generatePassword,
}));

const { apolloConfigStep } = await import("../../src/steps/apollo-config");

beforeEach(() => {
  jsonQueue = [];
  runRemoteJson.mockClear();
  runRemoteChecked.mockClear();
  setSecret.mockClear();
  deleteSecret.mockClear();
  generatePassword.mockClear();
});

function checkedScript(call: number): string {
  return String((runRemoteChecked.mock.calls[call] as unknown[])[1]);
}

const CONFORME_CONF = `headless_mode = enabled
dd_configuration_option = ensure_only_display
dd_resolution_option = auto
dd_refresh_rate_option = auto
dd_config_revert_on_disconnect = enabled
capture = ddx`;

describe("inspect", () => {
  test("conforme quand les identifiants et les six cles sont deja poses", async () => {
    jsonQueue.push([{ conf: CONFORME_CONF, hadCredentials: true }]);
    const state = await apolloConfigStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
  });

  test("non conforme sans identifiants meme si la conf est correcte", async () => {
    jsonQueue.push([{ conf: CONFORME_CONF, hadCredentials: false }]);
    const state = await apolloConfigStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.detail).toContain("absents");
  });

  test("non conforme quand une cle manque", async () => {
    jsonQueue.push([{ conf: "headless_mode = enabled", hadCredentials: true }]);
    const state = await apolloConfigStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/apollo-config.test.ts`
Attendu : ÉCHEC — `Cannot find module '../../src/steps/apollo-config'`.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/steps/apollo-config.ts
import { psQuote } from "../lib/powershell";
import { runRemoteJson } from "../lib/ssh";
import { REQUIRED_CONF, confConforms } from "../lib/apollo-conf";
import type { Config } from "../config";
import type { Step } from "./types";

export type ApolloConfState = { conf: string | null; hadCredentials: boolean };

const CONFIG_PATH_EXPR = (installDirQ: string) =>
  `(Join-Path ${installDirQ} (Join-Path 'config' 'sunshine.conf'))`;

const STATE_PATH_EXPR = (installDirQ: string) =>
  `(Join-Path ${installDirQ} (Join-Path 'config' 'sunshine_state.json'))`;

/**
 * hadCredentials est lu dans sunshine_state.json, champ root.username : le
 * meme fichier qu'apollo-install.ts utilise pour pairedClients, mais lu ici
 * independamment, comme network-windows.ts et bootstrap-windows.ts
 * n'utilisent jamais le meme script d'inspection malgre leur ressemblance.
 */
const READ_STATE = (installDir: string) => {
  const installDirQ = psQuote(installDir, "répertoire d'installation");
  return `
$confPath = ${CONFIG_PATH_EXPR(installDirQ)}
$statePath = ${STATE_PATH_EXPR(installDirQ)}
$conf = if (Test-Path $confPath) { Get-Content -Path $confPath -Raw } else { $null }
$hadCredentials = $false
if (Test-Path $statePath) {
  try {
    $state = Get-Content -Path $statePath -Raw | ConvertFrom-Json
    if ($state.root -and $state.root.username) { $hadCredentials = $true }
  } catch {}
}
[pscustomobject]@{ conf = $conf; hadCredentials = [bool]$hadCredentials }`;
};

export const apolloConfigStep: Step<ApolloConfState> = {
  name: "apollo-config",
  label: "Configuration et identifiants Apollo (PC)",

  async inspect(config: Config) {
    const rows = await runRemoteJson<ApolloConfState>(
      config.ssh,
      READ_STATE(config.apollo.installDir),
    );
    const current = rows[0];
    if (!current) {
      throw new Error(
        "Le PC n'a renvoyé aucun état de configuration Apollo. Vérifier la liaison SSH.",
      );
    }
    const conforming = current.hadCredentials && confConforms(current.conf ?? "", REQUIRED_CONF);
    return {
      conforming,
      current,
      detail: conforming
        ? "identifiants et configuration déjà en place"
        : !current.hadCredentials
          ? "identifiants web absents"
          : "configuration incomplète",
    };
  },

  async apply(_config: Config) {
    throw new Error("pas encore implémenté");
  },

  async restore(_config: Config, _previous: ApolloConfState) {
    throw new Error("pas encore implémenté");
  },
};
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/steps/apollo-config.test.ts`
Attendu : les 3 tests du `describe("inspect", ...)` passent.

- [ ] **Étape 5 : Commiter**

```bash
git add src/steps/apollo-config.ts test/steps/apollo-config.test.ts
git commit -m "$(cat <<'EOF'
feat(apollo-config): releve des identifiants web et des six cles requises

inspect() lit sunshine.conf et la presence d'identifiants web dans
sunshine_state.json, et delegue la conformite des six cles a confConforms.
EOF
)"
```

---

#### Cycle 2 — `apollo-config.apply`

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
describe("apply", () => {
  test("pose des identifiants tires au hasard quand ils sont absents, avant le premier demarrage", async () => {
    jsonQueue.push([{ conf: null, hadCredentials: false, serviceRunning: false }]);
    await apolloConfigStep.apply(CONFIG);

    expect(generatePassword).toHaveBeenCalledTimes(1);
    expect(setSecret).toHaveBeenCalledWith("apollo-web", "S3cr3t-Passw0rd!");

    const script = checkedScript(0);
    const creds = script.indexOf("--creds");
    const patch = script.indexOf("Set-Content");
    expect(creds).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThan(creds);
    expect(script).toContain("headless_mode");
    expect(script).not.toContain("Restart-Service");
  });

  test("ne repose jamais les identifiants quand ils existent deja", async () => {
    jsonQueue.push([
      { conf: "headless_mode = enabled", hadCredentials: true, serviceRunning: true },
    ]);
    await apolloConfigStep.apply(CONFIG);

    expect(generatePassword).not.toHaveBeenCalled();
    expect(setSecret).not.toHaveBeenCalled();
    const script = checkedScript(0);
    expect(script).not.toContain("--creds");
  });

  test("relance le service si les identifiants sont poses alors qu'il tourne deja", async () => {
    jsonQueue.push([{ conf: null, hadCredentials: false, serviceRunning: true }]);
    await apolloConfigStep.apply(CONFIG);
    const script = checkedScript(0);
    const creds = script.indexOf("--creds");
    const restart = script.indexOf("Restart-Service");
    expect(restart).toBeGreaterThan(creds);
  });

  test("preserve les lignes non gerees par hardline", async () => {
    jsonQueue.push([
      {
        conf: "# commentaire perso\nsunshine_name = mon-pc\nheadless_mode = disabled",
        hadCredentials: true,
        serviceRunning: false,
      },
    ]);
    await apolloConfigStep.apply(CONFIG);
    const script = checkedScript(0);
    expect(script).toContain("sunshine_name = mon-pc");
    expect(script).toContain("commentaire perso");
    expect(script).toContain("headless_mode = enabled");
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/apollo-config.test.ts`
Attendu : ÉCHEC — `apply()` lève `Error("pas encore implémenté")`.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Ajouter les imports manquants et le corps d'`apply` :

```ts
import { psDoubleQuote, psQuote } from "../lib/powershell";
import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import { deleteSecret, generatePassword, setSecret } from "../lib/keychain";
import { REQUIRED_CONF, confConforms, patchConf } from "../lib/apollo-conf";
```

Ajouter, après `READ_STATE` :

```ts
const READ_STATE_FOR_APPLY = (installDir: string, serviceName: string) => {
  const installDirQ = psQuote(installDir, "répertoire d'installation");
  const serviceNameQ = psQuote(serviceName, "nom du service");
  return `
$confPath = ${CONFIG_PATH_EXPR(installDirQ)}
$statePath = ${STATE_PATH_EXPR(installDirQ)}
$conf = if (Test-Path $confPath) { Get-Content -Path $confPath -Raw } else { $null }
$hadCredentials = $false
if (Test-Path $statePath) {
  try {
    $state = Get-Content -Path $statePath -Raw | ConvertFrom-Json
    if ($state.root -and $state.root.username) { $hadCredentials = $true }
  } catch {}
}
$service = Get-Service -Name ${serviceNameQ} -ErrorAction SilentlyContinue
[pscustomobject]@{
  conf           = $conf
  hadCredentials = [bool]$hadCredentials
  serviceRunning = [bool]($service -and $service.Status -eq 'Running')
}`;
};

/**
 * --creds ecrit sur disque mais ne recharge pas un service deja en memoire :
 * pose avant le premier demarrage dans le deroulement normal (apollo-config
 * s'applique avant qu'apollo-service ne demarre le service pour la premiere
 * fois), ou suivie d'un redemarrage explicite si le service tournait deja
 * (reexecution partielle).
 */
function buildApplyScript(
  config: Config,
  password: string | null,
  patchedConf: string,
  serviceWasRunning: boolean,
): string {
  const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
  const serviceNameQ = psQuote(config.apollo.serviceName, "nom du service");
  const lines: string[] = [];

  if (password !== null) {
    const userQ = psQuote(config.apollo.webUser, "compte web Apollo");
    const passwordQ = psQuote(password, "mot de passe web Apollo");
    lines.push(
      `& (Join-Path ${installDirQ} 'sunshine.exe') '--creds' ${userQ} ${passwordQ}`,
      `if ($LASTEXITCODE -ne 0) { throw "Echec de sunshine.exe --creds (code $LASTEXITCODE)" }`,
    );
  }

  lines.push(
    `New-Item -ItemType Directory -Path (Join-Path ${installDirQ} 'config') -Force -ErrorAction SilentlyContinue | Out-Null`,
    `Set-Content -Path ${CONFIG_PATH_EXPR(installDirQ)} -Value ${psDoubleQuote(patchedConf)} -Encoding ascii`,
  );

  if (serviceWasRunning) {
    lines.push(`Restart-Service -Name ${serviceNameQ} -Force -ErrorAction SilentlyContinue`);
  }

  return lines.join("\n");
}
```

Et remplacer le corps d'`apply` :

```ts
  async apply(config: Config) {
    const rows = await runRemoteJson<{
      conf: string | null;
      hadCredentials: boolean;
      serviceRunning: boolean;
    }>(config.ssh, READ_STATE_FOR_APPLY(config.apollo.installDir, config.apollo.serviceName));
    const current = rows[0];
    if (!current) {
      throw new Error(
        "Le PC n'a renvoyé aucun état de configuration Apollo. Vérifier la liaison SSH.",
      );
    }

    const patched = patchConf(current.conf ?? "", REQUIRED_CONF);

    let password: string | null = null;
    if (!current.hadCredentials) {
      password = generatePassword();
      await setSecret("apollo-web", password);
    }

    await runRemoteChecked(
      config.ssh,
      buildApplyScript(config, password, patched, current.serviceRunning),
    );
  },
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/steps/apollo-config.test.ts`
Attendu : tous les tests des cycles 1 et 2 passent.

- [ ] **Étape 5 : Commiter**

```bash
git add src/steps/apollo-config.ts test/steps/apollo-config.test.ts
git commit -m "$(cat <<'EOF'
feat(apollo-config): identifiants web au trousseau, six cles patchees

apply() ne pose des identifiants que s'ils sont absents, avant le premier
demarrage du service ou suivi d'un redemarrage explicite s'il tournait
deja. patchConf() applique les six cles requises en preservant le reste du
fichier.
EOF
)"
```

---

#### Cycle 3 — `apollo-config.restore`

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
describe("restore", () => {
  test("rend le contenu exact d'avant et retire le secret cree par hardline", async () => {
    await apolloConfigStep.restore(
      CONFIG,
      { conf: "sunshine_name = ancien", hadCredentials: false },
      { pending: [] },
    );
    expect(checkedScript(0)).toContain("sunshine_name = ancien");
    expect(checkedScript(0)).toContain("Set-Content");
    expect(deleteSecret).toHaveBeenCalledWith("apollo-web");
  });

  test("supprime le fichier quand il n'existait pas avant, et garde le secret preexistant", async () => {
    await apolloConfigStep.restore(CONFIG, { conf: null, hadCredentials: true }, { pending: [] });
    expect(checkedScript(0)).toContain("Remove-Item");
    expect(deleteSecret).not.toHaveBeenCalled();
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/apollo-config.test.ts`
Attendu : ÉCHEC — `restore()` lève `Error("pas encore implémenté")`.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
  /**
   * Rend le contenu exact d'avant, verbatim. hadCredentials decrit l'etat
   * AVANT apply() : s'il etait false, c'est hardline qui a cree ce secret,
   * et lui seul est retire. La restitution du fichier n'implique aucune
   * hypothese sur ce qu'apollo-install fera ensuite (dans l'ordre inverse,
   * apollo-install.restore s'execute apres) : ce cas compte precisement
   * quand Apollo est etranger et qu'apollo-install.restore cede sa place.
   */
  async restore(config: Config, previous: ApolloConfState) {
    const installDirQ = psQuote(config.apollo.installDir, "répertoire d'installation");
    const script =
      previous.conf === null
        ? `Remove-Item -Path ${CONFIG_PATH_EXPR(installDirQ)} -Force -ErrorAction SilentlyContinue`
        : `Set-Content -Path ${CONFIG_PATH_EXPR(installDirQ)} -Value ${psDoubleQuote(previous.conf)} -Encoding ascii`;

    await runRemoteChecked(config.ssh, script);

    if (!previous.hadCredentials) {
      await deleteSecret("apollo-web");
    }
  },
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/steps/apollo-config.test.ts`
Attendu : les 9 tests du fichier passent. `bunx tsc --noEmit` silencieux.

- [ ] **Étape 5 : Commiter**

```bash
git add src/steps/apollo-config.ts test/steps/apollo-config.test.ts
git commit -m "$(cat <<'EOF'
feat(apollo-config): restitution verbatim et retrait conditionnel du secret

restore() reecrit le contenu exact d'avant, ou supprime le fichier s'il
n'existait pas ; le secret n'est retire du trousseau que si hardline
l'avait cree.
EOF
)"
```

---

#### Cycle 4 — `apollo-service.inspect` et `apply`

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/steps/apollo-service.test.ts
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";

let jsonQueue: unknown[][] = [];
const runRemoteJson = mock(async () => {
  const next = jsonQueue.shift();
  if (!next) throw new Error("file d'attente JSON vide dans le test");
  return next;
});
const runRemoteChecked = mock(async (..._args: unknown[]) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../../src/lib/ssh", () => ({ runRemoteJson, runRemoteChecked }));

const { apolloServiceStep } = await import("../../src/steps/apollo-service");

beforeEach(() => {
  jsonQueue = [];
  runRemoteJson.mockClear();
  runRemoteChecked.mockClear();
});

function checkedScript(call: number): string {
  return String((runRemoteChecked.mock.calls[call] as unknown[])[1]);
}

describe("inspect", () => {
  test("conforme quand automatique et demarre", async () => {
    jsonQueue.push([{ startType: "Automatic", status: "Running" }]);
    const state = await apolloServiceStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
  });

  test("non conforme quand demarrage manuel", async () => {
    jsonQueue.push([{ startType: "Manual", status: "Stopped" }]);
    const state = await apolloServiceStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
  });
});

describe("apply", () => {
  test("passe en demarrage automatique puis demarre", async () => {
    await apolloServiceStep.apply(CONFIG);
    const script = checkedScript(0);
    const config = script.indexOf("start= auto");
    const start = script.indexOf("Start-Service");
    expect(config).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(config);
    expect(script).toContain(`sc.exe config '${CONFIG.apollo.serviceName}'`);
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/apollo-service.test.ts`
Attendu : ÉCHEC — `Cannot find module '../../src/steps/apollo-service'`.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/steps/apollo-service.ts
import { psKeyword, psQuote } from "../lib/powershell";
import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import type { Config } from "../config";
import type { Step } from "./types";

export type ServiceState = { startType: string | null; status: string | null };

const STARTUP_TYPES = ["Automatic", "Manual", "Disabled", "Boot", "System"] as const;

const INSPECT = (serviceName: string) => `
$service = Get-Service -Name ${psQuote(serviceName, "nom du service")} -ErrorAction SilentlyContinue
[pscustomobject]@{
  startType = if ($service) { [string]$service.StartType } else { $null }
  status    = if ($service) { [string]$service.Status } else { $null }
}`;

export const apolloServiceStep: Step<ServiceState> = {
  name: "apollo-service",
  label: "Service Apollo au démarrage (PC)",

  async inspect(config: Config) {
    const rows = await runRemoteJson<ServiceState>(
      config.ssh,
      INSPECT(config.apollo.serviceName),
    );
    const current = rows[0];
    if (!current) {
      throw new Error(
        "Le PC n'a renvoyé aucun état du service Apollo. Vérifier la liaison SSH.",
      );
    }
    const conforming = current.startType === "Automatic" && current.status === "Running";
    return {
      conforming,
      current,
      detail: conforming
        ? "service déjà en démarrage automatique et démarré"
        : `service ${current.status ?? "absent"}, démarrage ${current.startType ?? "inconnu"}`,
    };
  },

  async apply(config: Config) {
    const serviceNameQ = psQuote(config.apollo.serviceName, "nom du service");
    // "start= auto" : espace apres le signe egal, aucun avant. Un des rares
    // pieges de syntaxe de sc.exe, non negociable.
    await runRemoteChecked(
      config.ssh,
      `sc.exe config ${serviceNameQ} start= auto | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Echec de sc.exe config (code $LASTEXITCODE)" }
Start-Service -Name ${serviceNameQ}`,
    );
  },

  async restore(_config: Config, _previous: ServiceState) {
    throw new Error("pas encore implémenté");
  },
};
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/steps/apollo-service.test.ts`
Attendu : les 3 tests des `describe("inspect", ...)` et `describe("apply",
...)` passent.

- [ ] **Étape 5 : Commiter**

```bash
git add src/steps/apollo-service.ts test/steps/apollo-service.test.ts
git commit -m "$(cat <<'EOF'
feat(apollo-service): demarrage automatique du service Apollo

inspect() releve StartType et Status ; apply() bascule le service en
demarrage automatique (sc.exe config ... start= auto) puis le demarre.
EOF
)"
```

---

#### Cycle 5 — `apollo-service.restore`

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
describe("restore", () => {
  test("rend le demarrage et l'etat exacts d'avant", async () => {
    await apolloServiceStep.restore(
      CONFIG,
      { startType: "Manual", status: "Stopped" },
      { pending: [] },
    );
    const script = checkedScript(0);
    expect(script).toContain("-StartupType Manual");
    expect(script).toContain("Stop-Service");
    expect(script).not.toContain("Start-Service -Name");
  });

  test("n'ecrit rien quand le service n'existait pas", async () => {
    await apolloServiceStep.restore(CONFIG, { startType: null, status: null }, { pending: [] });
    expect(runRemoteChecked).not.toHaveBeenCalled();
  });

  test("rejette un type de demarrage hors de l'ensemble connu", async () => {
    await expect(
      apolloServiceStep.restore(CONFIG, { startType: "Bogus", status: null }, { pending: [] }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/apollo-service.test.ts`
Attendu : ÉCHEC — `restore()` lève `Error("pas encore implémenté")` au lieu
du comportement attendu.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Remplacer le corps de `restore` :

```ts
  /**
   * Rend startType et status tels que releves par inspect, independamment de
   * ce qu'apollo-install fera ensuite (il s'execute apres, dans l'ordre
   * inverse) : si Apollo est etranger et qu'apollo-install cede sa place,
   * c'est cette etape qui reste seule responsable de rendre l'etat du
   * service.
   */
  async restore(config: Config, previous: ServiceState) {
    const serviceNameQ = psQuote(config.apollo.serviceName, "nom du service");
    const lines: string[] = [];

    if (previous.startType) {
      const startupType = psKeyword(
        previous.startType,
        "type de démarrage relevé",
        STARTUP_TYPES,
      );
      lines.push(
        `Set-Service -Name ${serviceNameQ} -StartupType ${startupType} -ErrorAction SilentlyContinue`,
      );
    }

    if (previous.status === "Running") {
      lines.push(`Start-Service -Name ${serviceNameQ} -ErrorAction SilentlyContinue`);
    } else if (previous.status === "Stopped") {
      lines.push(`Stop-Service -Name ${serviceNameQ} -Force -ErrorAction SilentlyContinue`);
    }

    if (lines.length === 0) return;
    await runRemoteChecked(config.ssh, lines.join("\n"));
  },
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/steps/apollo-service.test.ts`
Attendu : les 6 tests du fichier passent. `bunx tsc --noEmit` silencieux.

- [ ] **Étape 5 : Commiter**

```bash
git add src/steps/apollo-service.ts test/steps/apollo-service.test.ts
git commit -m "$(cat <<'EOF'
feat(apollo-service): restitution du demarrage et de l'etat exacts d'avant

restore() rend StartType et Status tels que releves par inspect, sans
presumer de ce que fera apollo-install ensuite : c'est cette etape qui reste
seule responsable de l'etat du service si Apollo est etranger et
qu'apollo-install cede sa place.
EOF
)"
```

---

### Tâche 10 : Étapes `smb-shares`, `moonlight-install` et `smb-credentials`

**Fichiers :**
- Créer : `src/lib/brew.ts`
- Créer : `src/steps/smb-shares.ts`
- Créer : `src/steps/moonlight-install.ts`
- Créer : `src/steps/smb-credentials.ts`
- Modifier : `src/lib/ui.ts`
- Test : `test/lib/brew.test.ts`
- Test : `test/steps/smb-shares.test.ts`
- Test : `test/steps/moonlight-install.test.ts`
- Test : `test/steps/smb-credentials.test.ts`
- Test : `test/lib/ui.test.ts`

**Interfaces :**
- Consomme : `Step<P>` (`src/steps/types.ts`) ; `Config`, `SMBShare`,
  `SMBConfig`, `MoonlightConfig` (`src/config.ts`) ; `psQuote`
  (`src/lib/powershell.ts`) ; `runRemoteJson`, `runRemoteChecked`
  (`src/lib/ssh.ts`) ; `getSecret`, `setSecret`, `deleteSecret`, `SecretName`
  (`src/lib/keychain.ts`, tâche antérieure — non encore présent dans le dépôt
  au moment d'écrire ce plan, signature prise telle quelle dans
  `interfaces.md`).
- Produit : `ShareState` (`src/steps/smb-shares.ts`), `smbSharesStep` ;
  `MoonlightState` (`src/lib/brew.ts`, réutilisé tel quel comme type de relevé
  de `moonlight-install.ts`), `moonlightInstallStep` ; `CredentialState`,
  `smbCredentialsStep`, `providePassword` (`src/steps/smb-credentials.ts`) ;
  `askSecret` (`src/lib/ui.ts`). `providePassword` et `askSecret` seront
  consommés par la tâche 12, qui câble l'invite de mot de passe dans
  `hardline install` — cette tâche-ci ne touche à aucune commande.

Aucune de ces trois étapes n'est encore enregistrée dans `LOCAL_STEPS` ou
`REMOTE_STEPS` : c'est la tâche 12 qui câble le registre. Cette tâche-ci les
rend correctes et testées en isolation.

---

#### Cycle 1 — `src/lib/brew.ts` : lecture d'un cask Homebrew

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/lib/brew.test.ts
import { test, expect, describe } from "bun:test";
import { parseCaskInfo } from "../../src/lib/brew";

const INSTALLED = JSON.stringify({
  casks: [{ token: "moonlight", installed: "6.1.0" }],
});

const ABSENT = JSON.stringify({
  casks: [{ token: "moonlight", installed: null }],
});

describe("parseCaskInfo", () => {
  test("lit un cask installe et sa version", () => {
    expect(parseCaskInfo(INSTALLED, "moonlight")).toEqual({
      installed: true,
      version: "6.1.0",
    });
  });

  test("rend non installe quand la valeur installed est nulle", () => {
    expect(parseCaskInfo(ABSENT, "moonlight")).toEqual({
      installed: false,
      version: null,
    });
  });

  test("rend non installe sur une sortie vide", () => {
    expect(parseCaskInfo("", "moonlight")).toEqual({
      installed: false,
      version: null,
    });
  });

  test("rend non installe sur un JSON illisible plutot que de lever", () => {
    expect(parseCaskInfo("{ceci n'est pas du json", "moonlight")).toEqual({
      installed: false,
      version: null,
    });
  });

  test("ignore les entrees d'un autre cask", () => {
    const other = JSON.stringify({
      casks: [{ token: "autre-app", installed: "1.0" }],
    });
    expect(parseCaskInfo(other, "moonlight")).toEqual({
      installed: false,
      version: null,
    });
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/lib/brew.test.ts`
Attendu : ÉCHEC avec « Cannot find module '../../src/lib/brew' » (le fichier
n'existe pas encore).

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/lib/brew.ts
import { $ } from "bun";

/** Etat d'un cask Homebrew : installe ou non, et sa version le cas echeant. */
export type MoonlightState = {
  installed: boolean;
  version: string | null;
};

type CaskInfoJson = {
  casks?: Array<{ token?: string; installed?: string | null }>;
};

/**
 * Fonction pure. Lit la sortie de `brew info --cask --json=v2 <cask>`.
 * Un cask absent du catalogue, jamais installe, ou une sortie illisible
 * rendent tous le meme etat : rien n'est installe. Une erreur de lecture ne
 * doit jamais faire echouer inspect() sur un simple JSON malforme.
 */
export function parseCaskInfo(stdout: string, cask: string): MoonlightState {
  const trimmed = stdout.trim();
  if (trimmed === "") return { installed: false, version: null };

  let parsed: CaskInfoJson;
  try {
    parsed = JSON.parse(trimmed) as CaskInfoJson;
  } catch {
    return { installed: false, version: null };
  }

  const entry = parsed.casks?.find((c) => c.token === cask);
  if (!entry || !entry.installed) return { installed: false, version: null };
  return { installed: true, version: entry.installed };
}

// --- Frontiere systeme. ---

export async function caskInfo(cask: string): Promise<MoonlightState> {
  const { stdout } = await $`brew info --cask --json=v2 ${cask}`.quiet().nothrow();
  return parseCaskInfo(stdout.toString(), cask);
}

export async function installCask(cask: string): Promise<number> {
  const { exitCode } = await $`brew install --cask ${cask}`.quiet().nothrow();
  return exitCode;
}

export async function uninstallCask(cask: string): Promise<number> {
  const { exitCode } = await $`brew uninstall --cask ${cask}`.quiet().nothrow();
  return exitCode;
}
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/lib/brew.test.ts`

- [ ] **Étape 5 : Commiter**

```bash
git add src/lib/brew.ts test/lib/brew.test.ts
git commit -m "lib(brew): lecture pure de l'etat d'un cask Homebrew"
```

---

#### Cycle 2 — `moonlight-install` : `inspect` et `apply`

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/steps/moonlight-install.test.ts
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";
import type { MoonlightState } from "../../src/lib/brew";

let currentState: MoonlightState;
const install = mock(async (..._args: unknown[]) => 0);
const uninstall = mock(async (..._args: unknown[]) => 0);

mock.module("../../src/lib/brew", () => ({
  caskInfo: async () => currentState,
  installCask: install,
  uninstallCask: uninstall,
}));

const { moonlightInstallStep } = await import("../../src/steps/moonlight-install");

beforeEach(() => {
  install.mockClear();
  uninstall.mockClear();
});

describe("inspect", () => {
  test("declare conforme quand le cask est deja installe", async () => {
    currentState = { installed: true, version: "6.1.0" };
    const state = await moonlightInstallStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
    expect(state.detail).toContain("6.1.0");
  });

  test("declare non conforme quand le cask est absent", async () => {
    currentState = { installed: false, version: null };
    const state = await moonlightInstallStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current).toEqual({ installed: false, version: null });
  });
});

describe("apply", () => {
  test("installe le cask configure", async () => {
    await moonlightInstallStep.apply(CONFIG);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith("moonlight");
  });

  test("rejette quand brew refuse l'installation", async () => {
    install.mockImplementationOnce(async () => 1);
    await expect(moonlightInstallStep.apply(CONFIG)).rejects.toThrow(
      /Homebrew a refusé/,
    );
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/moonlight-install.test.ts`
Attendu : ÉCHEC, « Cannot find module '../../src/steps/moonlight-install' ».

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/steps/moonlight-install.ts
import { caskInfo, installCask, uninstallCask } from "../lib/brew";
import type { MoonlightState } from "../lib/brew";
import type { Config } from "../config";
import type { Step } from "./types";

export type { MoonlightState } from "../lib/brew";

/**
 * Le code de retour de brew ne doit jamais etre ignore : sans cette
 * verification l'etape se declare accomplie meme quand l'operation a echoue,
 * et l'orchestrateur enregistre une convergence qui n'a pas eu lieu.
 */
function ensureAccepted(exitCode: number, action: string, cask: string): void {
  if (exitCode === 0) return;
  throw new Error(
    `Homebrew a refusé de ${action} le cask «\u00a0${cask}\u00a0» (code ${exitCode}).`,
  );
}

export const moonlightInstallStep: Step<MoonlightState> = {
  name: "moonlight-install",
  label: "Client Moonlight installé (Mac)",

  async inspect(config: Config) {
    const current = await caskInfo(config.moonlight.cask);
    return {
      conforming: current.installed,
      current,
      detail: current.installed
        ? `${config.moonlight.cask} ${current.version ?? "version inconnue"}`
        : `${config.moonlight.cask} absent`,
    };
  },

  async apply(config: Config) {
    const exitCode = await installCask(config.moonlight.cask);
    ensureAccepted(exitCode, "poser", config.moonlight.cask);
  },

  async restore(config: Config) {
    const exitCode = await uninstallCask(config.moonlight.cask);
    ensureAccepted(exitCode, "retirer", config.moonlight.cask);
  },
};
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

- [ ] **Étape 5 : Commiter**

```bash
git add src/steps/moonlight-install.ts test/steps/moonlight-install.test.ts
git commit -m "steps(moonlight-install): pose du cask Homebrew, inspect et apply"
```

---

#### Cycle 3 — `moonlight-install` : `restore` retire toujours Moonlight

- [ ] **Étape 1 : Écrire le test qui échoue**

Ajouter à `test/steps/moonlight-install.test.ts` :

```ts
describe("restore", () => {
  test("retire toujours le cask, meme si l'etat anterieur pretend qu'il etait deja installe", async () => {
    // La spec a tranche : la desinstallation retire Moonlight sans exception,
    // contrairement a la regle habituelle de ne defaire que ce qu'on a fait.
    // Un etat anterieur "installed: true" ne doit rien changer au geste.
    await moonlightInstallStep.restore(
      CONFIG,
      { installed: true, version: "6.1.0" },
      { pending: [] },
    );
    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(uninstall).toHaveBeenCalledWith("moonlight");
  });

  test("rejette quand brew refuse la desinstallation", async () => {
    uninstall.mockImplementationOnce(async () => 1);
    await expect(
      moonlightInstallStep.restore(
        CONFIG,
        { installed: false, version: null },
        { pending: [] },
      ),
    ).rejects.toThrow(/Homebrew a refusé/);
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/moonlight-install.test.ts`
Attendu : ÉCHEC — `restore` n'existe pas encore d'appel réel à `uninstallCask`
tant que l'étape 3 précédente n'a écrit que `inspect`/`apply` ; à ce stade
`restore` est déjà écrit (cycle 2), donc ce test sert de verrou : il échouerait
si un développeur remplaçait un jour l'appel inconditionnel par un test sur
`previous.installed`.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Déjà couverte par le cycle 2 (`restore` y est écrit sans branche sur
`previous`). Rien à ajouter ici ; ce cycle documente et verrouille le
comportement par le test ci-dessus.

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

- [ ] **Étape 5 : Commiter**

```bash
git add test/steps/moonlight-install.test.ts
git commit -m "test(moonlight-install): verrouille le retrait inconditionnel a la restauration"
```

---

#### Cycle 4 — `smb-shares` : `inspect` et `apply`

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/steps/smb-shares.test.ts
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";
import type { ShareState } from "../../src/steps/smb-shares";

let remoteState: ShareState[];
const runRemoteJson = mock(async (..._args: unknown[]) => remoteState);
const runRemoteChecked = mock(async (..._args: unknown[]) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../../src/lib/ssh", () => ({ runRemoteJson, runRemoteChecked }));

const { smbSharesStep } = await import("../../src/steps/smb-shares");

function scriptOf(call: number): string {
  return String((runRemoteChecked.mock.calls[call] as unknown[])[1]);
}

beforeEach(() => {
  runRemoteJson.mockClear();
  runRemoteChecked.mockClear();
});

describe("inspect", () => {
  test("declare conforme quand D: et E: existent deja", async () => {
    remoteState = [
      { name: "hardline-d", existed: true },
      { name: "hardline-e", existed: true },
    ];
    const state = await smbSharesStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
  });

  test("declare non conforme quand un partage manque", async () => {
    remoteState = [
      { name: "hardline-d", existed: false },
      { name: "hardline-e", existed: true },
    ];
    const state = await smbSharesStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current).toEqual([
      { name: "hardline-d", existed: false },
      { name: "hardline-e", existed: true },
    ]);
  });

  test("n'interroge jamais le partage arthur, qui preexiste", async () => {
    remoteState = [
      { name: "hardline-d", existed: false },
      { name: "hardline-e", existed: false },
    ];
    await smbSharesStep.inspect(CONFIG);
    const script = String((runRemoteJson.mock.calls[0] as unknown[])[1]);
    expect(script).not.toContain("'arthur'");
    expect(script).toContain("'hardline-d'");
    expect(script).toContain("'hardline-e'");
  });
});

describe("apply", () => {
  test("cree les partages manquants, avec l'acces complet au compte configure", async () => {
    await smbSharesStep.apply(CONFIG);
    expect(runRemoteChecked).toHaveBeenCalledTimes(1);
    const script = scriptOf(0);
    expect(script).toContain("New-SmbShare");
    expect(script).toContain("-Path 'D:\\'");
    expect(script).toContain("-Path 'E:\\'");
    expect(script).toContain("-FullAccess 'arthur'");
  });

  test("garde une garde d'existence avant de creer, pour rester idempotent", async () => {
    await smbSharesStep.apply(CONFIG);
    const script = scriptOf(0);
    expect(script).toContain("Get-SmbShare -Name 'hardline-d'");
    expect(script).toContain("if (-not $s)");
  });

  test("propage l'echec d'une commande distante", async () => {
    runRemoteChecked.mockImplementationOnce(async () => {
      throw new Error("acces refuse");
    });
    await expect(smbSharesStep.apply(CONFIG)).rejects.toThrow("acces refuse");
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/smb-shares.test.ts`
Attendu : ÉCHEC, « Cannot find module '../../src/steps/smb-shares' ».

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/steps/smb-shares.ts
import { psQuote } from "../lib/powershell";
import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import type { Config, SMBShare } from "../config";
import type { Step } from "./types";

export type ShareState = { name: string; existed: boolean };

/**
 * Les partages que cette etape cree et defait. "arthur" en est exclu : il
 * preexiste sur le PC de reference et son chemin vaut null dans la
 * configuration precisement pour marquer qu'il n'est pas a creer.
 */
function managedShares(config: Config): SMBShare[] {
  return config.smb.shares.filter((share) => share.path !== null);
}

const INSPECT = (names: string[]) => `
$names = @(${names.map((n) => psQuote(n, "nom de partage")).join(", ")})
$names | ForEach-Object {
  $s = Get-SmbShare -Name $_ -ErrorAction SilentlyContinue
  [pscustomobject]@{ name = $_; existed = [bool]$s }
}`;

const APPLY = (shares: SMBShare[], user: string) =>
  shares
    .map((share) => {
      const name = psQuote(share.name, "nom de partage");
      const path = psQuote(share.path as string, "chemin de partage");
      const owner = psQuote(user, "compte du partage");
      return [
        `$s = Get-SmbShare -Name ${name} -ErrorAction SilentlyContinue`,
        `if (-not $s) { New-SmbShare -Name ${name} -Path ${path} -FullAccess ${owner} | Out-Null }`,
      ].join("\n");
    })
    .join("\n");

const RESTORE = (names: string[]) =>
  names
    .map(
      (name) =>
        `Remove-SmbShare -Name ${psQuote(name, "nom de partage")} -Force -Confirm:$false -ErrorAction SilentlyContinue`,
    )
    .join("\n");

export const smbSharesStep: Step<ShareState[]> = {
  name: "smb-shares",
  label: "Partages des disques D: et E: (PC)",

  async inspect(config: Config) {
    const managed = managedShares(config);
    const rows = await runRemoteJson<ShareState>(
      config.ssh,
      INSPECT(managed.map((s) => s.name)),
    );
    const current = managed.map((share) => {
      const row = rows.find((r) => r.name === share.name);
      return { name: share.name, existed: row?.existed ?? false };
    });

    const conforming = current.every((s) => s.existed);

    return {
      conforming,
      current,
      detail: conforming
        ? `${current.map((s) => s.name).join(", ")} déjà présents`
        : `manquants\u00a0: ${current.filter((s) => !s.existed).map((s) => s.name).join(", ")}`,
    };
  },

  async apply(config: Config) {
    const managed = managedShares(config);
    if (managed.length === 0) return;
    await runRemoteChecked(config.ssh, APPLY(managed, config.smb.user));
  },

  async restore(config: Config, previous: ShareState[]) {
    const toRemove = previous.filter((s) => !s.existed).map((s) => s.name);
    if (toRemove.length === 0) return;
    await runRemoteChecked(config.ssh, RESTORE(toRemove));
  },
};
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

- [ ] **Étape 5 : Commiter**

```bash
git add src/steps/smb-shares.ts test/steps/smb-shares.test.ts
git commit -m "steps(smb-shares): creation idempotente des partages D: et E:"
```

---

#### Cycle 5 — `smb-shares` : `restore` ne touche jamais à `arthur`

- [ ] **Étape 1 : Écrire le test qui échoue**

Ajouter à `test/steps/smb-shares.test.ts` :

```ts
describe("restore", () => {
  const NO_PENDING = { pending: [] as string[] };

  test("ne retire que les partages que l'etape avait crees", async () => {
    await smbSharesStep.restore(
      CONFIG,
      [
        { name: "hardline-d", existed: false },
        { name: "hardline-e", existed: true },
      ],
      NO_PENDING,
    );
    const script = scriptOf(0);
    expect(script).toContain("Remove-SmbShare -Name 'hardline-d'");
    expect(script).not.toContain("hardline-e");
  });

  test("ne touche a rien quand tous les partages geres preexistaient", async () => {
    await smbSharesStep.restore(
      CONFIG,
      [
        { name: "hardline-d", existed: true },
        { name: "hardline-e", existed: true },
      ],
      NO_PENDING,
    );
    expect(runRemoteChecked).not.toHaveBeenCalled();
  });

  test("ne mentionne jamais arthur, absent du releve gere par cette etape", async () => {
    await smbSharesStep.restore(
      CONFIG,
      [{ name: "hardline-d", existed: false }],
      NO_PENDING,
    );
    expect(scriptOf(0)).not.toContain("arthur");
  });

  test("propage l'echec d'une commande distante", async () => {
    runRemoteChecked.mockImplementationOnce(async () => {
      throw new Error("acces refuse");
    });
    await expect(
      smbSharesStep.restore(
        CONFIG,
        [{ name: "hardline-d", existed: false }],
        NO_PENDING,
      ),
    ).rejects.toThrow("acces refuse");
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Ces tests passent déjà avec l'implémentation du cycle 4 (`restore` y filtre
`existed === false`). Lancer d'abord `bun test --isolate
test/steps/smb-shares.test.ts` en commentant temporairement le filtre
`.filter((s) => !s.existed)` de `RESTORE`'s appelant (le remplacer par
`previous.map((s) => s.name)`) pour constater l'échec du test « ne retire que
les partages que l'etape avait crees », puis rétablir le filtre. C'est ce
geste — retirer puis remettre — qui prouve que le test verrouille bien le bon
comportement.
Attendu à l'étape défaite : le script généré contient `Remove-SmbShare -Name
'hardline-e'`, ce que le test refuse.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Déjà en place depuis le cycle 4 (`restore` filtre `!s.existed`). Aucune
modification de production nécessaire ; ce cycle ajoute la couverture qui
verrouille le comportement contre une régression future.

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/steps/smb-shares.test.ts`

- [ ] **Étape 5 : Commiter**

```bash
git add test/steps/smb-shares.test.ts
git commit -m "test(smb-shares): verrouille le respect du partage arthur a la restauration"
```

---

#### Cycle 6 — `src/lib/ui.ts` : `askSecret`

- [ ] **Étape 1 : Écrire le test qui échoue**

Modifier `test/lib/ui.test.ts` : ajouter `password` au mock de
`@clack/prompts` et importer `askSecret`.

```ts
// Dans le mock.module("@clack/prompts", () => ({ ... })) existant, ajouter :
  password: async () => (cancelNext ? Symbol("cancel") : "s3cr3t"),
```

```ts
// Dans la ligne d'import existante, ajouter askSecret :
const { configureOutput, ui, withSpinner, askConfirmation, askSecret, CancelledError } =
  await import("../../src/lib/ui");
```

```ts
// Nouveau bloc, ajoute a la fin du fichier :
describe("askSecret", () => {
  test("leve une erreur explicite hors terminal, sans jamais bloquer", async () => {
    await expect(
      askSecret("Mot de passe Windows", { interactive: false }),
    ).rejects.toThrow(/terminal interactif/);
    expect(calls).toHaveLength(0);
  });

  test("rend la valeur saisie en mode interactif", async () => {
    expect(await askSecret("Mot de passe Windows", { interactive: true })).toBe(
      "s3cr3t",
    );
  });

  test("leve CancelledError sur annulation", async () => {
    cancelNext = true;
    const attempt = askSecret("Mot de passe Windows", { interactive: true });
    await expect(attempt).rejects.toBeInstanceOf(CancelledError);
    await attempt.catch(() => {});
    cancelNext = false;
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/lib/ui.test.ts`
Attendu : ÉCHEC, « askSecret is not a function » (ou erreur d'import — le nom
n'existe pas encore dans `src/lib/ui.ts`).

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Dans `src/lib/ui.ts`, ajouter `password` à l'import `@clack/prompts` et la
fonction suivante après `askConfirmation` :

```ts
import {
  intro,
  outro,
  note,
  log,
  spinner,
  confirm,
  password,
  isCancel,
  cancel,
} from "@clack/prompts";
```

```ts
export type AskSecretOptions = {
  /** Injectable pour les tests ; par defaut, detection du terminal. */
  interactive?: boolean;
};

/**
 * Demande une valeur secrete au clavier, masquee a l'affichage. Contrairement
 * a askConfirmation, il n'existe pas de reponse par defaut sensee pour un
 * secret : hors terminal, la fonction leve plutot que d'inventer une valeur.
 */
export async function askSecret(
  message: string,
  options: AskSecretOptions = {},
): Promise<string> {
  const interactive = options.interactive ?? isInteractive();
  if (!interactive) {
    throw new Error(
      `Un terminal interactif est nécessaire pour demander\u00a0: ${message}`,
    );
  }

  const answer = await password({ message });
  if (isCancel(answer)) {
    cancel("Interrompu.");
    throw new CancelledError();
  }
  return answer;
}
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

- [ ] **Étape 5 : Commiter**

```bash
git add src/lib/ui.ts test/lib/ui.test.ts
git commit -m "lib(ui): ajoute askSecret pour la saisie masquee d'un mot de passe"
```

---

#### Cycle 7 — `smb-credentials` : `inspect` et `apply`, via le pont `providePassword`

L'étape ne dialogue jamais — règle absolue du projet. Le mot de passe est donc
recueilli par la commande (câblée en tâche 12) et déposé ici par un petit pont
en mémoire, consommé une seule fois par `apply()`.

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/steps/smb-credentials.test.ts
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";

let storedSecret: string | null;
const setSecret = mock(async (_name: string, value: string) => {
  storedSecret = value;
});
const deleteSecret = mock(async (_name: string) => {
  const existed = storedSecret !== null;
  storedSecret = null;
  return existed;
});

mock.module("../../src/lib/keychain", () => ({
  getSecret: async () => storedSecret,
  setSecret,
  deleteSecret,
}));

const { smbCredentialsStep, providePassword } = await import(
  "../../src/steps/smb-credentials"
);

beforeEach(() => {
  storedSecret = null;
  setSecret.mockClear();
  deleteSecret.mockClear();
});

describe("inspect", () => {
  test("declare conforme quand un secret est deja au trousseau", async () => {
    storedSecret = "ancien-mot-de-passe";
    const state = await smbCredentialsStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
    expect(state.current).toEqual({ present: true });
  });

  test("declare non conforme quand le trousseau est vide", async () => {
    const state = await smbCredentialsStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current).toEqual({ present: false });
  });

  test("ne revele jamais la valeur du secret dans le detail", async () => {
    storedSecret = "s3cr3t-Windows!";
    const state = await smbCredentialsStep.inspect(CONFIG);
    expect(state.detail).not.toContain("s3cr3t-Windows!");
  });
});

describe("apply", () => {
  test("range le mot de passe depose par providePassword", async () => {
    providePassword("hunter2");
    await smbCredentialsStep.apply(CONFIG);
    expect(setSecret).toHaveBeenCalledWith("windows-account", "hunter2");
  });

  test("efface le mot de passe en memoire une fois range : un second appel sans nouveau depot echoue", async () => {
    providePassword("hunter2");
    await smbCredentialsStep.apply(CONFIG);
    setSecret.mockClear();
    await expect(smbCredentialsStep.apply(CONFIG)).rejects.toThrow(
      /Mot de passe Windows manquant/,
    );
    expect(setSecret).not.toHaveBeenCalled();
  });

  test("rejette si aucun mot de passe n'a ete depose", async () => {
    await expect(smbCredentialsStep.apply(CONFIG)).rejects.toThrow(
      /providePassword\(\) doit être appelé/,
    );
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/smb-credentials.test.ts`
Attendu : ÉCHEC, « Cannot find module '../../src/steps/smb-credentials' ».

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/steps/smb-credentials.ts
import { deleteSecret, getSecret, setSecret } from "../lib/keychain";
import type { Config } from "../config";
import type { Step } from "./types";

export type CredentialState = { present: boolean };

/**
 * L'etape ne dialogue jamais : c'est une regle absolue du projet. Le mot de
 * passe est donc recueilli par la commande, AVANT que la convergence ne
 * commence, et depose ici par ce pont. apply() le consomme puis l'efface de
 * la memoire : il ne doit jamais survivre au-dela d'un seul appel.
 */
let pendingPassword: string | null = null;

/** Appele par la commande install, avant de lancer la convergence locale. */
export function providePassword(value: string): void {
  pendingPassword = value;
}

export const smbCredentialsStep: Step<CredentialState> = {
  name: "smb-credentials",
  label: "Identifiants des partages au trousseau (Mac)",

  async inspect() {
    const present = (await getSecret("windows-account")) !== null;
    return {
      conforming: present,
      current: { present },
      detail: present
        ? "mot de passe déjà au trousseau"
        : "aucun mot de passe au trousseau",
    };
  },

  async apply() {
    if (pendingPassword === null) {
      throw new Error(
        "Mot de passe Windows manquant\u00a0: providePassword() doit être appelé " +
          "avant la convergence locale.",
      );
    }
    await setSecret("windows-account", pendingPassword);
    pendingPassword = null;
  },

  async restore(_config: Config, previous: CredentialState) {
    // Un mot de passe deja present avant hardline n'est jamais le notre a
    // effacer : seul celui que apply() a cree est retire.
    if (previous.present) return;
    await deleteSecret("windows-account");
  },
};
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

- [ ] **Étape 5 : Commiter**

```bash
git add src/steps/smb-credentials.ts test/steps/smb-credentials.test.ts
git commit -m "steps(smb-credentials): mot de passe Windows au trousseau, sans dialogue"
```

---

#### Cycle 8 — `smb-credentials` : `restore` ne touche jamais un secret préexistant

- [ ] **Étape 1 : Écrire le test qui échoue**

Ajouter à `test/steps/smb-credentials.test.ts` :

```ts
describe("restore", () => {
  const NO_PENDING = { pending: [] as string[] };

  test("retire le secret que l'etape a cree", async () => {
    storedSecret = "hunter2";
    await smbCredentialsStep.restore(CONFIG, { present: false }, NO_PENDING);
    expect(deleteSecret).toHaveBeenCalledWith("windows-account");
  });

  test("ne touche jamais a un secret qui preexistait", async () => {
    storedSecret = "mot-de-passe-utilisateur";
    await smbCredentialsStep.restore(CONFIG, { present: true }, NO_PENDING);
    expect(deleteSecret).not.toHaveBeenCalled();
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Passe déjà avec l'implémentation du cycle 7. Pour constater l'échec, inverser
temporairement la condition (`if (!previous.present) return;` au lieu de
`if (previous.present) return;`) : le test « ne touche jamais à un secret qui
préexistait » échoue alors, `deleteSecret` étant appelé à tort. Rétablir la
condition d'origine ensuite.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Déjà en place depuis le cycle 7. Rien à modifier.

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/steps/smb-credentials.test.ts`

- [ ] **Étape 5 : Commiter**

```bash
git add test/steps/smb-credentials.test.ts
git commit -m "test(smb-credentials): verrouille la preservation d'un secret preexistant"
```

---

### Tâche 11 : Étape `pairing`

**Fichiers :**
- Créer : `src/lib/moonlight-plist.ts`
- Créer : `src/steps/pairing.ts`
- Test : `test/lib/moonlight-plist.test.ts`
- Test : `test/steps/pairing.test.ts`

**Interfaces :**
- Consomme : `ApolloClient`, `ApolloCredentials`, `sendPin`, `listClients`,
  `unpairClient` (`src/lib/apollo-api.ts`) ; `spawnPair`
  (`src/lib/moonlight.ts`) ; `getSecret`, `generatePin`
  (`src/lib/keychain.ts`) ; `Config` (`src/config.ts`).
- Produit : `PairingState`, `pairingStep` (`src/steps/pairing.ts`) ;
  `MoonlightHost`, `parseHosts`, `containsHost`, `readHosts`, `forgetHost`
  (`src/lib/moonlight-plist.ts`, nouveau fichier hors du contrat
  `interfaces.md`, voir « Notes et réserves »). Ni l'un ni l'autre ne sont
  encore enregistrés dans le registre des étapes : la tâche 12 s'en charge.

---

#### Cycle 1 — `src/lib/moonlight-plist.ts` : lecture pure du plist

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/lib/moonlight-plist.test.ts
import { test, expect, describe } from "bun:test";
import { parseHosts, containsHost } from "../../src/lib/moonlight-plist";

const WITH_HOST = JSON.stringify({
  hosts: [{ address: "10.10.10.1", name: "PC" }],
});

const EMPTY = JSON.stringify({ hosts: [] });

describe("parseHosts", () => {
  test("lit les hotes connus", () => {
    expect(parseHosts(WITH_HOST)).toEqual([{ address: "10.10.10.1" }]);
  });

  test("rend un tableau vide sans cle hosts", () => {
    expect(parseHosts(JSON.stringify({}))).toEqual([]);
  });

  test("rend un tableau vide sur une sortie vide", () => {
    expect(parseHosts("")).toEqual([]);
  });

  test("rend un tableau vide sur un JSON illisible plutot que de lever", () => {
    expect(parseHosts("pas du json")).toEqual([]);
  });

  test("ignore une entree sans adresse exploitable", () => {
    const withGap = JSON.stringify({ hosts: [{ name: "sans adresse" }] });
    expect(parseHosts(withGap)).toEqual([]);
  });
});

describe("containsHost", () => {
  test("trouve un hote present", () => {
    expect(containsHost([{ address: "10.10.10.1" }], "10.10.10.1")).toBe(true);
  });

  test("rend faux pour un hote absent", () => {
    expect(containsHost(parseHosts(EMPTY), "10.10.10.1")).toBe(false);
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/lib/moonlight-plist.test.ts`
Attendu : ÉCHEC, « Cannot find module '../../src/lib/moonlight-plist' ».

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/lib/moonlight-plist.ts
import { $ } from "bun";

const DOMAIN = "com.moonlight-stream.Moonlight";

export type MoonlightHost = { address: string };

/**
 * Fonction pure. Lit le JSON rendu par `plutil -convert json -o -` applique a
 * un export du domaine de preferences de Moonlight. Toute forme inattendue —
 * domaine absent, JSON illisible, cle "hosts" manquante — rend un tableau
 * vide plutot que de lever : l'absence d'hote connu est un etat normal, pas
 * une erreur.
 */
export function parseHosts(json: string): MoonlightHost[] {
  const trimmed = json.trim();
  if (trimmed === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (typeof parsed !== "object" || parsed === null) return [];
  const hosts = (parsed as Record<string, unknown>)["hosts"];
  if (!Array.isArray(hosts)) return [];

  return hosts
    .filter((h): h is Record<string, unknown> => typeof h === "object" && h !== null)
    .map((h) => ({
      address: typeof h["address"] === "string" ? h["address"] : "",
    }))
    .filter((h) => h.address !== "");
}

/** Fonction pure. Vrai si l'hote figure deja parmi les entrees connues. */
export function containsHost(hosts: MoonlightHost[], host: string): boolean {
  return hosts.some((h) => h.address === host);
}

// --- Frontiere systeme. ---

/** Lit le plist de Moonlight. Tableau vide s'il n'existe pas ou est vide. */
export async function readHosts(): Promise<MoonlightHost[]> {
  const { stdout } = await $`defaults export ${DOMAIN} - | plutil -convert json -o - -`
    .quiet()
    .nothrow();
  return parseHosts(stdout.toString());
}

/** Retire l'entree d'hote du plist. Ne leve jamais pour une absence. */
export async function forgetHost(host: string): Promise<void> {
  const hosts = await readHosts();
  const index = hosts.findIndex((h) => h.address === host);
  if (index === -1) return;
  await $`defaults delete ${DOMAIN} hosts.${index}`.quiet().nothrow();
}
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

- [ ] **Étape 5 : Commiter**

```bash
git add src/lib/moonlight-plist.ts test/lib/moonlight-plist.test.ts
git commit -m "lib(moonlight-plist): lecture pure des hotes connus de Moonlight"
```

---

#### Cycle 2 — `pairing` : `inspect`

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/steps/pairing.test.ts
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";

const NO_PENDING = { pending: [] as string[] };
const order: string[] = [];

let apolloWebSecret: string | null = "web-secret";
let clientList: Array<{ name: string; uuid: string }> = [];
let clientListAfterPin: Array<{ name: string; uuid: string }> | null = null;
let sendPinResult = true;
let plistHosts: Array<{ address: string }> = [];

const spawnPair = mock((..._args: unknown[]) => {
  order.push("spawnPair");
  return { kill: () => {} };
});
const sendPin = mock(async (..._args: unknown[]) => {
  order.push("sendPin");
  return sendPinResult;
});
const listClients = mock(async (..._args: unknown[]) => {
  order.push("listClients");
  return clientListAfterPin ?? clientList;
});
const unpairClient = mock(async (..._args: unknown[]) => {});

mock.module("../../src/lib/apollo-api", () => ({ listClients, sendPin, unpairClient }));
mock.module("../../src/lib/moonlight", () => ({ spawnPair }));

const forgetHost = mock(async (..._args: unknown[]) => {});
mock.module("../../src/lib/moonlight-plist", () => ({
  readHosts: async () => plistHosts,
  containsHost: (hosts: Array<{ address: string }>, host: string) =>
    hosts.some((h) => h.address === host),
  forgetHost,
}));

mock.module("../../src/lib/keychain", () => ({
  getSecret: async () => apolloWebSecret,
  generatePin: () => "4821",
}));

const { pairingStep } = await import("../../src/steps/pairing");

beforeEach(() => {
  order.length = 0;
  apolloWebSecret = "web-secret";
  clientList = [];
  clientListAfterPin = null;
  sendPinResult = true;
  plistHosts = [];
  spawnPair.mockClear();
  sendPin.mockClear();
  listClients.mockClear();
  unpairClient.mockClear();
  forgetHost.mockClear();
});

describe("inspect", () => {
  test("declare conforme quand notre client figure deja dans la liste", async () => {
    clientList = [{ name: "hardline-mac", uuid: "u-1" }];
    const state = await pairingStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
    expect(state.current.clients).toEqual(["u-1"]);
  });

  test("declare non conforme quand notre client est absent", async () => {
    clientList = [{ name: "autre-appareil", uuid: "u-2" }];
    const state = await pairingStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
  });

  test("capture si le plist connaissait deja cet hote", async () => {
    plistHosts = [{ address: "10.10.10.1" }];
    const state = await pairingStep.inspect(CONFIG);
    expect(state.current.hostKnown).toBe(true);
  });

  test("rejette explicitement si Apollo n'a pas encore d'identifiants web", async () => {
    apolloWebSecret = null;
    await expect(pairingStep.inspect(CONFIG)).rejects.toThrow(
      /apollo-config doit s'appliquer/,
    );
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/pairing.test.ts`
Attendu : ÉCHEC, « Cannot find module '../../src/steps/pairing' ».

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/steps/pairing.ts
import {
  listClients,
  sendPin,
  unpairClient,
  type ApolloCredentials,
} from "../lib/apollo-api";
import { spawnPair } from "../lib/moonlight";
import { containsHost, forgetHost, readHosts } from "../lib/moonlight-plist";
import { generatePin, getSecret } from "../lib/keychain";
import type { Config } from "../config";
import type { Step } from "./types";

export type PairingState = {
  clients: readonly string[];
  hostKnown: boolean;
};

/**
 * Les identifiants web d'Apollo, ranges au trousseau par apollo-config qui
 * s'applique avant cette etape. Leur absence est une anomalie d'ordre, pas un
 * cas a deviner en silence.
 */
async function credentials(config: Config): Promise<ApolloCredentials> {
  const password = await getSecret("apollo-web");
  if (password === null) {
    throw new Error(
      "Aucun mot de passe Apollo au trousseau\u00a0: apollo-config doit s'appliquer " +
        "avant l'appairage.",
    );
  }
  return { user: config.apollo.webUser, password };
}

export const pairingStep: Step<PairingState> = {
  name: "pairing",
  label: "Mac appairé au serveur (Mac)",

  async inspect(config: Config) {
    const creds = await credentials(config);
    const clients = await listClients(config, creds);
    const hostKnown = containsHost(await readHosts(), config.ssh.host);

    const conforming = clients.some((c) => c.name === config.moonlight.clientName);

    return {
      conforming,
      current: { clients: clients.map((c) => c.uuid), hostKnown },
      detail: conforming
        ? `«\u00a0${config.moonlight.clientName}\u00a0» déjà appairé (${clients.length} client(s) au total)`
        : `«\u00a0${config.moonlight.clientName}\u00a0» absent des ${clients.length} client(s) appairés`,
    };
  },

  async apply(config: Config) {
    throw new Error("non implemente a ce cycle");
  },

  async restore(config: Config, previous: PairingState) {
    throw new Error("non implemente a ce cycle");
  },
};
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/steps/pairing.test.ts -t inspect`
(seul le groupe `inspect` doit passer à ce stade ; `apply`/`restore` seront
couverts par les cycles suivants).

- [ ] **Étape 5 : Commiter**

```bash
git add src/steps/pairing.ts test/steps/pairing.test.ts
git commit -m "steps(pairing): inspect, conformite et hostKnown"
```

---

#### Cycle 3 — `pairing` : `apply`, séquence nominale

- [ ] **Étape 1 : Écrire le test qui échoue**

Ajouter à `test/steps/pairing.test.ts` :

```ts
describe("apply, sequence nominale", () => {
  test("lance l'appairage sans attendre sa fin, puis poste le meme code", async () => {
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-3" }];
    await pairingStep.apply(CONFIG);

    expect(spawnPair).toHaveBeenCalledTimes(1);
    expect(sendPin).toHaveBeenCalledTimes(1);
    const pinPasseAMoonlight = (spawnPair.mock.calls[0] as unknown[])[1];
    const pinPosteAApollo = (sendPin.mock.calls[0] as unknown[])[2];
    expect(pinPasseAMoonlight).toBe(pinPosteAApollo);
    expect(pinPasseAMoonlight).toMatch(/^\d{4}$/);
  });

  test("respecte l'ordre impose par la spec : pair, puis pin, puis relecture", async () => {
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-3" }];
    await pairingStep.apply(CONFIG);
    expect(order).toEqual(["spawnPair", "sendPin", "listClients"]);
  });

  test("relit la liste une seule fois, apres l'envoi du code", async () => {
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-3" }];
    await pairingStep.apply(CONFIG);
    expect(listClients).toHaveBeenCalledTimes(1);
  });

  test("rejette explicitement si Apollo n'a pas encore d'identifiants web", async () => {
    apolloWebSecret = null;
    await expect(pairingStep.apply(CONFIG)).rejects.toThrow(
      /apollo-config doit s'appliquer/,
    );
    expect(spawnPair).not.toHaveBeenCalled();
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/pairing.test.ts -t "apply, sequence nominale"`
Attendu : ÉCHEC — `apply` lève « non implemente a ce cycle ».

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Remplacer le corps provisoire de `apply` dans `src/steps/pairing.ts` :

```ts
  /**
   * La sequence exacte imposee par la spec, sans humain :
   *   1. tirer un code a quatre chiffres ;
   *   2. lancer `moonlight pair` avec ce code, SANS attendre sa fin ;
   *   3. poster ce meme code sur /api/pin ;
   *   4. RELIRE /api/clients/list pour confirmer.
   *
   * L'etape 4 n'est pas une precaution de style : /api/pin est documente
   * comme repondant parfois "c'est fait" alors qu'aucune session d'appairage
   * n'attendait. sendPin() est appelee et son resultat delibocrement IGNORE
   * pour decider du succes ; seule la relecture de listClients fait foi.
   */
  async apply(config: Config) {
    const creds = await credentials(config);
    const pin = generatePin();

    spawnPair(config, pin);
    await sendPin(config, creds, pin, config.moonlight.clientName);

    const confirmed = await listClients(config, creds);
    if (!confirmed.some((c) => c.name === config.moonlight.clientName)) {
      throw new Error(
        `Appairage non confirmé\u00a0: «\u00a0${config.moonlight.clientName}\u00a0» n'apparaît pas ` +
          "dans la liste des clients relue après l'envoi du code.",
      );
    }
  },
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

- [ ] **Étape 5 : Commiter**

```bash
git add src/steps/pairing.ts test/steps/pairing.test.ts
git commit -m "steps(pairing): apply suit la sequence pair, pin, relecture"
```

---

#### Cycle 4 — `pairing` : la relecture fait foi, jamais la réponse de `sendPin`

C'est le test que la tâche exige explicitement : si `sendPin` rend `true` mais
que la liste relue reste vide, l'étape doit échouer.

- [ ] **Étape 1 : Écrire le test qui échoue**

Ajouter à `test/steps/pairing.test.ts` :

```ts
describe("apply, la relecture fait foi et non la reponse de sendPin", () => {
  test("echoue si sendPin rend true mais que la liste relue reste vide", async () => {
    // Le coeur de la garantie : /api/pin est documente comme repondant
    // parfois "c'est fait" sans qu'aucune session d'appairage n'ait ete en
    // attente. Un apply() qui croirait sendPin sur parole passerait ce test
    // a tort.
    sendPinResult = true;
    clientListAfterPin = [];
    await expect(pairingStep.apply(CONFIG)).rejects.toThrow(/Appairage non confirmé/);
  });

  test("reussit si la relecture confirme, meme quand sendPin ment par defaut", async () => {
    // Contre-epreuve : la reussite ne depend que de la relecture, jamais de
    // la reponse de sendPin.
    sendPinResult = false;
    clientListAfterPin = [{ name: "hardline-mac", uuid: "u-9" }];
    await expect(pairingStep.apply(CONFIG)).resolves.toBeUndefined();
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Pour constater l'échec sur une implémentation fautive, remplacer
temporairement dans `apply()` la condition de succès par
`if (!sendPinResultLocal) throw ...` fondée sur le résultat de `sendPin`
plutôt que sur `listClients` (par exemple : `const posted = await
sendPin(...); if (!posted) throw ...;` sans relecture). Avec cette variante
fautive, le premier test du cycle (« échoue si sendPin rend true... ») passe à
tort en réussite silencieuse. Rétablir ensuite l'implémentation du cycle 3.

Commande : `bun test --isolate test/steps/pairing.test.ts -t "la relecture fait foi"`
Attendu, sur l'implémentation correcte du cycle 3 déjà en place : les deux
tests passent déjà ; ce cycle sert à les ajouter comme verrou permanent.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Aucune modification de production : le comportement est déjà correct depuis
le cycle 3. Ce cycle documente et verrouille l'exigence par le test ci-dessus.

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/steps/pairing.test.ts`

- [ ] **Étape 5 : Commiter**

```bash
git add test/steps/pairing.test.ts
git commit -m "test(pairing): verrouille que la confirmation vient de la relecture"
```

---

#### Cycle 5 — `pairing` : `restore`

- [ ] **Étape 1 : Écrire le test qui échoue**

Ajouter à `test/steps/pairing.test.ts` :

```ts
describe("restore", () => {
  test("depaire le client dont le nom correspond au notre", async () => {
    clientList = [{ name: "hardline-mac", uuid: "u-5" }];
    await pairingStep.restore(CONFIG, { clients: [], hostKnown: false }, NO_PENDING);
    expect(unpairClient).toHaveBeenCalledWith(
      CONFIG,
      { user: "hardline", password: "web-secret" },
      "u-5",
    );
  });

  test("retire l'entree du plist quand elle n'existait pas avant hardline", async () => {
    await pairingStep.restore(CONFIG, { clients: [], hostKnown: false }, NO_PENDING);
    expect(forgetHost).toHaveBeenCalledWith("10.10.10.1");
  });

  test("ne touche pas au plist si l'hote y figurait deja avant hardline", async () => {
    await pairingStep.restore(CONFIG, { clients: [], hostKnown: true }, NO_PENDING);
    expect(forgetHost).not.toHaveBeenCalled();
  });

  test("ne depaire rien si notre client n'apparait plus dans la liste", async () => {
    clientList = [];
    await pairingStep.restore(CONFIG, { clients: [], hostKnown: false }, NO_PENDING);
    expect(unpairClient).not.toHaveBeenCalled();
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/pairing.test.ts -t restore`
Attendu : ÉCHEC — `restore` lève « non implemente a ce cycle ».

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Remplacer le corps provisoire de `restore` dans `src/steps/pairing.ts` :

```ts
  /**
   * Se defait EN PREMIER parmi les etapes distantes, puisqu'elle vient en
   * dernier dans REMOTE_STEPS : on depaire tant que le serveur repond encore.
   */
  async restore(config: Config, previous: PairingState) {
    const creds = await credentials(config);
    const clients = await listClients(config, creds);
    const ours = clients.find((c) => c.name === config.moonlight.clientName);
    if (ours) {
      await unpairClient(config, creds, ours.uuid);
    }

    // Un hote deja connu du plist avant hardline n'est jamais le notre a
    // effacer.
    if (!previous.hostKnown) {
      await forgetHost(config.ssh.host);
    }
  },
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/steps/pairing.test.ts`

- [ ] **Étape 5 : Commiter**

```bash
git add src/steps/pairing.ts test/steps/pairing.test.ts
git commit -m "steps(pairing): restore depaire cote PC et oublie l'hote cote Mac"
```

---

### Tâche 12 : Commande `up`, câblage, et fermeture du plan

**Fichiers :**
- Créer : `src/commands/up.ts`
- Modifier : `src/config.ts`
- Modifier : `test/lib/throughput.test.ts:34` — **dans le même commit que `config.ts`**
- Modifier : `src/steps/index.ts`
- Modifier : `src/cli.ts`
- Modifier : `src/commands/install.ts`
- Test : `test/commands/up.test.ts`
- Test : `test/steps/index.test.ts` (réécrit)
- Test : `test/commands/install.test.ts` (étendu)

**Interfaces :**
- Consomme : tout ce que les tâches 1 à 11 produisent — `listDisplays`,
  `mainDisplay`, `Display` (`src/lib/display.ts`) ; `lookupMac`,
  `sendMagicPacket` (`src/lib/wol.ts`) ; `waitForRemote`
  (`src/lib/preflight.ts`) ; `getSecret` (`src/lib/keychain.ts`) ;
  `mountShare`, `unmountShare` (`src/lib/smb.ts`) ; `runStream`, `runQuit`,
  `StreamOptions` (`src/lib/moonlight.ts`) ; `runRemoteJson`,
  `runRemoteChecked` (`src/lib/ssh.ts`) ; `askConfirmation`, `askSecret`
  (`src/lib/ui.ts`) ; les sept étapes des tâches 10 et 11 ainsi que
  `apolloInstallStep`, `apolloConfigStep`, `apolloServiceStep`,
  `windowsNetworkStep`, `windowsProfileTaskStep`, `macNetworkStep`,
  `bootstrapWindowsStep` déjà enregistrées. Consomme également
  `ForeignApolloError`, `backupApolloConfig` et `uninstallApollo` exportés par
  `src/steps/apollo-install.ts` (tâche 7, hors du contrat `interfaces.md` —
  voir « Notes et réserves »).
- Produit : `runUp`, `upCommand`, `parseResolution`, `parseFps`,
  `buildStreamOptions`, `broadcastAddress` (`src/commands/up.ts`) ; le
  registre final `LOCAL_STEPS` / `CAPTURE_STEPS` / `REMOTE_STEPS` /
  `ALL_STEPS` / `WINDOWS_STEPS` tel que fixé par `interfaces.md`.

---

#### Cycle 1 — `config.ts` et `steps/index.ts` : câblage du registre

- [ ] **Étape 1 : Écrire le test qui échoue**

Remplacer entièrement `test/steps/index.test.ts` :

```ts
import { test, expect, describe } from "bun:test";
import {
  ALL_STEPS,
  CAPTURE_STEPS,
  LOCAL_STEPS,
  REMOTE_STEPS,
  WINDOWS_STEPS,
} from "../../src/steps";

const names = (steps: { name: string }[]) => steps.map((s) => s.name);

describe("decoupage des etapes", () => {
  test("la phase locale reunit tout ce qui ne depend d'aucune precondition distante", () => {
    expect(names(LOCAL_STEPS)).toEqual([
      "network-mac",
      "moonlight-install",
      "smb-credentials",
    ]);
  });

  test("le rapatriement du releve est une phase a lui seul", () => {
    expect(names(CAPTURE_STEPS)).toEqual(["bootstrap-windows"]);
  });

  test("la phase distante porte Apollo, les partages, et l'appairage en dernier", () => {
    expect(names(REMOTE_STEPS)).toEqual([
      "network-windows",
      "network-profile-task",
      "apollo-install",
      "apollo-config",
      "apollo-service",
      "smb-shares",
      "pairing",
    ]);
  });

  test("WINDOWS_STEPS reunit tout ce qui touche au PC", () => {
    expect(names(WINDOWS_STEPS)).toEqual([
      "bootstrap-windows",
      "network-windows",
      "network-profile-task",
      "apollo-install",
      "apollo-config",
      "apollo-service",
      "smb-shares",
      "pairing",
    ]);
  });

  test("ALL_STEPS reste local puis distant, dans cet ordre exact", () => {
    expect(names(ALL_STEPS)).toEqual([
      ...names(LOCAL_STEPS),
      ...names(CAPTURE_STEPS),
      ...names(REMOTE_STEPS),
    ]);
  });

  test("pairing vient apres apollo-service : l'appairage exige qu'Apollo tourne", () => {
    const order = names(ALL_STEPS);
    expect(order.indexOf("apollo-service")).toBeLessThan(order.indexOf("pairing"));
  });

  test("pairing est la toute derniere etape : elle se defait la toute premiere a la restauration", () => {
    expect(names(ALL_STEPS).at(-1)).toBe("pairing");
  });

  test("moonlight-install et smb-credentials tournent avant meme l'amorcage du PC", () => {
    const order = names(ALL_STEPS);
    expect(order.indexOf("moonlight-install")).toBeLessThan(
      order.indexOf("bootstrap-windows"),
    );
    expect(order.indexOf("smb-credentials")).toBeLessThan(
      order.indexOf("bootstrap-windows"),
    );
  });

  test("l'amorcage precede l'adressage, donc il est restaure apres lui", () => {
    const order = names(ALL_STEPS);
    expect(order.indexOf("bootstrap-windows")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("bootstrap-windows")).toBeLessThan(
      order.indexOf("network-windows"),
    );
    expect(order.indexOf("network-mac")).toBeLessThan(order.indexOf("bootstrap-windows"));
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/steps/index.test.ts`
Attendu : ÉCHEC — `LOCAL_STEPS` ne contient encore que `network-mac`,
`REMOTE_STEPS` que les deux étapes réseau.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

**Piège vérifié, à traiter dans ce cycle et pas plus tard.**
`test/lib/throughput.test.ts:34` construit son propre littéral
`const CONFIG: Config = { ... }`. Rendre `apollo`, `moonlight` et `smb`
obligatoires dans `Config` casse ce fichier — mais **`bun test` n'en dira rien** :
les types sont effacés à l'exécution et la suite reste verte. Seul
`bunx tsc --noEmit` le voit. Étendre cette fixture avec les trois nouveaux blocs
appartient donc à ce cycle, au même commit que la modification du type. C'est le
seul littéral `Config` de toute la suite de tests, vérification faite.

Ajouter à `src/config.ts` (après le type `Config` existant et avant
`CONFIG`), exactement le bloc que `interfaces.md` fixe :

```ts
export type Config = {
  mac: { serviceName: string; ip: string; subnetMask: string };
  windows: { interfaceAlias: string; ip: string; prefixLength: number };
  ssh: SSHTarget;
  bootstrapPort: number;
  apollo: ApolloConfig;
  moonlight: MoonlightConfig;
  smb: SMBConfig;
};

export type ApolloConfig = {
  version: string;
  installerUrl: string;
  installerSha256: string;
  installDir: string;
  serviceName: string;
  apiPort: number;
  webUser: string;
};

export type MoonlightConfig = {
  cask: string;
  binary: string;
  clientName: string;
  app: string;
};

export type SMBConfig = {
  user: string;
  shares: readonly SMBShare[];
};

export type SMBShare = {
  name: string;
  path: string | null;
  mountPoint: string;
};
```

Et dans `CONFIG`, après le champ `bootstrapPort` existant :

```ts
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
    binary: "/opt/homebrew/bin/moonlight",
    clientName: "hardline-mac",
    app: "Desktop",
  },
  smb: {
    user: "arthur",
    shares: [
      { name: "arthur", path: null, mountPoint: "/Volumes/pc-arthur" },
      { name: "hardline-d", path: "D:\\", mountPoint: "/Volumes/pc-d" },
      { name: "hardline-e", path: "E:\\", mountPoint: "/Volumes/pc-e" },
    ],
  },
```

Réécrire `src/steps/index.ts` :

```ts
import { bootstrapWindowsStep } from "./bootstrap-windows";
import { macNetworkStep } from "./network-mac";
import { windowsNetworkStep } from "./network-windows";
import { windowsProfileTaskStep } from "./network-profile-task";
import { apolloInstallStep } from "./apollo-install";
import { apolloConfigStep } from "./apollo-config";
import { apolloServiceStep } from "./apollo-service";
import { smbSharesStep } from "./smb-shares";
import { moonlightInstallStep } from "./moonlight-install";
import { pairingStep } from "./pairing";
import { smbCredentialsStep } from "./smb-credentials";
import type { Step } from "./types";

/**
 * Etapes cote Mac qui ne dependent d'aucune precondition distante : elles
 * tournent avant meme que le PC ne soit joignable en SSH.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const LOCAL_STEPS: Step<any>[] = [
  macNetworkStep,
  moonlightInstallStep,
  smbCredentialsStep,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CAPTURE_STEPS: Step<any>[] = [bootstrapWindowsStep];

/**
 * Convergence cote PC, une fois toutes les preconditions passees. pairing est
 * en DERNIER bien qu'elle agisse aussi cote Mac : elle exige qu'Apollo
 * tourne, donc elle ne peut pas passer avant apolloServiceStep. A la
 * restauration, qui se fait en ordre inverse, elle se defait donc EN PREMIER
 * — ce qui est egalement correct : on depaire tant que le serveur repond.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const REMOTE_STEPS: Step<any>[] = [
  windowsNetworkStep,
  windowsProfileTaskStep,
  apolloInstallStep,
  apolloConfigStep,
  apolloServiceStep,
  smbSharesStep,
  pairingStep,
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_STEPS: Step<any>[] = [
  ...LOCAL_STEPS,
  ...CAPTURE_STEPS,
  ...REMOTE_STEPS,
];

/** Tout ce qui touche au PC, quelle que soit la phase qui l'applique. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const WINDOWS_STEPS: Step<any>[] = [...CAPTURE_STEPS, ...REMOTE_STEPS];
```

`doctor.ts` itère déjà `ALL_STEPS` (`src/commands/doctor.ts`, boucle
`for (const step of ALL_STEPS)`) : aucune ligne n'y est nécessaire, les sept
nouvelles étapes y apparaissent d'elles-mêmes dès que le registre est mis à
jour. Vérifié par les assertions d'ordre ci-dessus, qui échoueraient si une
étape manquait à `ALL_STEPS`.

Cette réécriture du registre change les groupes appliqués par
`hardline install`, ce qui casse mécaniquement plusieurs assertions de
`test/commands/install.test.ts` fondées sur les anciens noms joints. Les
corriger dans ce même cycle, avant de commiter — sans quoi la suite complète
ne passe plus :

```ts
// Remplacer les trois constantes existantes (juste avant beforeEach) :
const LOCAL_GROUP = ["network-mac", "moonlight-install", "smb-credentials"];
const CAPTURE_GROUP = ["bootstrap-windows"];
const REMOTE_GROUP = [
  "network-windows",
  "network-profile-task",
  "apollo-install",
  "apollo-config",
  "apollo-service",
  "smb-shares",
  "pairing",
];
```

Puis, dans le même fichier, deux remplacements globaux (chaque littéral
apparaît plusieurs fois, dans plusieurs tests — remplacer TOUTES les
occurrences) :

- remplacer partout la chaîne exacte `"apply:network-mac"` par
  `"apply:network-mac+moonlight-install+smb-credentials"` ;
- remplacer partout la chaîne exacte
  `"apply:network-windows+network-profile-task"` par
  `"apply:network-windows+network-profile-task+apollo-install+apollo-config+apollo-service+smb-shares+pairing"`.

Et deux affectations ponctuelles :

```ts
// "un echec de la convergence du Mac n'envoie pas sonder le PC"
applyThrowsOn = "network-mac+moonlight-install+smb-credentials";
```

```ts
// "un echec de la convergence du PC dit comment reprendre"
applyThrowsOn =
  "network-windows+network-profile-task+apollo-install+apollo-config+apollo-service+smb-shares+pairing";
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/steps/index.test.ts test/commands/install.test.ts`

- [ ] **Étape 5 : Commiter**

```bash
git add src/config.ts src/steps/index.ts test/steps/index.test.ts \
        test/commands/install.test.ts test/lib/throughput.test.ts
git commit -m "config,steps(index): enregistre les sept etapes du plan 2"
```

---

#### Cycle 2 — `cli.ts` et `up.ts` : options et fonctions pures

- [ ] **Étape 1 : Écrire le test qui échoue**

```ts
// test/commands/up.test.ts (nouveau fichier, debut)
import { test, expect, describe } from "bun:test";
import {
  parseResolution,
  parseFps,
  buildStreamOptions,
  broadcastAddress,
} from "../../src/commands/up";

describe("parseResolution", () => {
  test("lit une resolution valide", () => {
    expect(parseResolution("3456x2234")).toEqual({ width: 3456, height: 2234 });
  });

  test("accepte un X majuscule", () => {
    expect(parseResolution("1920X1080")).toEqual({ width: 1920, height: 1080 });
  });

  test("rejette un format invalide", () => {
    expect(() => parseResolution("3456-2234")).toThrow(/Résolution invalide/);
  });

  test("rejette une chaine vide", () => {
    expect(() => parseResolution("")).toThrow(/Résolution invalide/);
  });
});

describe("parseFps", () => {
  test("lit un entier positif", () => {
    expect(parseFps("120")).toBe(120);
  });

  test("rejette zero", () => {
    expect(() => parseFps("0")).toThrow(/Fréquence invalide/);
  });

  test("rejette une valeur non entiere", () => {
    expect(() => parseFps("59.94")).toThrow(/Fréquence invalide/);
  });

  test("rejette une valeur non numerique", () => {
    expect(() => parseFps("soixante")).toThrow(/Fréquence invalide/);
  });
});

describe("buildStreamOptions", () => {
  test("rend des options par defaut sans aucun drapeau", () => {
    expect(
      buildStreamOptions({ fullscreen: false, resolution: null, fps: null }),
    ).toEqual({ fullscreen: false, resolution: null, fps: null });
  });

  test("compose la resolution et la frequence imposees", () => {
    expect(
      buildStreamOptions({ fullscreen: true, resolution: "2560x1440", fps: "144" }),
    ).toEqual({
      fullscreen: true,
      resolution: { width: 2560, height: 1440 },
      fps: 144,
    });
  });
});

describe("broadcastAddress", () => {
  test("calcule la diffusion d'un reseau en /24", () => {
    expect(broadcastAddress("10.10.10.2", "255.255.255.0")).toBe("10.10.10.255");
  });

  test("calcule la diffusion d'un reseau en /16", () => {
    expect(broadcastAddress("192.168.0.5", "255.255.0.0")).toBe("192.168.255.255");
  });

  test("rejette une adresse malformee", () => {
    expect(() => broadcastAddress("10.10.10", "255.255.255.0")).toThrow(/invalide/);
  });
});
```

```ts
// Ajout a test/cli.test.ts existant
test("la commande up expose --fullscreen, --resolution et --fps", () => {
  const up = buildProgram().commands.find((c) => c.name() === "up");
  const optionNames = up?.options.map((o) => o.long) ?? [];
  expect(optionNames).toEqual(
    expect.arrayContaining(["--fullscreen", "--resolution", "--fps"]),
  );
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/commands/up.test.ts test/cli.test.ts`
Attendu : ÉCHEC — `src/commands/up.ts` n'existe pas encore, et la commande
`up` ne porte encore aucune option.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

```ts
// src/commands/up.ts (debut du fichier — la suite arrive aux cycles 3 a 6)
import { CONFIG, type Config } from "../config";
import { runRemoteChecked, runRemoteJson } from "../lib/ssh";
import { lookupMac, sendMagicPacket } from "../lib/wol";
import { waitForRemote } from "../lib/preflight";
import { listDisplays, mainDisplay } from "../lib/display";
import { getSecret } from "../lib/keychain";
import { mountShare, unmountShare } from "../lib/smb";
import { runStream, runQuit, type StreamOptions } from "../lib/moonlight";
import { errorMessage } from "../lib/errors";
import { configureOutput, ui, withSpinner } from "../lib/ui";

const WAKE_DEADLINE_MS = 3 * 60_000;

export type ResolutionOption = { width: number; height: number };

/** Fonction pure. "LARGEURxHAUTEUR" -> les deux entiers, ou leve. */
export function parseResolution(value: string): ResolutionOption {
  const match = /^(\d+)x(\d+)$/i.exec(value.trim());
  if (!match) {
    throw new Error(
      `Résolution invalide\u00a0: attendu «\u00a0LARGEURxHAUTEUR\u00a0» (${value})`,
    );
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Fonction pure. Une chaine de frequence en entier positif, ou leve. */
export function parseFps(value: string): number {
  const fps = Number(value);
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new Error(`Fréquence invalide\u00a0: attendu un entier positif (${value})`);
  }
  return fps;
}

export type UpCliOptions = {
  fullscreen: boolean;
  resolution: string | null;
  fps: string | null;
};

/** Fonction pure. Les drapeaux de la ligne de commande, vers les options de flux. */
export function buildStreamOptions(cli: UpCliOptions): StreamOptions {
  return {
    fullscreen: cli.fullscreen,
    resolution: cli.resolution ? parseResolution(cli.resolution) : null,
    fps: cli.fps ? parseFps(cli.fps) : null,
  };
}

/**
 * Fonction pure. L'adresse de diffusion IPv4 d'un reseau, a partir d'une
 * adresse et d'un masque. Sert a poser le paquet magique sur le bon domaine
 * de diffusion : celui du Mac sur le lien direct, pas celui d'un routeur.
 */
export function broadcastAddress(ip: string, subnetMask: string): string {
  const ipParts = ip.split(".").map(Number);
  const maskParts = subnetMask.split(".").map(Number);
  const valid =
    ipParts.length === 4 &&
    maskParts.length === 4 &&
    ipParts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    maskParts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  if (!valid) {
    throw new Error(
      `Adresse ou masque IPv4 invalide pour le calcul de diffusion\u00a0: ${ip}/${subnetMask}`,
    );
  }
  return ipParts.map((octet, i) => (octet | (~maskParts[i]! & 0xff)) & 0xff).join(".");
}
```

Modifier `src/cli.ts` : retirer l'entrée `up` câblée sur `NOT_IMPLEMENTED` et
la remplacer, importer `upCommand` :

```ts
import { upCommand } from "./commands/up";
```

```ts
  program
    .command("up")
    .description("Ouvre la session de travail sur le PC")
    .option("--fullscreen", "plein écran plutôt que fenêtré", false)
    .option("--resolution <WxH>", "impose une définition, ex. 1920x1080")
    .option("--fps <n>", "impose une fréquence en images par seconde")
    .action(upCommand);
```

(`upCommand` est écrite au cycle 6 ; ce cycle-ci peut temporairement exporter
une fonction `upCommand` minimale qui lève, pour que `cli.ts` compile — voir
note à l'étape 3bis ci-dessous.)

- [ ] **Étape 3bis : maintenir la compilation entre les cycles**

Ajouter provisoirement à la fin de `src/commands/up.ts`, retiré au cycle 6 :

```ts
export async function upCommand(_cliOptions: UpCliOptions): Promise<void> {
  throw new Error("non implemente a ce cycle");
}
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/commands/up.test.ts test/cli.test.ts && bunx tsc --noEmit`

- [ ] **Étape 5 : Commiter**

```bash
git add src/commands/up.ts src/cli.ts test/commands/up.test.ts test/cli.test.ts
git commit -m "cli,commands(up): options de la commande up et fonctions pures"
```

---

#### Cycle 3 — `runUp` : séquence nominale (PC déjà joignable)

- [ ] **Étape 1 : Écrire le test qui échoue**

Ajouter à `test/commands/up.test.ts`, après les tests de fonctions pures, le
socle de simulation partagé par les cycles 3 à 6 :

```ts
import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { CONFIG } from "../../src/config";
import type { StreamOptions } from "../../src/lib/moonlight";

const order: string[] = [];

let reachable = true;
let arpMac: string | null = "e8:9c:25:2a:70:e1";
let wakeSucceeds = true;
let displays: Array<{
  widthPx: number;
  heightPx: number;
  refreshHz: number;
  widthPt: number;
  heightPt: number;
  main: boolean;
}> = [];
let apolloStatusRounds: Array<string | null> = ["Running"];
let apolloStatusCalls = 0;
let windowsPassword: string | null = "hunter2";
let mountThrowsOn: string | null = null;
let streamThrows: Error | null = null;
let streamExitCode = 0;

const runRemoteJson = mock(async (_target: unknown, script: string) => {
  order.push("runRemoteJson");
  if (script.includes("ok = $true")) {
    if (!reachable) throw new Error("PC injoignable");
    return [{ ok: true }];
  }
  const status =
    apolloStatusRounds[Math.min(apolloStatusCalls, apolloStatusRounds.length - 1)];
  apolloStatusCalls += 1;
  return [{ status }];
});
const runRemoteChecked = mock(async (..._args: unknown[]) => {
  order.push("runRemoteChecked");
  return { exitCode: 0, stdout: "", stderr: "" };
});
mock.module("../../src/lib/ssh", () => ({ runRemoteJson, runRemoteChecked }));

const lookupMac = mock(async (..._args: unknown[]) => arpMac);
const sendMagicPacket = mock(async (..._args: unknown[]) => {
  order.push("sendMagicPacket");
});
mock.module("../../src/lib/wol", () => ({ lookupMac, sendMagicPacket }));

const waitForRemote = mock(async (..._args: unknown[]) => {
  order.push("waitForRemote");
  return wakeSucceeds;
});
mock.module("../../src/lib/preflight", () => ({ waitForRemote }));

const listDisplays = mock(async () => displays);
mock.module("../../src/lib/display", () => ({
  listDisplays,
  mainDisplay: (ds: typeof displays) => ds.find((d) => d.main) ?? ds[0] ?? null,
}));

const getSecret = mock(async (..._args: unknown[]) => windowsPassword);
mock.module("../../src/lib/keychain", () => ({ getSecret }));

const mountShare = mock(async (share: { name: string }, ..._rest: unknown[]) => {
  order.push(`mount:${share.name}`);
  if (mountThrowsOn === share.name) {
    throw new Error(`montage refusé pour ${share.name}`);
  }
});
const unmountShare = mock(async (share: { name: string }) => {
  order.push(`unmount:${share.name}`);
});
mock.module("../../src/lib/smb", () => ({ mountShare, unmountShare }));

const runStream = mock(async (..._args: unknown[]) => {
  order.push("runStream");
  if (streamThrows) throw streamThrows;
  return streamExitCode;
});
const runQuit = mock(async (..._args: unknown[]) => {
  order.push("runQuit");
});
mock.module("../../src/lib/moonlight", () => ({ runStream, runQuit }));

const finishes: string[] = [];
const failures: string[] = [];
mock.module("../../src/lib/ui", () => ({
  configureOutput: () => {},
  withSpinner: async <T>(
    _label: string,
    run: (progress: (m: string) => void) => Promise<T>,
  ) => run(() => {}),
  ui: {
    start: () => {},
    finish: (message: string) => finishes.push(message),
    skipped: () => {},
    applied: () => {},
    restored: () => {},
    yielded: () => {},
    detached: () => {},
    failed: ({ label, detail }: { label: string; detail: string }) =>
      failures.push(`${label} — ${detail}`),
    info: () => {},
    warn: () => {},
    report: () => {},
  },
}));

const { runUp, upCommand } = await import("../../src/commands/up");

const NO_OPTIONS: StreamOptions = { fullscreen: false, resolution: null, fps: null };

beforeEach(() => {
  order.length = 0;
  reachable = true;
  arpMac = "e8:9c:25:2a:70:e1";
  wakeSucceeds = true;
  displays = [
    { widthPx: 3456, heightPx: 2234, refreshHz: 120, widthPt: 1728, heightPt: 1117, main: true },
  ];
  apolloStatusRounds = ["Running"];
  apolloStatusCalls = 0;
  windowsPassword = "hunter2";
  mountThrowsOn = null;
  streamThrows = null;
  streamExitCode = 0;
  finishes.length = 0;
  failures.length = 0;

  runRemoteJson.mockClear();
  runRemoteChecked.mockClear();
  lookupMac.mockClear();
  sendMagicPacket.mockClear();
  waitForRemote.mockClear();
  listDisplays.mockClear();
  getSecret.mockClear();
  mountShare.mockClear();
  unmountShare.mockClear();
  runStream.mockClear();
  runQuit.mockClear();
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe("runUp, PC deja joignable", () => {
  test("ne reveille pas le PC quand il repond deja", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    expect(sendMagicPacket).not.toHaveBeenCalled();
    expect(waitForRemote).not.toHaveBeenCalled();
  });

  test("monte les trois partages, dans l'ordre de la configuration, puis lance le flux", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    expect(mountShare).toHaveBeenCalledTimes(3);
    const names = mountShare.mock.calls.map((c) => (c[0] as { name: string }).name);
    expect(names).toEqual(["arthur", "hardline-d", "hardline-e"]);
    expect(runStream).toHaveBeenCalledTimes(1);
  });

  test("demonte les trois partages et clot la session a la fin d'une session reussie", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    expect(unmountShare).toHaveBeenCalledTimes(3);
    expect(runQuit).toHaveBeenCalledTimes(1);
  });

  test("le demontage et la fermeture surviennent APRES le flux", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    const streamIndex = order.indexOf("runStream");
    const firstUnmount = order.findIndex((e) => e.startsWith("unmount:"));
    expect(streamIndex).toBeGreaterThanOrEqual(0);
    expect(firstUnmount).toBeGreaterThan(streamIndex);
    expect(order.indexOf("runQuit")).toBeGreaterThan(firstUnmount);
  });

  test("rend le code de sortie du flux", async () => {
    streamExitCode = 7;
    expect(await runUp(CONFIG, NO_OPTIONS)).toBe(7);
  });

  test("rejette explicitement si aucun mot de passe Windows n'est au trousseau", async () => {
    windowsPassword = null;
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow(/hardline install/);
    expect(mountShare).not.toHaveBeenCalled();
  });

  test("demarre le service Apollo s'il n'est pas deja en cours", async () => {
    apolloStatusRounds = ["Stopped", "Running"];
    await runUp(CONFIG, NO_OPTIONS);
    expect(runRemoteChecked).toHaveBeenCalledTimes(1);
    expect(String((runRemoteChecked.mock.calls[0] as unknown[])[1])).toContain(
      "Start-Service",
    );
  });

  test("ne redemarre rien si Apollo tourne deja", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    expect(runRemoteChecked).not.toHaveBeenCalled();
  });

  test("echoue si Apollo refuse de demarrer", async () => {
    apolloStatusRounds = ["Stopped", "Stopped"];
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow(/n'a pas démarré/);
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/commands/up.test.ts`
Attendu : ÉCHEC — `runUp` n'existe pas encore.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Ajouter à `src/commands/up.ts`, en conservant tout ce qui précède (cycle 2) :

```ts
async function pcReachable(config: Config): Promise<boolean> {
  try {
    await runRemoteJson(config.ssh, "[pscustomobject]@{ ok = $true }");
    return true;
  } catch {
    return false;
  }
}

const APOLLO_STATUS = (name: string) => `
$svc = Get-Service -Name '${name}' -ErrorAction SilentlyContinue
[pscustomobject]@{ status = if ($svc) { [string]$svc.Status } else { $null } }`;

async function ensureApolloRunning(config: Config): Promise<void> {
  const rows = await runRemoteJson<{ status: string | null }>(
    config.ssh,
    APOLLO_STATUS(config.apollo.serviceName),
  );
  if (rows[0]?.status === "Running") return;

  await runRemoteChecked(config.ssh, `Start-Service -Name '${config.apollo.serviceName}'`);

  const recheck = await runRemoteJson<{ status: string | null }>(
    config.ssh,
    APOLLO_STATUS(config.apollo.serviceName),
  );
  if (recheck[0]?.status !== "Running") {
    throw new Error(
      `Le service «\u00a0${config.apollo.serviceName}\u00a0» n'a pas démarré ` +
        `(état\u00a0: ${recheck[0]?.status ?? "inconnu"}).`,
    );
  }
}

/**
 * L'enchainement complet d'une session. Le demontage et l'appel a `moonlight
 * quit` sont dans un `finally` qui englobe le montage ET le flux : une
 * interruption a n'importe quel point apres le premier montage doit encore
 * defaire ce qui a ete monte et fermer la session cote serveur, sans quoi
 * l'ecran virtuel reste sur le PC. unmountShare ne leve jamais pour un
 * partage jamais monte (voir src/lib/smb.ts), ce qui rend sur d'appeler ce
 * nettoyage sur TOUS les partages, meme ceux qu'un montage partiel n'a
 * jamais atteints.
 */
export async function runUp(config: Config, options: StreamOptions): Promise<number> {
  if (!(await pcReachable(config))) {
    await wakePC(config);
  }

  const display = mainDisplay(await listDisplays());
  await ensureApolloRunning(config);

  const password = await getSecret("windows-account");
  if (password === null) {
    throw new Error(
      "Aucun mot de passe Windows au trousseau\u00a0: lancer «\u00a0hardline install\u00a0» d'abord.",
    );
  }

  try {
    for (const share of config.smb.shares) {
      await mountShare(share, config, password);
    }
    return await runStream(config, display, options);
  } finally {
    for (const share of config.smb.shares) {
      try {
        await unmountShare(share);
      } catch {
        // Demontage en best effort a la fermeture : un partage qui refuse de
        // se demonter ne doit ni empecher les autres ni empecher la fermeture
        // cote serveur.
      }
    }
    try {
      await runQuit(config);
    } catch {
      // La session doit se fermer cote client quoi qu'il arrive : une erreur
      // ici ne doit pas masquer celle, plus importante, du flux lui-meme.
    }
  }
}
```

`wakePC` est appelée mais pas encore définie : l'ajouter en avant-première
minimale pour que ce cycle compile isolément (le cycle 4 la complète) :

```ts
async function wakePC(_config: Config): Promise<void> {
  throw new Error("non implemente a ce cycle");
}
```

(Les tests de ce cycle-ci ne l'atteignent jamais, puisque `reachable` vaut
`true` par défaut.)

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/commands/up.test.ts -t "PC deja joignable"`

- [ ] **Étape 5 : Commiter**

```bash
git add src/commands/up.ts test/commands/up.test.ts
git commit -m "commands(up): runUp, sequence nominale PC deja joignable"
```

---

#### Cycle 4 — `runUp` : réveil par paquet magique

- [ ] **Étape 1 : Écrire le test qui échoue**

Ajouter à `test/commands/up.test.ts` :

```ts
describe("runUp, PC injoignable au depart", () => {
  beforeEach(() => {
    reachable = false;
  });

  test("lit l'adresse materielle dans la table ARP avant d'emettre le paquet magique", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    expect(lookupMac).toHaveBeenCalledWith("10.10.10.1");
    expect(sendMagicPacket).toHaveBeenCalledWith("e8:9c:25:2a:70:e1", "10.10.10.255");
  });

  test("attend le lien apres avoir envoye le paquet magique", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    const sent = order.indexOf("sendMagicPacket");
    const waited = order.indexOf("waitForRemote");
    expect(sent).toBeGreaterThanOrEqual(0);
    expect(waited).toBeGreaterThan(sent);
  });

  test("echoue explicitement si aucune adresse materielle n'est connue", async () => {
    arpMac = null;
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow(/table ARP/);
    expect(sendMagicPacket).not.toHaveBeenCalled();
  });

  test("echoue si le PC ne repond pas apres le reveil", async () => {
    wakeSucceeds = false;
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow(/n'a pas répondu/);
    expect(mountShare).not.toHaveBeenCalled();
  });

  test("poursuit normalement une fois le lien de retour", async () => {
    await runUp(CONFIG, NO_OPTIONS);
    expect(runStream).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/commands/up.test.ts -t "PC injoignable"`
Attendu : ÉCHEC — `wakePC` lève « non implemente a ce cycle ».

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Remplacer le corps provisoire de `wakePC` dans `src/commands/up.ts` :

```ts
async function wakePC(config: Config): Promise<void> {
  const mac = await lookupMac(config.windows.ip);
  if (!mac) {
    throw new Error(
      `Adresse matérielle introuvable dans la table ARP pour ${config.windows.ip}\u00a0: ` +
        "le PC a-t-il déjà répondu au moins une fois sur ce lien\u00a0?",
    );
  }
  const broadcast = broadcastAddress(config.mac.ip, config.mac.subnetMask);
  await sendMagicPacket(mac, broadcast);

  const woke = await waitForRemote(config, WAKE_DEADLINE_MS);
  if (!woke) {
    throw new Error(
      `Le PC n'a pas répondu dans les ${Math.round(WAKE_DEADLINE_MS / 60_000)} minutes suivant le réveil.`,
    );
  }
}
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/commands/up.test.ts`

- [ ] **Étape 5 : Commiter**

```bash
git add src/commands/up.ts test/commands/up.test.ts
git commit -m "commands(up): reveil par paquet magique quand le PC ne repond pas"
```

---

#### Cycle 5 — `runUp` : le nettoyage a lieu même quand le flux échoue

C'est le verrou explicitement exigé par la tâche : démontage et `quit`
doivent survenir même quand `runStream` lève.

- [ ] **Étape 1 : Écrire le test qui échoue**

Ajouter à `test/commands/up.test.ts` :

```ts
describe("runUp, nettoyage garanti par le finally", () => {
  test("demonte tous les partages et clot la session MEME QUAND le flux echoue", async () => {
    streamThrows = new Error("moonlight a planté");
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow("moonlight a planté");
    expect(unmountShare).toHaveBeenCalledTimes(3);
    expect(runQuit).toHaveBeenCalledTimes(1);
  });

  test("demonte et clot meme quand un montage echoue en cours de route", async () => {
    mountThrowsOn = "hardline-e";
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow(/hardline-e/);
    // Le flux n'a jamais demarre, mais le nettoyage porte quand meme sur les
    // trois partages : unmountShare ne leve jamais pour un partage jamais
    // monte, et l'appeler sur tous est donc sans risque.
    expect(runStream).not.toHaveBeenCalled();
    expect(unmountShare).toHaveBeenCalledTimes(3);
    expect(runQuit).toHaveBeenCalledTimes(1);
  });

  test("le demontage d'un partage qui echoue n'empeche pas les autres ni la fermeture", async () => {
    unmountShare.mockImplementationOnce(async () => {
      throw new Error("demontage refuse");
    });
    streamThrows = new Error("moonlight a planté");
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow("moonlight a planté");
    expect(unmountShare).toHaveBeenCalledTimes(3);
    expect(runQuit).toHaveBeenCalledTimes(1);
  });

  test("ne monte rien et ne nettoie rien si le PC ne se reveille jamais", async () => {
    reachable = false;
    wakeSucceeds = false;
    await expect(runUp(CONFIG, NO_OPTIONS)).rejects.toThrow(/n'a pas répondu/);
    expect(mountShare).not.toHaveBeenCalled();
    expect(unmountShare).not.toHaveBeenCalled();
    expect(runQuit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Pour constater l'échec sur une implémentation fautive, déplacer temporairement
le `try { ... } finally { ... }` de `runUp` pour qu'il n'englobe que
`runStream` (pas le montage), et faire échouer `mountThrowsOn`. Le troisième
test du cycle échoue alors : `unmountShare` n'est appelé que pour les
partages montés avant l'échec, jamais pour les trois. Rétablir ensuite
l'implémentation du cycle 3, qui englobe déjà montage et flux dans le même
`try/finally`.

Commande : `bun test --isolate test/commands/up.test.ts -t "nettoyage garanti"`
Attendu, sur l'implémentation correcte déjà en place depuis le cycle 3 : tous
les tests passent déjà ; ce cycle les ajoute comme verrou explicite.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Aucune modification de production : le `try/finally` du cycle 3 couvre déjà
exactement ce périmètre. Ce cycle documente et verrouille l'exigence.

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/commands/up.test.ts`

- [ ] **Étape 5 : Commiter**

```bash
git add test/commands/up.test.ts
git commit -m "test(up): verrouille le nettoyage en finally meme quand le flux echoue"
```

---

#### Cycle 6 — `upCommand` : la commande CLI

- [ ] **Étape 1 : Écrire le test qui échoue**

Ajouter à `test/commands/up.test.ts` :

```ts
describe("upCommand", () => {
  test("rapporte la fin de session au succes", async () => {
    streamExitCode = 0;
    await upCommand({ fullscreen: false, resolution: null, fps: null });
    expect(finishes.join("\n")).toContain("Session terminée.");
    expect(process.exitCode).toBe(0);
  });

  test("rejette des options invalides avant toute action sur les machines", async () => {
    await upCommand({ fullscreen: false, resolution: "pas-une-resolution", fps: null });
    expect(mountShare).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(failures.join("\n")).toContain("Résolution invalide");
  });

  test("rapporte l'echec et sort en 1 quand runUp leve", async () => {
    streamThrows = new Error("moonlight a planté");
    await upCommand({ fullscreen: false, resolution: null, fps: null });
    expect(process.exitCode).toBe(1);
    expect(failures.join("\n")).toContain("moonlight a planté");
    expect(finishes.join("\n")).toContain("Échec de l'ouverture de la session");
  });

  test("transmet le plein ecran et les options imposees jusqu'a runStream", async () => {
    await upCommand({ fullscreen: true, resolution: "2560x1440", fps: "144" });
    const passedOptions = (runStream.mock.calls[0] as unknown[])[2];
    expect(passedOptions).toEqual({
      fullscreen: true,
      resolution: { width: 2560, height: 1440 },
      fps: 144,
    });
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/commands/up.test.ts -t upCommand`
Attendu : ÉCHEC — `upCommand` lève « non implemente a ce cycle » (corps
provisoire du cycle 2).

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Remplacer, dans `src/commands/up.ts`, le corps provisoire de `upCommand` posé
au cycle 2 :

```ts
export async function upCommand(cliOptions: UpCliOptions): Promise<void> {
  configureOutput();
  ui.start("hardline — up");

  let options: StreamOptions;
  try {
    options = buildStreamOptions(cliOptions);
  } catch (error) {
    ui.failed({ label: "Options", detail: errorMessage(error) });
    ui.finish("Options invalides.");
    process.exitCode = 1;
    return;
  }

  try {
    const exitCode = await withSpinner("Ouverture de la session", () =>
      runUp(CONFIG, options),
    );
    ui.finish(
      exitCode === 0
        ? "Session terminée."
        : `Session terminée avec le code ${exitCode}.`,
    );
  } catch (error) {
    ui.failed({ label: "up", detail: errorMessage(error) });
    ui.finish("Échec de l'ouverture de la session.");
    process.exitCode = 1;
  }
}
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/commands/up.test.ts && bunx tsc --noEmit`

- [ ] **Étape 5 : Commiter**

```bash
git add src/commands/up.ts test/commands/up.test.ts
git commit -m "commands(up): upCommand, la commande hardline up"
```

---

#### Cycle 7 — `install.ts` : dialogue sur un Apollo étranger

- [ ] **Étape 1 : Écrire le test qui échoue**

Ajouter à `test/commands/install.test.ts`, avant `const { installCommand } =
await import(...)` : un mock de `../../src/steps/apollo-install` fournissant
`ForeignApolloError`, `backupApolloConfig` et `uninstallApollo`, et un mock
étendu de `../../src/lib/ui` incluant `askConfirmation`.

La forme de l'erreur reprend **exactement** celle que la tâche 8 exporte —
`state: ApolloInstallState` et `hasConfig: boolean` — et non une copie
structurelle réécrite ici. Un bouchon qui s'écarte du vrai type est un test qui
passe contre une interface qui n'existe pas.

```ts
type ApolloInstallState = {
  installed: boolean;
  version: string | null;
  ours: boolean;
  backupPath: string | null;
  pairedClients: number;
};

class ForeignApolloError extends Error {
  constructor(
    readonly state: ApolloInstallState,
    readonly hasConfig: boolean,
  ) {
    super("Apollo étranger détecté.");
    this.name = "ForeignApolloError";
  }
}

let foreignRemoved = false;
const backupApolloConfig = mock(async () => "C:\\ProgramData\\hardline\\apollo-config.bak");
const uninstallApollo = mock(async () => {
  foreignRemoved = true;
});

mock.module("../../src/steps/apollo-install", () => ({
  ForeignApolloError,
  backupApolloConfig,
  uninstallApollo,
}));

let confirmForeignAnswer = true;
const askConfirmation = mock(async (..._args: unknown[]) => confirmForeignAnswer);
```

Étendre le mock existant de `../../src/lib/ui` (déjà présent dans le fichier)
avec `askConfirmation` (déléguer au mock ci-dessus) et `askSecret` (voir
cycle 8 — y ajouter dès ce cycle un mock trivial rendant une valeur fixe, pour
que la Phase 2 modifiée du cycle 8 ne casse pas ce cycle-ci) :

```ts
mock.module("../../src/lib/ui", () => ({
  configureOutput: () => {},
  withSpinner: async <T>(_label: string, run: () => Promise<T>) => run(),
  askConfirmation,
  askSecret: async () => "mot-de-passe-test",
  ui: {
    start: () => {},
    finish: (message: string) => finishes.push(message),
    skipped: () => {},
    applied: () => {},
    restored: () => {},
    yielded: () => {},
    detached: () => {},
    failed: ({ label, detail }: { label: string; detail: string }) =>
      failures.push(`${label} — ${detail}`),
    info: () => {},
    warn: () => {},
    report: () => {},
  },
}));
```

Étendre le mock existant de `../../src/lib/orchestrator` : quand
`applySteps` est appelée avec exactement le groupe `REMOTE_GROUP` et que
`applyThrowsForeign` est armé et non encore acquitté, lever
`ForeignApolloError` :

```ts
let applyThrowsForeign = false;

mock.module("../../src/lib/orchestrator", () => ({
  applySteps: async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    steps: Step<any>[],
    _config: unknown,
    manifestPath: string,
  ) => {
    const names = steps.map((s) => s.name);
    trace.push(`apply:${names.join("+")}`);
    if (applyThrowsOn === names.join("+")) throw new Error("boum");
    if (
      names.join("+") === REMOTE_GROUP.join("+") &&
      applyThrowsForeign &&
      !foreignRemoved
    ) {
      throw new ForeignApolloError(
        {
          installed: true,
          version: "0.4.5",
          ours: false,
          backupPath: null,
          pairedClients: 2,
        },
        true,
      );
    }
    appliedGroups.push(names);
    manifestPaths.push(manifestPath);
    for (const name of names) {
      if (name === "bootstrap-windows" && !releveEnregistrable) continue;
      if (!manifestOrder.includes(name)) manifestOrder.push(name);
    }
    return manifestOf(manifestOrder);
  },
}));
```

Ajouter `beforeEach` : `applyThrowsForeign = false; foreignRemoved = false;
confirmForeignAnswer = true; backupApolloConfig.mockClear();
uninstallApollo.mockClear(); askConfirmation.mockClear();`.

Nouveaux tests, à ajouter en fin de fichier :

```ts
describe("installCommand, Apollo étranger detecte sur le PC", () => {
  test("demande confirmation, nomme ce qui a ete trouve, puis relance et reussit", async () => {
    applyThrowsForeign = true;
    confirmForeignAnswer = true;
    await installCommand({ yes: false });

    expect(askConfirmation).toHaveBeenCalledTimes(1);
    // L'ordre est la substance : on sauvegarde AVANT d'effacer.
    expect(backupApolloConfig).toHaveBeenCalledTimes(1);
    expect(uninstallApollo).toHaveBeenCalledTimes(1);
    expect(backupApolloConfig.mock.invocationCallOrder[0]!).toBeLessThan(
      uninstallApollo.mock.invocationCallOrder[0]!,
    );
    expect(appliedGroups).toEqual([LOCAL_GROUP, CAPTURE_GROUP, REMOTE_GROUP]);
    expect(process.exitCode).toBe(0);
  });

  test("s'arrete sans rien modifier sur le PC si l'utilisateur refuse", async () => {
    applyThrowsForeign = true;
    confirmForeignAnswer = false;
    await installCommand({ yes: false });

    expect(uninstallApollo).not.toHaveBeenCalled();
    expect(backupApolloConfig).not.toHaveBeenCalled();
    expect(appliedGroups).toEqual([LOCAL_GROUP, CAPTURE_GROUP]);
    expect(process.exitCode).toBe(1);
    expect(finishes.join("\n")).toContain("Apollo étranger conservé");
  });

  test("--yes leve la question", async () => {
    applyThrowsForeign = true;
    await installCommand({ yes: true });

    expect(askConfirmation).toHaveBeenCalledTimes(1);
    const options = askConfirmation.mock.calls[0]?.[1] as { assumeYes: boolean };
    expect(options.assumeYes).toBe(true);
    expect(process.exitCode).toBe(0);
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/commands/install.test.ts`
Attendu : ÉCHEC — `installCommand` ne prend encore aucun paramètre `options`,
et ne traite `ForeignApolloError` d'aucune façon.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Dans `src/commands/install.ts`, étendre la ligne d'import `ui` :

```ts
import { askConfirmation, askSecret, configureOutput, ui, withSpinner } from "../lib/ui";
```

Ajouter l'import :

```ts
import {
  backupApolloConfig,
  ForeignApolloError,
  uninstallApollo,
} from "../steps/apollo-install";
```

Ajouter, après `converge` :

```ts
/**
 * La convergence distante peut buter sur un Apollo etranger : l'installation
 * s'arrete et demande, plutot que d'effacer en silence le travail de
 * quelqu'un. --yes leve la question.
 */
async function convergeRemote(
  manifestPath: string,
  options: { yes: boolean },
): Promise<boolean> {
  try {
    await applySteps(REMOTE_STEPS, CONFIG, manifestPath, ui);
    return true;
  } catch (error) {
    if (error instanceof ForeignApolloError) {
      return await handleForeignApollo(error, manifestPath, options);
    }
    ui.failed({ label: "Convergence du PC", detail: errorMessage(error) });
    ui.finish(
      "Installation interrompue\u00a0: l'état antérieur de chaque étape touchée est " +
        "sur disque. Corriger, puis «\u00a0hardline install\u00a0» pour reprendre " +
        "ou «\u00a0hardline uninstall\u00a0» pour tout rendre.",
    );
    process.exitCode = 1;
    return false;
  }
}

async function handleForeignApollo(
  error: ForeignApolloError,
  manifestPath: string,
  options: { yes: boolean },
): Promise<boolean> {
  const { state, hasConfig } = error;
  ui.report("Apollo étranger détecté sur le PC", [
    `Version\u00a0: ${state.version ?? "inconnue"}`,
    `Clients déjà appairés\u00a0: ${state.pairedClients}`,
    hasConfig
      ? "Sa configuration sera sauvegardée sur le PC avant d'être remplacée."
      : "Aucune configuration existante à sauvegarder.",
  ]);

  const confirmed = await askConfirmation(
    "Remplacer cette installation d'Apollo par celle de hardline\u00a0?",
    { assumeYes: options.yes },
  );
  if (!confirmed) {
    ui.finish(
      "Installation interrompue\u00a0: Apollo étranger conservé, rien n'a été modifié sur le PC.",
    );
    process.exitCode = 1;
    return false;
  }

  // C'est la COMMANDE qui efface, jamais l'etape. apply() leve et n'agit pas,
  // de sorte qu'aucun consentement ne transite par un drapeau global : le
  // contrat Step n'a pas de canal pour cela, et lui en inventer un pour un
  // seul cas deformerait le contrat de toutes les autres etapes.
  const backupPath = await backupApolloConfig(CONFIG);
  if (backupPath !== null) {
    ui.info(`Configuration de l'Apollo étranger sauvegardée dans ${backupPath}`);
  }
  await uninstallApollo(CONFIG);

  try {
    await applySteps(REMOTE_STEPS, CONFIG, manifestPath, ui);
    return true;
  } catch (retryError) {
    ui.failed({ label: "Convergence du PC", detail: errorMessage(retryError) });
    ui.finish(
      "Installation interrompue\u00a0: l'état antérieur de chaque étape touchée est " +
        "sur disque. Corriger, puis «\u00a0hardline install\u00a0» pour reprendre " +
        "ou «\u00a0hardline uninstall\u00a0» pour tout rendre.",
    );
    process.exitCode = 1;
    return false;
  }
}
```

Modifier `installCommand` et `install` pour faire voyager `options` :

```ts
export async function installCommand(options: { yes?: boolean } = {}): Promise<void> {
  configureOutput();
  ui.start("hardline — installation");

  const manifestPath = defaultManifestPath();
  let lock: ManifestLock;
  try {
    lock = await acquireManifestLock(manifestPath);
  } catch (error) {
    if (!(error instanceof ManifestLockedError)) throw error;
    ui.failed({ label: "Manifeste", detail: errorMessage(error) });
    ui.finish("Installation abandonnée.");
    process.exitCode = 1;
    return;
  }

  try {
    await install(manifestPath, { yes: options.yes ?? false });
  } finally {
    await lock.release();
  }
}

async function install(manifestPath: string, options: { yes: boolean }): Promise<void> {
```

Le corps de `install` n'est pas réécrit : **deux modifications ponctuelles**, et
rien d'autre.

1. Sa signature gagne le second paramètre `options: { yes: boolean }`.
2. Sa dernière phase, aujourd'hui

```ts
  if (!(await converge(REMOTE_STEPS, "Convergence du PC", manifestPath))) return;
```

devient

```ts
  if (!(await convergeRemote(manifestPath, options))) return;
```

Les phases 1 à 3bis ne changent pas dans ce cycle. La modification de la phase 2,
qui ajoute `ensureWindowsPassword()`, appartient au cycle 8 et se pose
indépendamment.

(Le corps des phases 1 à 3bis ne change pas dans ce cycle ; seule la ligne
finale — l'ancien `if (!(await converge(REMOTE_STEPS, ...))) return;` —
devient l'appel à `convergeRemote` ci-dessus. La modification de la Phase 2,
qui ajoute `ensureWindowsPassword()`, est celle du cycle 8.)

Câbler `--yes` sur la commande `install` dans `src/cli.ts` :

```ts
  program
    .command("install")
    .description("Converge les deux machines vers l'état cible")
    .option("-y, --yes", "ne pas demander de confirmation", false)
    .action(installCommand);
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/commands/install.test.ts test/cli.test.ts && bunx tsc --noEmit`

- [ ] **Étape 5 : Commiter**

```bash
git add src/commands/install.ts src/cli.ts test/commands/install.test.ts
git commit -m "commands(install): dialogue de confirmation sur un Apollo etranger"
```

---

#### Cycle 8 — `install.ts` : le mot de passe Windows est demandé une fois

- [ ] **Étape 1 : Écrire le test qui échoue**

Ajouter à `test/commands/install.test.ts` un mock de
`../../src/lib/keychain` et de `../../src/steps/smb-credentials`, avant
l'import de `installCommand` :

```ts
let windowsSecretPresent = false;
const getSecretForCredentials = mock(async (..._args: unknown[]) =>
  windowsSecretPresent ? "deja-au-trousseau" : null,
);
mock.module("../../src/lib/keychain", () => ({ getSecret: getSecretForCredentials }));

const providePassword = mock((..._args: unknown[]) => {});
mock.module("../../src/steps/smb-credentials", () => ({ providePassword }));
```

Remplacer le mock `askSecret` posé au cycle 7 par une version instrumentée :

```ts
const askSecretCalls: string[] = [];
const askSecret = mock(async (message: string) => {
  askSecretCalls.push(message);
  return "mot-de-passe-saisi";
});
```

et référencer `askSecret` (au lieu du littéral `async () => "..."`) dans le
mock de `../../src/lib/ui`. Réinitialiser dans `beforeEach` :
`windowsSecretPresent = false; getSecretForCredentials.mockClear();
providePassword.mockClear(); askSecret.mockClear(); askSecretCalls.length =
0;`.

Nouveaux tests :

```ts
describe("installCommand, mot de passe Windows", () => {
  test("le demande une seule fois quand le trousseau est vide, avant la convergence locale", async () => {
    windowsSecretPresent = false;
    await installCommand();
    expect(askSecret).toHaveBeenCalledTimes(1);
    expect(providePassword).toHaveBeenCalledWith("mot-de-passe-saisi");
    const askIndex = trace.indexOf("apply:network-mac+moonlight-install+smb-credentials");
    expect(askSecretCalls.length).toBeGreaterThan(0);
    expect(askIndex).toBeGreaterThanOrEqual(0);
  });

  test("ne demande rien quand un mot de passe est deja au trousseau", async () => {
    windowsSecretPresent = true;
    await installCommand();
    expect(askSecret).not.toHaveBeenCalled();
    expect(providePassword).not.toHaveBeenCalled();
  });
});
```

- [ ] **Étape 2 : Lancer le test et vérifier qu'il échoue**

Commande : `bun test --isolate test/commands/install.test.ts -t "mot de passe Windows"`
Attendu : ÉCHEC — `askSecret` n'est jamais appelé, `install()` ne consulte pas
encore le trousseau avant la Phase 2.

- [ ] **Étape 3 : Écrire l'implémentation minimale**

Dans `src/commands/install.ts`, ajouter les imports :

```ts
import { getSecret } from "../lib/keychain";
import { providePassword } from "../steps/smb-credentials";
```

Ajouter, après `bootstrapRemote` :

```ts
/**
 * Le mot de passe Windows n'est jamais recueilli par l'etape elle-meme : les
 * etapes ne dialoguent jamais. Il est demande ici, une seule fois, avant que
 * la convergence locale ne commence, et depose dans smb-credentials par ce
 * pont.
 */
async function ensureWindowsPassword(): Promise<void> {
  if ((await getSecret("windows-account")) !== null) return;
  const password = await askSecret(
    `Mot de passe du compte Windows «\u00a0${CONFIG.smb.user}\u00a0», pour les partages\u00a0:`,
  );
  providePassword(password);
}
```

Modifier la Phase 2 de `install()` :

```ts
  // Phase 2 - convergence locale. C'est elle qui cree la route vers le
  // lien direct : sans elle, aucune precondition distante n'est observable.
  await ensureWindowsPassword();
  if (!(await converge(LOCAL_STEPS, "Convergence du Mac", manifestPath))) return;
```

- [ ] **Étape 4 : Lancer le test et vérifier qu'il passe**

Commande : `bun test --isolate test/commands/install.test.ts && bunx tsc --noEmit`

- [ ] **Étape 5 : Commiter**

```bash
git add src/commands/install.ts test/commands/install.test.ts
git commit -m "commands(install): demande le mot de passe Windows une seule fois"
```

---

## Notes et réserves

- **`ForeignApolloError`, `backupApolloConfig` et `uninstallApollo`** (consommés au cycle 7 de
  la tâche 12) sont supposés exportés par `src/steps/apollo-install.ts`
  (tâche 7 du plan, hors du périmètre confié ici). Ni leur nom ni leur forme
  ne figurent dans `interfaces.md` ; leur shape est déduite de la spec
  (§11 : « L'installation nomme ce qu'elle a trouvé — version, nombre de
  clients appairés, présence d'une configuration ») et alignée sur
  `ApolloInstallState`, déjà fixé par `interfaces.md`
  (`installed, version, ours, backupPath, pairedClients`). À réconcilier avec
  la tâche 7 réelle avant exécution : si son nom, ses champs ou son mécanisme
  d'acquittement diffèrent, les cycles 7 et 8 de la tâche 12 devront être
  ajustés en conséquence.
- **`src/lib/brew.ts`** (tâche 10) et **`src/lib/moonlight-plist.ts`**
  (tâche 11) sont de nouveaux fichiers hors du contrat `interfaces.md`,
  introduits ici parce qu'aucune frontière système partagée n'existe pour
  interroger Homebrew ou le plist de Moonlight. Leur forme suit le motif déjà
  en place dans le dépôt (`src/lib/shell.ts` : fonctions pures testées seules,
  frontière système non couverte par des tests unitaires).
- **`askSecret`** (`src/lib/ui.ts`, tâche 10) suppose que `@clack/prompts`
  exporte une fonction `password({ message })` de la même forme que
  `confirm({ message })`, déjà utilisée par `askConfirmation`. Non vérifié
  contre la version installée du paquet.
- **Le pont `providePassword`** (`src/steps/smb-credentials.ts`) est un état
  de module en mémoire, délibérément choisi pour respecter la règle absolue
  « les étapes ne dialoguent jamais » sans pouvoir faire transiter une valeur
  interactive par la signature fixe de `Step<P>.apply(config)`. Il n'est
  consommé que par `hardline install`, jamais par les tests d'une machine
  réelle.
- **Le calcul de diffusion** (`broadcastAddress`, tâche 12) est écrit
  localement à `src/commands/up.ts` : `interfaces.md` ne l'expose pas depuis
  `src/lib/wol.ts`, dont le contrat attend l'adresse de diffusion déjà
  calculée en paramètre de `sendMagicPacket`.
- **`src/lib/moonlight-plist.ts`** suppose une structure JSON `{ hosts: [{
  address, ... }] }` pour le domaine de préférences de Moonlight, déduite par
  raisonnement (QSettings sur macOS) et non vérifiée sur une vraie
  installation. La spec (§15) liste elle-même la vérification sur machine
  comme non simulable ; ce module en fait partie et devra être ajusté au
  contact du vrai plist si sa forme diffère.
- Le ravalement mécanique de `test/commands/install.test.ts` (cycle 1 de la
  tâche 12) part du contenu exact lu dans le dépôt au moment d'écrire ce
  plan (426 lignes) ; si une autre tâche modifie ce fichier avant l'exécution
  de la tâche 12, les remplacements de chaînes littérales devront être
  réappliqués à la main plutôt que copiés tels quels.
