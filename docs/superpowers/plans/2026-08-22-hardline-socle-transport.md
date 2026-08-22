# hardline — Plan 1 : socle et transport

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer un CLI `hardline` qui établit et diagnostique une liaison Ethernet
directe persistante entre le Mac et le PC Windows, sans aucune fonction vidéo.

**Architecture:** Un CLI TypeScript exécuté par Bun sur le Mac, qui est le dépôt de
vérité. Les commandes Windows sont poussées par SSH. Toute frontière avec le système
est confinée à deux modules, `lib/shell.ts` pour macOS et `lib/ssh.ts` pour Windows, ce
qui rend le reste du code testable sans machine réelle. Chaque étape d'installation
expose le même contrat en trois temps — constater, appliquer, restaurer.

**Tech Stack:** Bun 1.4.0, TypeScript strict, `commander` pour les sous-commandes,
`@clack/prompts` pour l'affichage, `bun:test` pour les tests.

**Spec:** `docs/superpowers/specs/2026-08-22-hardline-design.md`

## Global Constraints

Ces contraintes s'appliquent à toutes les tâches sans être répétées.

- Runtime : **Bun 1.4.0**. TypeScript en mode `strict`, `moduleResolution: bundler`,
  `type: module`.
- Dépendances de production autorisées : **`commander`** et **`@clack/prompts`**,
  aucune autre. Tout le reste vient de Bun ou de `node:*`.
- Matériel cible, toute divergence doit arrêter l'exécution avec un message explicite :
  MacBook Pro `Mac15,11` sous macOS ; PC ASUS ROG STRIX Z790-H GAMING WIFI, Windows 11
  Pro build 26200, GPU NVIDIA.
- Adressage du lien direct, valeurs exactes : PC `10.10.10.1`, Mac `10.10.10.2`,
  masque `255.255.255.0` soit `/24`, **aucune passerelle**. Définir une passerelle
  détournerait la route par défaut de macOS et couperait Internet.
- Accès SSH : utilisateur `arthur`, clé privée `~/.ssh/id_ed25519_winpc`. L'interface
  Windows du lien direct porte l'alias `Ethernet`.
- **Aucun fichier hors `src/lib/shell.ts` et `src/lib/ssh.ts` n'appelle `Bun.$`,
  `Bun.spawn` ou `Bun.spawnSync`.** C'est la règle qui rend les tests possibles.
- Les commandes distantes sont construites comme tableau d'arguments passé à
  `Bun.spawn` — jamais via `Bun.$` — pour éviter la collision entre l'échappement du
  shell de Bun et le quoting de PowerShell.
- `ping` sur macOS exige toujours `-c N`, sans quoi il ne se termine jamais.
- Le manifeste d'état est écrit de façon atomique : fichier temporaire puis
  `fs.rename()`. `Bun.write` seul ne suffit pas.
- Toute commande système dont un code de retour non nul est un résultat normal à
  inspecter — `ping`, `networksetup` — utilise `.nothrow()`.
- Langue de l'interface : français, accents inclus. Les identifiants du code restent en
  anglais.
- **Les tests se lancent avec `bun test --isolate`**, et le script `test` du
  `package.json` porte ce drapeau. `mock.module` remplace un module pour tout le
  processus : sans isolation, un fichier de test qui substitue `src/lib/shell.ts`
  contamine les fichiers exécutés après lui. La clé `isolate` n'existe pas dans
  `bunfig.toml`, le drapeau est donc obligatoire.

## Fichiers du plan 1

| Fichier | Responsabilité |
|---|---|
| `package.json`, `tsconfig.json`, `bunfig.toml` | Configuration du projet |
| `src/cli.ts` | Point d'entrée, déclaration des sous-commandes, gestion de l'annulation |
| `src/lib/shell.ts` | Unique frontière avec le système macOS |
| `src/lib/ssh.ts` | Unique frontière avec le système Windows |
| `src/lib/manifest.ts` | Lecture et écriture atomique de l'état |
| `src/lib/preflight.ts` | Vérification des préconditions |
| `src/lib/ui.ts` | Enveloppe d'affichage au-dessus de Clack |
| `src/steps/types.ts` | Contrat commun constater/appliquer/restaurer |
| `src/steps/network-mac.ts` | Adresse fixe persistante côté Mac |
| `src/steps/network-windows.ts` | Adresse fixe et profil privé côté PC |
| `src/steps/network-profile-task.ts` | Tâche planifiée maintenant le profil privé au démarrage |
| `src/steps/index.ts` | Registre ordonné des étapes |
| `src/lib/orchestrator.ts` | Boucle de convergence et de restauration |
| `src/lib/bootstrap-server.ts` | Serveur HTTP éphémère du script d'amorçage |
| `src/assets/bootstrap.ps1` | Script d'amorçage PowerShell |
| `src/commands/{install,uninstall,doctor,up}.ts` | Les quatre sous-commandes |
| `scripts/build.ts` | Production du binaire autonome |

---
### Task 1: Squelette du projet et déclaration des sous-commandes

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `bunfig.toml`
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: rien, c'est la première tâche.
- Produces: `buildProgram(): Command` et `VERSION: string`, exportés depuis
  `src/cli.ts`. Toutes les tâches ultérieures branchent leur sous-commande en
  modifiant `buildProgram`.

- [ ] **Step 1: Initialiser le projet et installer les dépendances**

```bash
bun init -y
rm -f index.ts
bun add commander @clack/prompts
bun add -d @types/bun
```

- [ ] **Step 2: Écrire les trois fichiers de configuration**

`package.json` — fusionner ces champs dans le fichier généré. **Conserver tels quels
les blocs `dependencies` et `devDependencies` que `bun add` vient d'écrire** : ils sont
volontairement absents du bloc ci-dessous, les effacer casserait l'installation.

```json
{
  "name": "hardline",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "bun run src/cli.ts",
    "test": "bun test --isolate",
    "build": "bun run scripts/build.ts"
  }
}
```

`tsconfig.json` :

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src", "test", "scripts"]
}
```

`bunfig.toml` :

```toml
[test]
root = "."
```

- [ ] **Step 3: Écrire le test qui échoue**

`test/cli.test.ts` :

```ts
import { test, expect } from "bun:test";
import { buildProgram, VERSION } from "../src/cli";

test("le programme expose les quatre sous-commandes attendues", () => {
  const names = buildProgram()
    .commands.map((c) => c.name())
    .sort();
  expect(names).toEqual(["doctor", "install", "uninstall", "up"]);
});

test("le programme porte un numero de version", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
```

- [ ] **Step 4: Lancer le test et vérifier qu'il échoue**

Run: `bun test --isolate test/cli.test.ts`
Expected: FAIL — le module `../src/cli` n'existe pas.

- [ ] **Step 5: Écrire l'implémentation minimale**

`src/cli.ts` :

```ts
#!/usr/bin/env bun
import { Command } from "commander";

export const VERSION = "0.1.0";

const NOT_IMPLEMENTED = (name: string) => async () => {
  console.error(`hardline ${name} : pas encore implémenté`);
  process.exitCode = 1;
};

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("hardline")
    .description("Liaison Ethernet directe entre le Mac et le PC Windows")
    .version(VERSION);

  program
    .command("install")
    .description("Converge les deux machines vers l'état cible")
    .action(NOT_IMPLEMENTED("install"));

  program
    .command("uninstall")
    .description("Restaure l'état antérieur à partir du manifeste")
    .action(NOT_IMPLEMENTED("uninstall"));

  program
    .command("up")
    .description("Ouvre la session de travail sur le PC")
    .action(NOT_IMPLEMENTED("up"));

  program
    .command("doctor")
    .description("Diagnostique la liaison et les services")
    .action(NOT_IMPLEMENTED("doctor"));

  return program;
}

if (import.meta.main) {
  await buildProgram().parseAsync(Bun.argv);
}
```

- [ ] **Step 6: Lancer le test et vérifier qu'il passe**

Run: `bun test --isolate test/cli.test.ts`
Expected: PASS, deux tests.

- [ ] **Step 7: Vérifier le CLI à la main**

Run: `bun run src/cli.ts --help`
Expected: les quatre sous-commandes sont listées avec leur description en français.

- [ ] **Step 8: Commit**

```bash
git add package.json bun.lock tsconfig.json bunfig.toml src/cli.ts test/cli.test.ts
git commit -m "feat: squelette du CLI hardline avec ses quatre sous-commandes"
```

---
### Task 2: Frontière système macOS et parseurs

C'est le module le plus important du projet. Toute la testabilité en dépend : les
fonctions de parsing sont pures et testées sur des sorties réellement capturées sur la
machine cible, tandis que les fonctions asynchrones qui invoquent le système ne
contiennent aucune logique.

**Files:**
- Create: `src/lib/shell.ts`
- Test: `test/lib/shell.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: les types `PingStats`, `NetworkService`, `ServiceIPConfig`, les parseurs
  purs `parsePingOutput`, `parseNetworkServices`, `parseServiceInfo`, et les fonctions
  système `ping`, `listNetworkServices`, `getServiceInfo`, `setServiceManualIP`,
  `setServiceDHCP`. `src/steps/network-mac.ts` et `src/commands/doctor.ts` en dépendent.

- [ ] **Step 1: Écrire les tests qui échouent**

`test/lib/shell.test.ts` :

```ts
import { test, expect, describe } from "bun:test";
import {
  parsePingOutput,
  parseNetworkServices,
  parseServiceInfo,
} from "../../src/lib/shell";

const PING_OK = `PING 169.254.168.1 (169.254.168.1): 56 data bytes
--- 169.254.168.1 ping statistics ---
200 packets transmitted, 200 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 0.465/1.040/1.734/0.209 ms
`;

const PING_UNREACHABLE = `PING 192.168.1.48 (192.168.1.48): 56 data bytes
Request timeout for icmp_seq 0
--- 192.168.1.48 ping statistics ---
3 packets transmitted, 0 packets received, 100.0% packet loss
`;

const SERVICES = `An asterisk (*) denotes that a network service is disabled.
(1) Thunderbolt Ethernet
(Hardware Port: Thunderbolt Ethernet, Device: en4)

(2) AX88179A
(Hardware Port: AX88179A, Device: en14)

(3) Wi-Fi
(Hardware Port: Wi-Fi, Device: en0)
`;

const INFO_DHCP = `DHCP Configuration
IP address: 169.254.168.226
Subnet mask: 255.255.0.0
Router: (null)
Client ID:
Ethernet Address: f8:e4:3b:e9:2a:cd
`;

const INFO_MANUAL = `Manual Configuration
IP address: 10.10.10.2
Subnet mask: 255.255.255.0
Router: (null)
Ethernet Address: f8:e4:3b:e9:2a:cd
`;

const INFO_OFF = `Manual Configuration
IP address: none
Subnet mask: none
Router: none
Ethernet Address: f8:e4:3b:e9:2a:cd
`;

describe("parsePingOutput", () => {
  test("extrait les statistiques d'un ping reussi", () => {
    expect(parsePingOutput(PING_OK)).toEqual({
      transmitted: 200,
      received: 200,
      lossPercent: 0,
      minMs: 0.465,
      avgMs: 1.04,
      maxMs: 1.734,
      stddevMs: 0.209,
    });
  });

  test("gere un hote injoignable, sans ligne round-trip", () => {
    expect(parsePingOutput(PING_UNREACHABLE)).toEqual({
      transmitted: 3,
      received: 0,
      lossPercent: 100,
      minMs: null,
      avgMs: null,
      maxMs: null,
      stddevMs: null,
    });
  });

  test("renvoie null partout si la sortie est illisible", () => {
    expect(parsePingOutput("")).toEqual({
      transmitted: 0,
      received: 0,
      lossPercent: 100,
      minMs: null,
      avgMs: null,
      maxMs: null,
      stddevMs: null,
    });
  });
});

describe("parseNetworkServices", () => {
  test("apparie chaque service avec son peripherique", () => {
    const services = parseNetworkServices(SERVICES);
    expect(services).toHaveLength(3);
    expect(services[1]).toEqual({
      order: 2,
      name: "AX88179A",
      hardwarePort: "AX88179A",
      device: "en14",
    });
  });

  test("ignore la ligne d'avertissement en tete", () => {
    expect(parseNetworkServices(SERVICES).map((s) => s.name)).toEqual([
      "Thunderbolt Ethernet",
      "AX88179A",
      "Wi-Fi",
    ]);
  });
});

describe("parseServiceInfo", () => {
  test("reconnait une configuration DHCP", () => {
    expect(parseServiceInfo(INFO_DHCP)).toEqual({
      mode: "dhcp",
      ip: "169.254.168.226",
      subnetMask: "255.255.0.0",
      router: null,
    });
  });

  test("reconnait une configuration manuelle", () => {
    expect(parseServiceInfo(INFO_MANUAL)).toEqual({
      mode: "manual",
      ip: "10.10.10.2",
      subnetMask: "255.255.255.0",
      router: null,
    });
  });

  test("reconnait un service sans adresse", () => {
    expect(parseServiceInfo(INFO_OFF)).toEqual({
      mode: "off",
      ip: null,
      subnetMask: null,
      router: null,
    });
  });
});
```

- [ ] **Step 2: Lancer les tests et vérifier qu'ils échouent**

Run: `bun test --isolate test/lib/shell.test.ts`
Expected: FAIL — le module `../../src/lib/shell` n'existe pas.

- [ ] **Step 3: Écrire l'implémentation**

`src/lib/shell.ts` :

```ts
import { $ } from "bun";

export type PingStats = {
  transmitted: number;
  received: number;
  lossPercent: number;
  minMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
  stddevMs: number | null;
};

export type NetworkService = {
  order: number;
  name: string;
  hardwarePort: string;
  device: string;
};

export type ServiceIPConfig = {
  mode: "dhcp" | "manual" | "off";
  ip: string | null;
  subnetMask: string | null;
  router: string | null;
};

const PING_COUNTS =
  /(\d+) packets transmitted, (\d+) packets received, ([\d.]+)% packet loss/;
const PING_RTT =
  /round-trip min\/avg\/max\/stddev = ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+) ms/;

export function parsePingOutput(stdout: string): PingStats {
  const counts = stdout.match(PING_COUNTS);
  const rtt = stdout.match(PING_RTT);

  return {
    transmitted: counts ? Number(counts[1]) : 0,
    received: counts ? Number(counts[2]) : 0,
    lossPercent: counts ? Number(counts[3]) : 100,
    minMs: rtt ? Number(rtt[1]) : null,
    avgMs: rtt ? Number(rtt[2]) : null,
    maxMs: rtt ? Number(rtt[3]) : null,
    stddevMs: rtt ? Number(rtt[4]) : null,
  };
}

const SERVICE_HEADER = /^\((\d+)\)\s+(.+)$/;
const SERVICE_DEVICE = /^\(Hardware Port:\s*(.+?),\s*Device:\s*(.+?)\)$/;

export function parseNetworkServices(stdout: string): NetworkService[] {
  const lines = stdout.split("\n").map((l) => l.trim());
  const services: NetworkService[] = [];

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]?.match(SERVICE_HEADER);
    if (!header) continue;
    const device = lines[i + 1]?.match(SERVICE_DEVICE);
    if (!device) continue;

    services.push({
      order: Number(header[1]),
      name: header[2]!,
      hardwarePort: device[1]!,
      device: device[2]!,
    });
  }

  return services;
}

function fieldValue(stdout: string, label: string): string | null {
  const match = stdout.match(new RegExp(`^${label}:\\s*(.*)$`, "m"));
  const raw = match?.[1]?.trim();
  if (!raw || raw === "(null)" || raw === "none") return null;
  return raw;
}

export function parseServiceInfo(stdout: string): ServiceIPConfig {
  const ip = fieldValue(stdout, "IP address");
  const subnetMask = fieldValue(stdout, "Subnet mask");
  const router = fieldValue(stdout, "Router");

  const mode: ServiceIPConfig["mode"] = !ip
    ? "off"
    : stdout.startsWith("DHCP Configuration")
      ? "dhcp"
      : "manual";

  return { mode, ip, subnetMask, router };
}

// --- Frontière système. Aucune logique ici, seulement l'appel et le parsing. ---

export async function ping(host: string, count = 5): Promise<PingStats> {
  const { stdout } = await $`ping -c ${count} -t 5 ${host}`.quiet().nothrow();
  return parsePingOutput(stdout.toString());
}

export async function pingFrom(
  source: string,
  host: string,
  count = 5,
): Promise<PingStats> {
  const { stdout } = await $`ping -c ${count} -t 5 -S ${source} ${host}`
    .quiet()
    .nothrow();
  return parsePingOutput(stdout.toString());
}

export async function listNetworkServices(): Promise<NetworkService[]> {
  const { stdout } = await $`networksetup -listnetworkserviceorder`
    .quiet()
    .nothrow();
  return parseNetworkServices(stdout.toString());
}

export async function getServiceInfo(service: string): Promise<ServiceIPConfig> {
  const { stdout } = await $`networksetup -getinfo ${service}`.quiet().nothrow();
  return parseServiceInfo(stdout.toString());
}

export async function setServiceManualIP(
  service: string,
  ip: string,
  subnetMask: string,
): Promise<number> {
  // Le quatrieme argument est la passerelle. La chaine vide la laisse vide,
  // ce qui est volontaire : voir les contraintes globales.
  const { exitCode } =
    await $`sudo networksetup -setmanual ${service} ${ip} ${subnetMask} ""`
      .quiet()
      .nothrow();
  return exitCode;
}

export async function setServiceDHCP(service: string): Promise<number> {
  const { exitCode } = await $`sudo networksetup -setdhcp ${service}`
    .quiet()
    .nothrow();
  return exitCode;
}
```

- [ ] **Step 4: Lancer les tests et vérifier qu'ils passent**

Run: `bun test --isolate test/lib/shell.test.ts`
Expected: PASS, huit tests.

- [ ] **Step 5: Vérifier les fonctions système contre la vraie machine**

Run: `bun -e 'import {listNetworkServices, ping} from "./src/lib/shell"; console.log(await listNetworkServices()); console.log(await ping("127.0.0.1", 3))'`
Expected: la liste des services réels du Mac, dont un dont le `device` correspond à
l'adaptateur USB, puis des statistiques de ping avec `lossPercent: 0`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/shell.ts test/lib/shell.test.ts
git commit -m "feat: frontiere systeme macOS et parseurs testes sur sorties reelles"
```

---
### Task 3: Frontière système Windows par SSH

Deux décisions structurent ce module, toutes deux issues de problèmes rencontrés
pendant l'exploration.

D'abord, les commandes sont passées à `Bun.spawn` sous forme de tableau d'arguments :
aucune interprétation shell n'est appliquée côté Mac, ce qui élimine la collision entre
l'échappement de Bun et le quoting de PowerShell.

Ensuite, le script PowerShell est transmis en **`-EncodedCommand`**, c'est-à-dire
encodé en UTF-16LE puis en Base64. Cela supprime définitivement deux classes de
problèmes : le quoting imbriqué, et les accents français mutilés par la page de code de
la console Windows. Toute sortie destinée à être lue par le programme transite en JSON,
jamais en texte formaté.

**Files:**
- Create: `src/lib/ssh.ts`
- Test: `test/lib/ssh.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: le type `SSHTarget`, les fonctions pures `encodePowerShell`,
  `withOutputEncoding` et `buildSSHArgs`, et les fonctions système `runRemote` et
  `runRemoteJson`.
  `src/steps/network-windows.ts`, `src/lib/preflight.ts` et `src/commands/doctor.ts`
  en dépendent.

- [ ] **Step 1: Écrire les tests qui échouent**

`test/lib/ssh.test.ts` :

```ts
import { test, expect, describe } from "bun:test";
import {
  encodePowerShell,
  withOutputEncoding,
  buildSSHArgs,
  type SSHTarget,
} from "../../src/lib/ssh";

const TARGET: SSHTarget = {
  host: "10.10.10.1",
  user: "arthur",
  identityFile: "/Users/arthur/.ssh/id_ed25519_winpc",
};

describe("encodePowerShell", () => {
  test("produit du base64 decodable en UTF-16LE", () => {
    const script = "Write-Output 'test'";
    const encoded = encodePowerShell(script);
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(script);
  });

  test("preserve les accents francais", () => {
    const script = "Write-Output 'réseau privé déjà conforme'";
    const encoded = encodePowerShell(script);
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(script);
  });

  test("preserve les guillemets imbriques sans echappement", () => {
    const script = `Get-NetAdapter -Name "Ethernet" | Select-Object -Property "Status"`;
    expect(Buffer.from(encodePowerShell(script), "base64").toString("utf16le")).toBe(
      script,
    );
  });
});

describe("withOutputEncoding", () => {
  test("prefixe le script pour forcer une sortie UTF-8", () => {
    const wrapped = withOutputEncoding("Write-Output 'réseau privé'");
    expect(wrapped).toContain("OutputEncoding");
    expect(wrapped).toContain("UTF8Encoding");
  });

  test("laisse le script d'origine intact a la fin", () => {
    const script = "Get-NetAdapter | Select-Object Name";
    expect(withOutputEncoding(script).endsWith(script)).toBe(true);
  });
});

describe("buildSSHArgs", () => {
  test("construit un tableau d'arguments, jamais une chaine shell", () => {
    const args = buildSSHArgs(TARGET, "powershell -EncodedCommand AAA=");
    expect(Array.isArray(args)).toBe(true);
    expect(args[0]).toBe("ssh");
    expect(args).toContain("arthur@10.10.10.1");
    expect(args.at(-1)).toBe("powershell -EncodedCommand AAA=");
  });

  test("desactive l'interactivite pour ne jamais bloquer", () => {
    const args = buildSSHArgs(TARGET, "whoami");
    expect(args).toContain("BatchMode=yes");
  });

  test("utilise la cle fournie", () => {
    const args = buildSSHArgs(TARGET, "whoami");
    const i = args.indexOf("-i");
    expect(args[i + 1]).toBe(TARGET.identityFile);
  });

  test("applique le delai de connexion demande", () => {
    const args = buildSSHArgs({ ...TARGET, connectTimeoutSec: 3 }, "whoami");
    expect(args).toContain("ConnectTimeout=3");
  });
});
```

- [ ] **Step 2: Lancer les tests et vérifier qu'ils échouent**

Run: `bun test --isolate test/lib/ssh.test.ts`
Expected: FAIL — le module `../../src/lib/ssh` n'existe pas.

- [ ] **Step 3: Écrire l'implémentation**

`src/lib/ssh.ts` :

```ts
export type SSHTarget = {
  host: string;
  user: string;
  identityFile: string;
  connectTimeoutSec?: number;
};

export type RemoteResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly result: RemoteResult,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}

/**
 * PowerShell attend du UTF-16LE encode en Base64. Ce detour supprime tout
 * probleme de quoting et d'accents entre macOS, SSH, cmd.exe et PowerShell.
 */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

const OUTPUT_UTF8 = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()";

/**
 * -EncodedCommand ne regle que l'ENTREE du script. La sortie de PowerShell part
 * dans la page de code OEM de la console — cp850 sur un Windows francais — ce qui
 * mutile les accents au retour. Ce prefixe force une sortie UTF-8 sans marque
 * d'ordre des octets.
 */
export function withOutputEncoding(script: string): string {
  return `${OUTPUT_UTF8}\n${script}`;
}

export function buildSSHArgs(target: SSHTarget, remoteCommand: string): string[] {
  return [
    "ssh",
    "-i",
    target.identityFile,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `ConnectTimeout=${target.connectTimeoutSec ?? 8}`,
    `${target.user}@${target.host}`,
    remoteCommand,
  ];
}

// --- Frontière système. ---

export async function runRemote(
  target: SSHTarget,
  script: string,
  timeoutMs = 120_000,
): Promise<RemoteResult> {
  const remoteCommand = `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(withOutputEncoding(script))}`;

  const proc = Bun.spawn(buildSSHArgs(target, remoteCommand), {
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Execute un script dont la derniere expression est convertie en JSON cote
 * Windows. Renvoie toujours un tableau : ConvertTo-Json emet un objet nu
 * quand il n'y a qu'un element, et rien du tout quand il n'y en a aucun.
 */
export async function runRemoteJson<T>(
  target: SSHTarget,
  script: string,
  timeoutMs = 120_000,
): Promise<T[]> {
  const wrapped = `$ErrorActionPreference = 'Stop'
$result = & { ${script} }
if ($null -eq $result) { '[]' } else { ConvertTo-Json -InputObject @($result) -Depth 6 -Compress }`;

  const result = await runRemote(target, wrapped, timeoutMs);

  if (result.exitCode !== 0) {
    throw new RemoteError(
      `Commande distante en echec (code ${result.exitCode}) : ${result.stderr || result.stdout}`,
      result,
    );
  }

  if (result.stdout === "") return [];

  try {
    return JSON.parse(result.stdout) as T[];
  } catch {
    throw new RemoteError(
      `Sortie distante illisible, JSON attendu : ${result.stdout.slice(0, 200)}`,
      result,
    );
  }
}
```

- [ ] **Step 4: Lancer les tests et vérifier qu'ils passent**

Run: `bun test --isolate test/lib/ssh.test.ts`
Expected: PASS, neuf tests.

- [ ] **Step 5: Vérifier contre le vrai PC**

Le PC doit être joignable. Utiliser son adresse actuelle si l'adressage fixe n'est pas
encore posé.

Run: `bun -e 'import {runRemoteJson} from "./src/lib/ssh"; console.log(await runRemoteJson({host:"192.168.1.48",user:"arthur",identityFile:process.env.HOME+"/.ssh/id_ed25519_winpc"}, "Get-NetAdapter | Select-Object Name,Status,LinkSpeed"))'`
Expected: un tableau JSON d'objets, **avec les accents intacts** dans les noms
d'interfaces français. C'est la validation du choix `-EncodedCommand`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ssh.ts test/lib/ssh.test.ts
git commit -m "feat: frontiere systeme Windows par SSH en EncodedCommand"
```

---
### Task 4: Manifeste d'état, écrit atomiquement

Le manifeste est le seul élément dont dépend la désinstallation. Il enregistre pour
chaque étape appliquée **l'état antérieur qu'elle a remplacé**, afin que `uninstall`
restaure plutôt qu'il ne devine. Son écriture doit être atomique : une interruption en
plein `install` ne doit jamais laisser un fichier tronqué, sans quoi la machine devient
irrécupérable par l'outil qui l'a modifiée.

**Files:**
- Create: `src/lib/manifest.ts`
- Test: `test/lib/manifest.test.ts`
- Test: `test/lib/manifest-atomicity.test.ts`

**Interfaces:**
- Consumes: rien.
- Produces: les types `Manifest` et `StepRecord`, les fonctions pures `emptyManifest`,
  `recordStep`, `forgetStep`, `stepsInReverseOrder`, et les fonctions de fichier
  `defaultManifestPath`, `readManifest`, `writeManifest`. `src/commands/install.ts` et
  `src/commands/uninstall.ts` en dépendent.

- [ ] **Step 1: Écrire les tests qui échouent**

`test/lib/manifest.test.ts` :

```ts
import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptyManifest,
  recordStep,
  forgetStep,
  stepsInReverseOrder,
  readManifest,
  writeManifest,
  type Manifest,
} from "../../src/lib/manifest";

const T1 = "2026-08-22T10:00:00.000Z";
const T2 = "2026-08-22T10:00:01.000Z";
const T3 = "2026-08-22T10:00:02.000Z";

describe("fonctions pures", () => {
  test("un manifeste vide n'a aucune etape", () => {
    expect(stepsInReverseOrder(emptyManifest(T1))).toEqual([]);
  });

  test("recordStep conserve l'etat anterieur", () => {
    const m = recordStep(emptyManifest(T1), "network-mac", { mode: "dhcp" }, T2);
    expect(m.steps["network-mac"]).toEqual({
      step: "network-mac",
      appliedAt: T2,
      previous: { mode: "dhcp" },
    });
  });

  test("reappliquer une etape n'ecrase pas le premier etat anterieur", () => {
    // Sinon rejouer install apres install rendrait la restauration impossible :
    // le second enregistrement capturerait l'etat que hardline a lui-meme pose.
    const once = recordStep(emptyManifest(T1), "network-mac", { mode: "dhcp" }, T2);
    const twice = recordStep(once, "network-mac", { mode: "manual" }, T3);
    expect(twice.steps["network-mac"]?.previous).toEqual({ mode: "dhcp" });
  });

  test("forgetStep retire l'etape", () => {
    const m = recordStep(emptyManifest(T1), "network-mac", null, T2);
    expect(forgetStep(m, "network-mac").steps["network-mac"]).toBeUndefined();
  });

  test("stepsInReverseOrder rend les etapes de la plus recente a la plus ancienne", () => {
    let m = emptyManifest(T1);
    m = recordStep(m, "premiere", null, T1);
    m = recordStep(m, "seconde", null, T2);
    m = recordStep(m, "troisieme", null, T3);
    expect(stepsInReverseOrder(m).map((s) => s.step)).toEqual([
      "troisieme",
      "seconde",
      "premiere",
    ]);
  });
});

describe("persistance", () => {
  test("relire un manifeste ecrit rend le meme contenu", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardline-"));
    const path = join(dir, "nested", "manifest.json");
    try {
      const written = recordStep(emptyManifest(T1), "network-mac", { a: 1 }, T2);
      await writeManifest(path, written);
      expect(await readManifest(path)).toEqual(written);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("lire un manifeste absent rend un manifeste vide, sans erreur", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardline-"));
    try {
      const m: Manifest = await readManifest(join(dir, "absent.json"));
      expect(stepsInReverseOrder(m)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("aucun fichier temporaire ne survit a l'ecriture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardline-"));
    const path = join(dir, "manifest.json");
    try {
      await writeManifest(path, emptyManifest(T1));
      const { readdir } = await import("node:fs/promises");
      expect(await readdir(dir)).toEqual(["manifest.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

describe("robustesse a la lecture", () => {
  test("rejette un fichier qui n'est pas du JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardline-"));
    const path = join(dir, "manifest.json");
    try {
      await Bun.write(path, "{ ceci n'est pas du json");
      expect(readManifest(path)).rejects.toThrow(/illisible/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejette un JSON valide qui n'est pas un manifeste", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hardline-"));
    const path = join(dir, "manifest.json");
    try {
      await Bun.write(path, JSON.stringify({ hello: "world" }));
      expect(readManifest(path)).rejects.toThrow(/invalide/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejette un manifeste d'une version inconnue", async () => {
    // Une version future decrit un etat anterieur dont cette version du code
    // ignore la forme : restaurer a l'aveugle serait pire que refuser.
    const dir = await mkdtemp(join(tmpdir(), "hardline-"));
    const path = join(dir, "manifest.json");
    try {
      await Bun.write(path, JSON.stringify({ ...emptyManifest(T1), version: 2 }));
      expect(readManifest(path)).rejects.toThrow(/invalide/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 1b: Écrire le test d'atomicité, dans son propre fichier**

L'atomicité ne vient pas de l'écriture mais du `rename`. Un test comportemental — des
lectures concurrentes pendant l'écriture d'un gros manifeste — a été essayé et s'est
révélé **non discriminant** : une implémentation en `Bun.write` direct le passait tout
aussi bien, l'écriture étant trop rapide pour qu'une lecture attrape un état
intermédiaire. Un test qui ne peut pas échouer est pire qu'absent.

Ce test vérifie donc le mécanisme lui-même, et il est déterministe. Il vit dans un
fichier séparé parce que son remplacement de `node:fs/promises` casserait les écritures
réelles des autres tests.

`test/lib/manifest-atomicity.test.ts` :

```ts
import { test, expect, mock } from "bun:test";

const calls: string[] = [];

mock.module("node:fs/promises", () => ({
  mkdir: async () => undefined,
  writeFile: async (path: string) => {
    calls.push(`writeFile:${path}`);
  },
  rename: async (from: string, to: string) => {
    calls.push(`rename:${from} -> ${to}`);
  },
}));

const { writeManifest, emptyManifest } = await import("../../src/lib/manifest");

const TARGET = "/tmp/hardline-atomicity/manifest.json";

test("l'ecriture passe par un fichier temporaire puis un rename", async () => {
  calls.length = 0;
  await writeManifest(TARGET, emptyManifest("2026-08-22T10:00:00.000Z"));

  expect(calls).toHaveLength(2);
  const [written, renamed] = calls;

  // Le contenu n'est jamais ecrit directement sur le chemin final : c'est ce
  // qui garantit qu'une interruption ne laisse pas un manifeste tronque.
  expect(written).not.toBe(`writeFile:${TARGET}`);
  expect(written).toContain(`writeFile:${TARGET}.`);
  expect(written).toContain(".tmp");

  // Et c'est le rename, atomique sur un meme volume, qui publie le fichier.
  expect(renamed).toContain(`-> ${TARGET}`);
});

test("le fichier temporaire est distinct du fichier final", async () => {
  calls.length = 0;
  await writeManifest(TARGET, emptyManifest("2026-08-22T10:00:00.000Z"));

  const source = calls[1]?.split(" -> ")[0]?.replace("rename:", "");
  expect(source).not.toBe(TARGET);
  expect(source?.startsWith(TARGET)).toBe(true);
});
```

- [ ] **Step 2: Lancer les tests et vérifier qu'ils échouent**

Run: `bun test --isolate test/lib/manifest.test.ts test/lib/manifest-atomicity.test.ts`
Expected: FAIL — le module `../../src/lib/manifest` n'existe pas.

- [ ] **Step 3: Écrire l'implémentation**

`src/lib/manifest.ts` :

```ts
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type StepRecord = {
  step: string;
  appliedAt: string;
  previous: unknown;
};

export type Manifest = {
  version: 1;
  createdAt: string;
  updatedAt: string;
  order: string[];
  steps: Record<string, StepRecord>;
};

export function defaultManifestPath(): string {
  return join(homedir(), ".config", "hardline", "manifest.json");
}

export function emptyManifest(now: string): Manifest {
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    order: [],
    steps: {},
  };
}

/**
 * Enregistre une etape appliquee. Si l'etape est deja connue, l'etat anterieur
 * d'origine est conserve : rejouer install ne doit jamais faire oublier a
 * hardline ce qu'il a trouve la premiere fois.
 */
export function recordStep(
  manifest: Manifest,
  step: string,
  previous: unknown,
  now: string,
): Manifest {
  const existing = manifest.steps[step];

  return {
    ...manifest,
    updatedAt: now,
    order: existing ? manifest.order : [...manifest.order, step],
    steps: {
      ...manifest.steps,
      [step]: existing ?? { step, appliedAt: now, previous },
    },
  };
}

export function forgetStep(manifest: Manifest, step: string): Manifest {
  const { [step]: _removed, ...rest } = manifest.steps;
  return {
    ...manifest,
    order: manifest.order.filter((s) => s !== step),
    steps: rest,
  };
}

export function stepsInReverseOrder(manifest: Manifest): StepRecord[] {
  return [...manifest.order]
    .reverse()
    .map((name) => manifest.steps[name])
    .filter((r): r is StepRecord => r !== undefined);
}

// --- Frontière fichier. ---

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate["version"] === 1 &&
    Array.isArray(candidate["order"]) &&
    typeof candidate["steps"] === "object" &&
    candidate["steps"] !== null
  );
}

export async function readManifest(path: string): Promise<Manifest> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return emptyManifest(new Date().toISOString());
  }

  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    throw new Error(
      `Manifeste illisible : ${path} n'est pas un JSON valide. Ne pas le supprimer sans l'inspecter, il decrit ce que hardline a modifie sur les deux machines.`,
    );
  }

  // Un cast sans verification laisserait la desinstallation restaurer des
  // valeurs dont elle ignore la forme. Mieux vaut refuser franchement.
  if (!isManifest(parsed)) {
    throw new Error(
      `Manifeste invalide : ${path} ne correspond pas au format attendu (version 1).`,
    );
  }

  return parsed;
}

/**
 * Ecriture atomique : Bun.write ne l'est pas, et le manifeste est precisement
 * ce dont depend la desinstallation. On ecrit a cote puis on renomme, rename
 * etant atomique sur un meme volume.
 */
export async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest, null, 2), "utf8");
  await rename(temporary, path);
}
```

- [ ] **Step 4: Lancer les tests et vérifier qu'ils passent**

Run: `bun test --isolate test/lib/manifest.test.ts test/lib/manifest-atomicity.test.ts`
Expected: PASS, treize tests — onze dans le premier fichier, deux dans le second.

- [ ] **Step 5: Commit**

```bash
git add src/lib/manifest.ts test/lib/manifest.test.ts test/lib/manifest-atomicity.test.ts
git commit -m "feat: manifeste d'etat avec ecriture atomique"
```

---
### Task 5: Contrat des étapes, configuration, et adresse fixe côté Mac

Cette tâche pose le contrat que toutes les étapes suivantes respecteront, et l'applique
immédiatement au premier cas réel. Le contrat tient en trois verbes : `inspect`
constate sans rien modifier, `apply` corrige l'écart, `restore` remet l'état antérieur.
Aucune étape n'affiche quoi que ce soit — c'est l'orchestrateur qui rend compte, ce qui
permet de tester la logique de convergence sans toucher au terminal.

**Files:**
- Create: `src/config.ts`
- Create: `src/steps/types.ts`
- Create: `src/steps/network-mac.ts`
- Test: `test/steps/network-mac.test.ts`

**Interfaces:**
- Consumes: `getServiceInfo`, `setServiceManualIP`, `setServiceDHCP` et le type
  `ServiceIPConfig` de `src/lib/shell.ts` (Task 2).
- Produces: le type générique `Step<P>`, le type `Config` et la constante `CONFIG`, et
  l'étape `macNetworkStep`. Toutes les étapes ultérieures implémentent `Step<P>` ;
  `install`, `uninstall` et `doctor` consomment `CONFIG`.

- [ ] **Step 1: Écrire la configuration et le contrat**

`src/config.ts` :

```ts
import { homedir } from "node:os";
import { join } from "node:path";
import type { SSHTarget } from "./lib/ssh";

export type Config = {
  mac: { serviceName: string; ip: string; subnetMask: string };
  windows: { interfaceAlias: string; ip: string; prefixLength: number };
  ssh: SSHTarget;
  bootstrapPort: number;
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
};
```

`src/steps/types.ts` :

```ts
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
```

- [ ] **Step 2: Écrire les tests qui échouent**

`test/steps/network-mac.test.ts` :

```ts
import { test, expect, describe, mock, beforeEach } from "bun:test";
import type { ServiceIPConfig } from "../../src/lib/shell";
import { CONFIG } from "../../src/config";

let currentInfo: ServiceIPConfig;
const setManual = mock(async (..._args: unknown[]) => 0);
const setDhcp = mock(async (..._args: unknown[]) => 0);

mock.module("../../src/lib/shell", () => ({
  getServiceInfo: async () => currentInfo,
  setServiceManualIP: setManual,
  setServiceDHCP: setDhcp,
}));

const { macNetworkStep } = await import("../../src/steps/network-mac");

beforeEach(() => {
  setManual.mockClear();
  setDhcp.mockClear();
});

describe("inspect", () => {
  test("declare conforme quand l'adresse cible est deja posee", async () => {
    currentInfo = {
      mode: "manual",
      ip: "10.10.10.2",
      subnetMask: "255.255.255.0",
      router: null,
    };
    const state = await macNetworkStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
  });

  test("declare non conforme quand le service est en DHCP", async () => {
    currentInfo = {
      mode: "dhcp",
      ip: "169.254.168.226",
      subnetMask: "255.255.0.0",
      router: null,
    };
    const state = await macNetworkStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current.mode).toBe("dhcp");
  });

  test("declare non conforme quand l'adresse manuelle est la mauvaise", async () => {
    currentInfo = {
      mode: "manual",
      ip: "10.10.10.9",
      subnetMask: "255.255.255.0",
      router: null,
    };
    expect((await macNetworkStep.inspect(CONFIG)).conforming).toBe(false);
  });

  test("declare non conforme quand une passerelle est definie", async () => {
    // Une passerelle sur ce lien detournerait la route par defaut de macOS.
    currentInfo = {
      mode: "manual",
      ip: "10.10.10.2",
      subnetMask: "255.255.255.0",
      router: "10.10.10.1",
    };
    expect((await macNetworkStep.inspect(CONFIG)).conforming).toBe(false);
  });
});

describe("apply", () => {
  test("pose l'adresse cible sans passerelle", async () => {
    await macNetworkStep.apply(CONFIG);
    expect(setManual).toHaveBeenCalledTimes(1);
    expect(setManual).toHaveBeenCalledWith("AX88179A", "10.10.10.2", "255.255.255.0");
  });
});

describe("restore", () => {
  test("remet le service en DHCP si c'est ce qu'il etait", async () => {
    await macNetworkStep.restore(CONFIG, {
      mode: "dhcp",
      ip: null,
      subnetMask: null,
      router: null,
    });
    expect(setDhcp).toHaveBeenCalledTimes(1);
    expect(setManual).not.toHaveBeenCalled();
  });

  test("remet l'adresse manuelle d'origine si c'est ce qu'elle etait", async () => {
    await macNetworkStep.restore(CONFIG, {
      mode: "manual",
      ip: "192.168.5.5",
      subnetMask: "255.255.255.0",
      router: null,
    });
    expect(setManual).toHaveBeenCalledWith("AX88179A", "192.168.5.5", "255.255.255.0");
  });

  test("retombe sur DHCP si l'etat anterieur etait sans adresse", async () => {
    await macNetworkStep.restore(CONFIG, {
      mode: "off",
      ip: null,
      subnetMask: null,
      router: null,
    });
    expect(setDhcp).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Lancer les tests et vérifier qu'ils échouent**

Run: `bun test --isolate test/steps/network-mac.test.ts`
Expected: FAIL — le module `../../src/steps/network-mac` n'existe pas.

- [ ] **Step 4: Écrire l'implémentation**

`src/steps/network-mac.ts` :

```ts
import {
  getServiceInfo,
  setServiceDHCP,
  setServiceManualIP,
  type ServiceIPConfig,
} from "../lib/shell";
import type { Config } from "../config";
import type { Step } from "./types";

export const macNetworkStep: Step<ServiceIPConfig> = {
  name: "network-mac",
  label: "Adresse fixe sur le lien direct (Mac)",

  async inspect(config: Config) {
    const current = await getServiceInfo(config.mac.serviceName);

    const conforming =
      current.mode === "manual" &&
      current.ip === config.mac.ip &&
      current.subnetMask === config.mac.subnetMask &&
      current.router === null;

    return {
      conforming,
      current,
      detail: conforming
        ? `${config.mac.serviceName} deja en ${config.mac.ip}`
        : `${config.mac.serviceName} en ${current.mode}${current.ip ? ` (${current.ip})` : ""}`,
    };
  },

  async apply(config: Config) {
    await setServiceManualIP(
      config.mac.serviceName,
      config.mac.ip,
      config.mac.subnetMask,
    );
  },

  async restore(config: Config, previous: ServiceIPConfig) {
    if (previous.mode === "manual" && previous.ip && previous.subnetMask) {
      await setServiceManualIP(
        config.mac.serviceName,
        previous.ip,
        previous.subnetMask,
      );
      return;
    }
    // DHCP comme dans le cas "off" : c'est l'etat par defaut d'un service macOS,
    // et le seul qui ne laisse pas une adresse morte derriere lui.
    await setServiceDHCP(config.mac.serviceName);
  },
};
```

- [ ] **Step 5: Lancer les tests et vérifier qu'ils passent**

Run: `bun test --isolate test/steps/network-mac.test.ts`
Expected: PASS, huit tests.

- [ ] **Step 6: Lancer la suite complète pour vérifier l'absence de régression**

Run: `bun test --isolate`
Expected: PASS, tous les tests des tâches 1 à 5.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/steps/types.ts src/steps/network-mac.ts test/steps/network-mac.test.ts
git commit -m "feat: contrat des etapes et adresse fixe cote Mac"
```

---
### Task 6: Adresse fixe et profil réseau privé côté Windows

Même contrat que la tâche précédente, appliqué de l'autre côté du tunnel SSH. Le point
délicat est le profil réseau : Windows classe par défaut un nouveau lien en *public*, ce
qui referme le pare-feu et rend la machine muette sans le moindre message d'erreur.
C'est la panne qui a été rencontrée pendant l'exploration, et elle doit être traitée
comme un état à faire converger, pas comme un réglage posé une fois.

**Files:**
- Create: `src/steps/network-windows.ts`
- Test: `test/steps/network-windows.test.ts`

**Interfaces:**
- Consumes: `runRemote`, `runRemoteJson` de `src/lib/ssh.ts` (Task 3) ; `Step` de
  `src/steps/types.ts` (Task 5).
- Produces: le type `WindowsNetworkState` et l'étape `windowsNetworkStep`.

- [ ] **Step 1: Écrire les tests qui échouent**

`test/steps/network-windows.test.ts` :

```ts
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";

let remoteState: unknown[];
const runRemote = mock(async (..._args: unknown[]) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../../src/lib/ssh", () => ({
  runRemoteJson: async () => remoteState,
  runRemote,
}));

const { windowsNetworkStep } = await import("../../src/steps/network-windows");

beforeEach(() => runRemote.mockClear());

describe("inspect", () => {
  test("declare conforme quand adresse et profil sont corrects", async () => {
    remoteState = [
      {
        adapterPresent: true,
        adapterStatus: "Up",
        addresses: ["10.10.10.1/24"],
        category: "Private",
      },
    ];
    const state = await windowsNetworkStep.inspect(CONFIG);
    expect(state.conforming).toBe(true);
  });

  test("declare non conforme quand le profil est public", async () => {
    // Cas le plus important : l'adresse est bonne mais le pare-feu est ferme.
    remoteState = [
      {
        adapterPresent: true,
        adapterStatus: "Up",
        addresses: ["10.10.10.1/24"],
        category: "Public",
      },
    ];
    expect((await windowsNetworkStep.inspect(CONFIG)).conforming).toBe(false);
  });

  test("declare non conforme quand l'adresse cible est absente", async () => {
    remoteState = [
      {
        adapterPresent: true,
        adapterStatus: "Up",
        addresses: ["169.254.168.1/16"],
        category: "Private",
      },
    ];
    expect((await windowsNetworkStep.inspect(CONFIG)).conforming).toBe(false);
  });

  test("tolere des adresses supplementaires si la cible est presente", async () => {
    remoteState = [
      {
        adapterPresent: true,
        adapterStatus: "Up",
        addresses: ["169.254.168.1/16", "10.10.10.1/24"],
        category: "Private",
      },
    ];
    expect((await windowsNetworkStep.inspect(CONFIG)).conforming).toBe(true);
  });

  test("echoue explicitement si l'interface n'existe pas", async () => {
    remoteState = [
      {
        adapterPresent: false,
        adapterStatus: null,
        addresses: [],
        category: null,
      },
    ];
    expect(windowsNetworkStep.inspect(CONFIG)).rejects.toThrow(/Ethernet/);
  });

  test("echoue explicitement si le PC ne repond rien", async () => {
    remoteState = [];
    expect(windowsNetworkStep.inspect(CONFIG)).rejects.toThrow();
  });
});

describe("apply", () => {
  test("envoie un script qui pose l'adresse et bascule le profil", async () => {
    await windowsNetworkStep.apply(CONFIG);
    expect(runRemote).toHaveBeenCalledTimes(1);
    const script = String((runRemote.mock.calls[0] as unknown[])[1]);
    expect(script).toContain("New-NetIPAddress");
    expect(script).toContain("10.10.10.1");
    expect(script).toContain("Set-NetConnectionProfile");
    expect(script).toContain("Private");
  });
});

describe("restore", () => {
  test("remet l'interface en DHCP et restitue la categorie d'origine", async () => {
    await windowsNetworkStep.restore(CONFIG, {
      adapterPresent: true,
      adapterStatus: "Up",
      addresses: [],
      category: "Public",
    });
    const script = String((runRemote.mock.calls[0] as unknown[])[1]);
    expect(script).toContain("Dhcp Enabled");
    expect(script).toContain("Public");
  });

  test("ne tente pas de restituer une categorie inconnue", async () => {
    await windowsNetworkStep.restore(CONFIG, {
      adapterPresent: true,
      adapterStatus: "Up",
      addresses: [],
      category: null,
    });
    const script = String((runRemote.mock.calls[0] as unknown[])[1]);
    expect(script).not.toContain("Set-NetConnectionProfile");
  });
});
```

- [ ] **Step 2: Lancer les tests et vérifier qu'ils échouent**

Run: `bun test --isolate test/steps/network-windows.test.ts`
Expected: FAIL — le module `../../src/steps/network-windows` n'existe pas.

- [ ] **Step 3: Écrire l'implémentation**

`src/steps/network-windows.ts` :

```ts
import { runRemote, runRemoteJson } from "../lib/ssh";
import type { Config } from "../config";
import type { Step } from "./types";

export type WindowsNetworkState = {
  adapterPresent: boolean;
  adapterStatus: string | null;
  addresses: string[];
  category: "Public" | "Private" | "DomainAuthenticated" | null;
};

const INSPECT = (alias: string) => `
$adapter = Get-NetAdapter -Name '${alias}' -ErrorAction SilentlyContinue
$addresses = Get-NetIPAddress -InterfaceAlias '${alias}' -AddressFamily IPv4 -ErrorAction SilentlyContinue
$profile = Get-NetConnectionProfile -InterfaceAlias '${alias}' -ErrorAction SilentlyContinue
[pscustomobject]@{
  adapterPresent = [bool]$adapter
  adapterStatus  = if ($adapter) { [string]$adapter.Status } else { $null }
  addresses      = @($addresses | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })
  category       = if ($profile) { [string]$profile.NetworkCategory } else { $null }
}`;

const APPLY = (alias: string, ip: string, prefix: number) => `
Get-NetIPAddress -InterfaceAlias '${alias}' -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
New-NetIPAddress -InterfaceAlias '${alias}' -IPAddress '${ip}' -PrefixLength ${prefix} | Out-Null
Set-NetConnectionProfile -InterfaceAlias '${alias}' -NetworkCategory Private`;

const RESTORE = (alias: string, category: string | null) => `
Get-NetIPAddress -InterfaceAlias '${alias}' -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
Set-NetIPInterface -InterfaceAlias '${alias}' -Dhcp Enabled -ErrorAction SilentlyContinue
${category ? `Set-NetConnectionProfile -InterfaceAlias '${alias}' -NetworkCategory ${category} -ErrorAction SilentlyContinue` : ""}`;

export const windowsNetworkStep: Step<WindowsNetworkState> = {
  name: "network-windows",
  label: "Adresse fixe et profil prive sur le lien direct (PC)",

  async inspect(config: Config) {
    const rows = await runRemoteJson<WindowsNetworkState>(
      config.ssh,
      INSPECT(config.windows.interfaceAlias),
    );
    const current = rows[0];

    if (!current) {
      throw new Error(
        "Le PC n'a renvoye aucun etat reseau. Verifier la liaison SSH.",
      );
    }
    if (!current.adapterPresent) {
      throw new Error(
        `L'interface "${config.windows.interfaceAlias}" n'existe pas sur le PC. Verifier le nom ou le branchement du cable.`,
      );
    }

    const target = `${config.windows.ip}/${config.windows.prefixLength}`;
    const hasAddress = current.addresses.includes(target);
    const isPrivate = current.category === "Private";
    const conforming = hasAddress && isPrivate;

    return {
      conforming,
      current,
      detail: conforming
        ? `${config.windows.interfaceAlias} deja en ${target}, profil prive`
        : `adresse ${hasAddress ? "correcte" : "absente"}, profil ${current.category ?? "inconnu"}`,
    };
  },

  async apply(config: Config) {
    await runRemote(
      config.ssh,
      APPLY(
        config.windows.interfaceAlias,
        config.windows.ip,
        config.windows.prefixLength,
      ),
    );
  },

  async restore(config: Config, previous: WindowsNetworkState) {
    await runRemote(
      config.ssh,
      RESTORE(config.windows.interfaceAlias, previous.category),
    );
  },
};
```

- [ ] **Step 4: Lancer les tests et vérifier qu'ils passent**

Run: `bun test --isolate test/steps/network-windows.test.ts`
Expected: PASS, neuf tests.

- [ ] **Step 5: Vérifier `inspect` contre le vrai PC**

`inspect` ne modifie rien, il est sans risque à exécuter.

Run: `bun -e 'import {windowsNetworkStep} from "./src/steps/network-windows"; import {CONFIG} from "./src/config"; console.log(await windowsNetworkStep.inspect({...CONFIG, ssh:{...CONFIG.ssh, host:"192.168.1.48"}}))'`
Expected: un objet décrivant l'état réel de l'interface `Ethernet` du PC.

- [ ] **Step 6: Commit**

```bash
git add src/steps/network-windows.ts test/steps/network-windows.test.ts
git commit -m "feat: adresse fixe et profil prive cote Windows"
```

---
### Task 6b: Persistance du profil réseau au redémarrage

Sans cette tâche, tout le reste se dégrade silencieusement. Windows reclasse le lien en
réseau public au rebranchement du câble ou après certaines mises à jour, ce qui referme
le pare-feu. La liaison cesse alors de fonctionner sans le moindre message, et rien dans
l'interface ne suggère la cause. Une tâche planifiée au démarrage rétablit le profil.

Le déclenchement au démarrage seul ne suffit pas : l'interface n'est pas toujours prête
quand la tâche s'exécute, et `Set-NetConnectionProfile` échoue tant qu'aucun profil
n'existe pour l'interface. Le script attend donc que le profil apparaisse, avec une
limite de temps.

**Files:**
- Create: `src/steps/network-profile-task.ts`
- Create: `src/steps/index.ts` — registre ordonné des étapes
- Test: `test/steps/network-profile-task.test.ts`

**Interfaces:**
- Consumes: `runRemote`, `runRemoteJson` de `src/lib/ssh.ts` (Task 3) ; `Step` de
  `src/steps/types.ts` (Task 5).
- Produces: le type `ScheduledTaskState` et l'étape `windowsProfileTaskStep`.

- [ ] **Step 1: Écrire les tests qui échouent**

`test/steps/network-profile-task.test.ts` :

```ts
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { CONFIG } from "../../src/config";

let remoteState: unknown[];
const runRemote = mock(async (..._args: unknown[]) => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../../src/lib/ssh", () => ({
  runRemoteJson: async () => remoteState,
  runRemote,
}));

const { windowsProfileTaskStep, TASK_NAME } = await import(
  "../../src/steps/network-profile-task"
);

beforeEach(() => runRemote.mockClear());

describe("inspect", () => {
  test("declare conforme quand la tache existe et est active", async () => {
    remoteState = [{ present: true, state: "Ready" }];
    expect((await windowsProfileTaskStep.inspect(CONFIG)).conforming).toBe(true);
  });

  test("declare non conforme quand la tache est absente", async () => {
    remoteState = [{ present: false, state: null }];
    const state = await windowsProfileTaskStep.inspect(CONFIG);
    expect(state.conforming).toBe(false);
    expect(state.current.present).toBe(false);
  });

  test("declare non conforme quand la tache existe mais est desactivee", async () => {
    remoteState = [{ present: true, state: "Disabled" }];
    expect((await windowsProfileTaskStep.inspect(CONFIG)).conforming).toBe(false);
  });
});

describe("apply", () => {
  test("enregistre une tache au demarrage executee en SYSTEM", async () => {
    await windowsProfileTaskStep.apply(CONFIG);
    const script = String((runRemote.mock.calls[0] as unknown[])[1]);
    expect(script).toContain("Register-ScheduledTask");
    expect(script).toContain(TASK_NAME);
    expect(script).toContain("AtStartup");
    expect(script).toContain("SYSTEM");
  });

  test("le script planifie attend que le profil d'interface existe", async () => {
    // Au demarrage, l'interface n'est pas prete immediatement :
    // sans attente, Set-NetConnectionProfile echoue et la tache ne sert a rien.
    await windowsProfileTaskStep.apply(CONFIG);
    const script = String((runRemote.mock.calls[0] as unknown[])[1]);
    expect(script).toContain("Get-NetConnectionProfile");
    expect(script).toMatch(/while|for|Start-Sleep/);
  });

  test("le script planifie vise la seule interface du lien direct", async () => {
    await windowsProfileTaskStep.apply(CONFIG);
    const script = String((runRemote.mock.calls[0] as unknown[])[1]);
    expect(script).toContain(CONFIG.windows.interfaceAlias);
  });
});

describe("restore", () => {
  test("supprime la tache si hardline l'avait creee", async () => {
    await windowsProfileTaskStep.restore(CONFIG, { present: false, state: null });
    const script = String((runRemote.mock.calls[0] as unknown[])[1]);
    expect(script).toContain("Unregister-ScheduledTask");
  });

  test("ne supprime rien si une tache de ce nom preexistait", async () => {
    await windowsProfileTaskStep.restore(CONFIG, { present: true, state: "Ready" });
    expect(runRemote).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Lancer les tests et vérifier qu'ils échouent**

Run: `bun test --isolate test/steps/network-profile-task.test.ts`
Expected: FAIL — le module n'existe pas.

- [ ] **Step 3: Écrire l'implémentation**

`src/steps/network-profile-task.ts` :

```ts
import { runRemote, runRemoteJson } from "../lib/ssh";
import type { Config } from "../config";
import type { Step } from "./types";

export const TASK_NAME = "hardline-network-profile";

export type ScheduledTaskState = {
  present: boolean;
  state: string | null;
};

const INSPECT = `
$task = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue
[pscustomobject]@{
  present = [bool]$task
  state   = if ($task) { [string]$task.State } else { $null }
}`;

/**
 * Le script execute au demarrage. Il attend l'apparition du profil reseau
 * plutot que de supposer l'interface prete : au demarrage elle ne l'est pas.
 */
const SCHEDULED_SCRIPT = (alias: string) =>
  [
    "$deadline = (Get-Date).AddMinutes(3)",
    "while ((Get-Date) -lt $deadline) {",
    `  $p = Get-NetConnectionProfile -InterfaceAlias '${alias}' -ErrorAction SilentlyContinue`,
    "  if ($p) {",
    "    if ($p.NetworkCategory -ne 'Private') {",
    `      Set-NetConnectionProfile -InterfaceAlias '${alias}' -NetworkCategory Private`,
    "    }",
    "    break",
    "  }",
    "  Start-Sleep -Seconds 5",
    "}",
  ].join("; ");

const APPLY = (alias: string) => `
$inner = @'
${SCHEDULED_SCRIPT(alias)}
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
$action = New-ScheduledTaskAction -Execute 'powershell.exe' \`
  -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand $encoded"
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger \`
  -Principal $principal -Settings $settings -Force | Out-Null`;

const RESTORE = `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`;

export const windowsProfileTaskStep: Step<ScheduledTaskState> = {
  name: "network-profile-task",
  label: "Maintien du profil prive au demarrage (PC)",

  async inspect(config: Config) {
    const rows = await runRemoteJson<ScheduledTaskState>(config.ssh, INSPECT);
    const current = rows[0];

    if (!current) {
      throw new Error("Le PC n'a renvoye aucun etat de tache planifiee.");
    }

    const conforming = current.present && current.state !== "Disabled";

    return {
      conforming,
      current,
      detail: conforming
        ? `tache "${TASK_NAME}" active`
        : current.present
          ? `tache "${TASK_NAME}" en etat ${current.state}`
          : "tache absente",
    };
  },

  async apply(config: Config) {
    await runRemote(config.ssh, APPLY(config.windows.interfaceAlias));
  },

  async restore(config: Config, previous: ScheduledTaskState) {
    // Si une tache de ce nom existait avant hardline, on n'y touche pas.
    if (previous.present) return;
    await runRemote(config.ssh, RESTORE);
  },
};
```

- [ ] **Step 4: Lancer les tests et vérifier qu'ils passent**

Run: `bun test --isolate test/steps/network-profile-task.test.ts`
Expected: PASS, huit tests.

- [ ] **Step 5: Créer le registre des étapes**

`src/steps/index.ts` — ce fichier n'existe pas encore, c'est cette tâche qui le crée :

```ts
import { windowsProfileTaskStep } from "./network-profile-task";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_STEPS: Step<any>[] = [
  macNetworkStep,
  windowsNetworkStep,
  windowsProfileTaskStep,
];
```

L'ordre importe : la tâche planifiée vient après l'adresse, car elle n'a de sens qu'une
fois l'interface configurée.

- [ ] **Step 6: Vérifier la tâche sur le vrai PC**

Run: `bun -e 'import {windowsProfileTaskStep} from "./src/steps/network-profile-task"; import {CONFIG} from "./src/config"; const c = {...CONFIG, ssh:{...CONFIG.ssh, host:"192.168.1.48"}}; await windowsProfileTaskStep.apply(c); console.log(await windowsProfileTaskStep.inspect(c))'`
Expected: `conforming: true`.

Vérifier ensuite que le script planifié est correct en le déclenchant à la main :

Run: `ssh -i ~/.ssh/id_ed25519_winpc arthur@192.168.1.48 'powershell -NoProfile -Command "Start-ScheduledTask -TaskName hardline-network-profile; Start-Sleep 10; (Get-ScheduledTaskInfo -TaskName hardline-network-profile).LastTaskResult"'`
Expected: `0`, code de succès.

- [ ] **Step 7: Commit**

```bash
git add src/steps/network-profile-task.ts src/steps/index.ts test/steps/network-profile-task.test.ts
git commit -m "feat: maintien du profil reseau prive au redemarrage"
```

---

### Task 7: Couche d'affichage

Clack n'est importé que par ce module. Le reste du programme parle à `ui`, ce qui rend
les commandes testables sans terminal et permet de concentrer ici trois pièges
documentés de la bibliothèque.

Premier piège : le spinner ne teste que la variable d'environnement `CI`, jamais si la
sortie est un terminal. Rediriger la sortie vers un fichier sans avoir positionné `CI`
remplit ce fichier de séquences d'échappement. On force donc `CI=true` dès qu'on
détecte l'absence de terminal.

Deuxième piège : `tasks()`, l'API qui semblait faite pour enchaîner des étapes, saute
une tâche désactivée **sans rien afficher**. Comme il faut justement rendre visible le
cas « déjà conforme », on ne l'utilise pas : une boucle explicite donne les trois états.

Troisième piège, le plus grave, déjà répercuté dans la spec : Ctrl+C pendant un spinner
termine le processus immédiatement, sans exécuter le moindre traitement asynchrone de
rattrapage.

**Files:**
- Create: `src/lib/ui.ts`
- Test: `test/lib/ui.test.ts`

**Interfaces:**
- Consumes: `@clack/prompts`.
- Produces: `isInteractive`, `configureOutput`, l'objet `ui`, `withSpinner`, et
  `confirmOrExit`. Les quatre commandes en dépendent.

- [ ] **Step 1: Écrire les tests qui échouent**

`test/lib/ui.test.ts` :

```ts
import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";

const calls: string[] = [];
const spinnerStop = mock((m?: string) => calls.push(`stop:${m}`));
const spinnerError = mock((m?: string) => calls.push(`error:${m}`));

mock.module("@clack/prompts", () => ({
  intro: (m: string) => calls.push(`intro:${m}`),
  outro: (m: string) => calls.push(`outro:${m}`),
  note: (m: string, t?: string) => calls.push(`note:${t}:${m}`),
  cancel: (m: string) => calls.push(`cancel:${m}`),
  isCancel: (v: unknown) => typeof v === "symbol",
  confirm: async () => true,
  log: {
    step: (m: string) => calls.push(`step:${m}`),
    success: (m: string) => calls.push(`success:${m}`),
    error: (m: string) => calls.push(`error:${m}`),
    info: (m: string) => calls.push(`info:${m}`),
    warn: (m: string) => calls.push(`warn:${m}`),
  },
  spinner: () => ({
    start: (m?: string) => calls.push(`start:${m}`),
    message: (m?: string) => calls.push(`message:${m}`),
    stop: spinnerStop,
    error: spinnerError,
  }),
}));

const { configureOutput, ui, withSpinner } = await import("../../src/lib/ui");

const savedCI = process.env.CI;
beforeEach(() => {
  calls.length = 0;
  delete process.env.CI;
});
afterEach(() => {
  if (savedCI === undefined) delete process.env.CI;
  else process.env.CI = savedCI;
});

describe("configureOutput", () => {
  test("force CI hors terminal, pour ne pas polluer une sortie redirigee", () => {
    configureOutput(false);
    expect(process.env.CI).toBe("true");
  });

  test("ne touche a rien dans un terminal", () => {
    configureOutput(true);
    expect(process.env.CI).toBeUndefined();
  });
});

describe("statuts d'etape", () => {
  test("une etape deja conforme est visible, pas silencieuse", () => {
    ui.skipped({ label: "Adresse Mac", detail: "deja en 10.10.10.2" });
    expect(calls[0]).toContain("step:");
    expect(calls[0]).toContain("Adresse Mac");
    expect(calls[0]).toContain("deja");
  });

  test("une etape appliquee est distinguee d'une etape sautee", () => {
    ui.applied({ label: "Adresse Mac", detail: "posee" });
    expect(calls[0]).toContain("success:");
  });

  test("une etape en echec passe par le canal d'erreur", () => {
    ui.failed({ label: "Adresse Mac", detail: "sudo refuse" });
    expect(calls[0]).toContain("error:");
  });
});

describe("withSpinner", () => {
  test("arrete le spinner et rend la valeur en cas de succes", async () => {
    const value = await withSpinner("Attente du lien", async () => 42);
    expect(value).toBe(42);
    expect(spinnerStop).toHaveBeenCalledTimes(1);
    expect(spinnerError).not.toHaveBeenCalled();
  });

  test("bascule le spinner en erreur et propage l'exception", async () => {
    const boom = withSpinner("Attente du lien", async () => {
      throw new Error("cable debranche");
    });
    expect(boom).rejects.toThrow("cable debranche");
    await boom.catch(() => {});
    expect(spinnerError).toHaveBeenCalledTimes(1);
  });

  test("transmet un rapporteur de progression", async () => {
    await withSpinner("Installation", async (progress) => {
      progress("telechargement");
      progress("configuration");
    });
    expect(calls).toContain("message:telechargement");
    expect(calls).toContain("message:configuration");
  });
});

describe("report", () => {
  test("rend un bloc multi-lignes titre", () => {
    ui.report("Diagnostic", ["Latence : 1.04 ms", "Adresse PC : 10.10.10.1"]);
    expect(calls[0]).toContain("note:Diagnostic:");
    expect(calls[0]).toContain("Latence");
    expect(calls[0]).toContain("Adresse PC");
  });
});
```

- [ ] **Step 2: Lancer les tests et vérifier qu'ils échouent**

Run: `bun test --isolate test/lib/ui.test.ts`
Expected: FAIL — le module `../../src/lib/ui` n'existe pas.

- [ ] **Step 3: Écrire l'implémentation**

`src/lib/ui.ts` :

```ts
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
```

- [ ] **Step 4: Lancer les tests et vérifier qu'ils passent**

Run: `bun test --isolate test/lib/ui.test.ts`
Expected: PASS, neuf tests.

- [ ] **Step 5: Vérifier le rendu à l'œil**

Run: `bun -e 'import {ui,withSpinner} from "./src/lib/ui"; ui.start("hardline"); ui.skipped({label:"Adresse Mac",detail:"deja en 10.10.10.2"}); await withSpinner("Attente du lien", async (p) => { p("negociation"); await Bun.sleep(800); }); ui.report("Diagnostic",["Latence : 1.04 ms","Perte : 0 %"]); ui.finish("Termine.")'`
Expected: un encadré d'ouverture, une ligne « déjà conforme », un indicateur animé qui
se fige en une ligne unique, un bloc encadré, une conclusion. Les accents doivent
s'afficher correctement.

- [ ] **Step 6: Vérifier la dégradation hors terminal**

Run: `bun -e 'import {configureOutput,ui,withSpinner} from "./src/lib/ui"; configureOutput(); ui.start("hardline"); await withSpinner("Etape", async () => {}); ui.finish("ok")' > /tmp/hardline-out.txt; cat -v /tmp/hardline-out.txt | head -20`
Expected: du texte lisible, **sans séquences `^[[` de déplacement de curseur**. C'est la
validation du forçage de `CI`.

- [ ] **Step 7: Vérifier la stabilité des invites sous Bun**

Clack a un historique de blocages de l'entrée standard sous Bun lorsque plusieurs
invites s'enchaînent. Ce test manuel doit être fait une fois, maintenant, pas au moment
de livrer.

Run: `bun -e 'import {confirm,text,isCancel} from "@clack/prompts"; const a = await confirm({message:"Premiere question ?"}); const b = await text({message:"Deuxieme question"}); console.log({a,b,cancelled:isCancel(a)||isCancel(b)})'`
Expected: les deux invites répondent l'une après l'autre sans blocage. Si la seconde ne
rend pas la main, signaler le problème avant d'aller plus loin : tout le reste du plan
suppose que les invites fonctionnent.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ui.ts test/lib/ui.test.ts
git commit -m "feat: couche d'affichage isolant Clack et ses pieges"
```

---
### Task 8: Vérification des préconditions

Rien ne doit être modifié avant que les deux machines aient été reconnues. Une
précondition bloquante non satisfaite arrête l'exécution sans qu'un seul réglage ait
été touché — c'est ce qui garantit qu'un échec ne laisse jamais un état à moitié
appliqué.

**Files:**
- Create: `src/lib/preflight.ts`
- Test: `test/lib/preflight.test.ts`

**Interfaces:**
- Consumes: `listNetworkServices` de `src/lib/shell.ts` (Task 2) ; `runRemoteJson` de
  `src/lib/ssh.ts` (Task 3) ; `Config` de `src/config.ts` (Task 5).
- Produces: le type `CheckResult` et les fonctions `runPreflight` et `hasBlockingFailure`.

- [ ] **Step 1: Écrire les tests qui échouent**

`test/lib/preflight.test.ts` :

```ts
import { test, expect, describe, mock } from "bun:test";
import { CONFIG } from "../../src/config";

let services: unknown[];
let remoteRows: unknown[];
let remoteThrows: Error | null = null;

mock.module("../../src/lib/shell", () => ({
  listNetworkServices: async () => services,
}));

mock.module("../../src/lib/ssh", () => ({
  runRemoteJson: async () => {
    if (remoteThrows) throw remoteThrows;
    return remoteRows;
  },
}));

const { runPreflight, hasBlockingFailure } = await import(
  "../../src/lib/preflight"
);

const HEALTHY_REMOTE = {
  caption: "Microsoft Windows 11 Professionnel",
  build: 26200,
  gpus: ["NVIDIA GeForce RTX 4090"],
  adapterPresent: true,
  adapterStatus: "Up",
};

const HEALTHY_SERVICES = [
  { order: 1, name: "AX88179A", hardwarePort: "AX88179A", device: "en14" },
  { order: 2, name: "Wi-Fi", hardwarePort: "Wi-Fi", device: "en0" },
];

function setup(remote: Partial<typeof HEALTHY_REMOTE> = {}, svc = HEALTHY_SERVICES) {
  remoteThrows = null;
  services = svc;
  remoteRows = [{ ...HEALTHY_REMOTE, ...remote }];
}

describe("runPreflight", () => {
  test("toutes les verifications passent sur le materiel de reference", async () => {
    setup();
    const results = await runPreflight(CONFIG);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(hasBlockingFailure(results)).toBe(false);
  });

  test("bloque si le service reseau du Mac est absent", async () => {
    setup({}, [{ order: 1, name: "Wi-Fi", hardwarePort: "Wi-Fi", device: "en0" }]);
    const results = await runPreflight(CONFIG);
    const check = results.find((r) => r.name === "service-mac");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(true);
    expect(check?.detail).toContain("AX88179A");
  });

  test("bloque si le PC ne repond pas en SSH", async () => {
    setup();
    remoteThrows = new Error("connexion refusee");
    const results = await runPreflight(CONFIG);
    expect(hasBlockingFailure(results)).toBe(true);
    expect(results.find((r) => r.name === "ssh")?.ok).toBe(false);
  });

  test("n'execute aucune verification distante si SSH est tombe", async () => {
    setup();
    remoteThrows = new Error("connexion refusee");
    const results = await runPreflight(CONFIG);
    // Une seule verification distante, celle qui a echoue : inutile d'en tenter
    // d'autres, elles echoueraient toutes pour la meme raison.
    expect(results.filter((r) => r.name === "windows-version")).toHaveLength(0);
  });

  test("bloque si aucun GPU NVIDIA n'est present", async () => {
    setup({ gpus: ["Intel UHD Graphics 770"] });
    const results = await runPreflight(CONFIG);
    const check = results.find((r) => r.name === "gpu");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(true);
  });

  test("ignore les ecrans virtuels dans la detection du GPU", async () => {
    setup({ gpus: ["SudoMaker Virtual Display Adapter", "NVIDIA GeForce RTX 4090"] });
    expect((await runPreflight(CONFIG)).find((r) => r.name === "gpu")?.ok).toBe(true);
  });

  test("avertit sans bloquer si la version de Windows differe", async () => {
    setup({ build: 22631 });
    const check = (await runPreflight(CONFIG)).find((r) => r.name === "windows-version");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(false);
  });

  test("bloque si l'interface Ethernet du PC est debranchee", async () => {
    setup({ adapterStatus: "Disconnected" });
    const check = (await runPreflight(CONFIG)).find((r) => r.name === "lien-windows");
    expect(check?.ok).toBe(false);
    expect(check?.blocking).toBe(true);
    expect(check?.detail).toContain("cable");
  });
});

describe("hasBlockingFailure", () => {
  test("un echec non bloquant ne suffit pas a arreter l'installation", () => {
    expect(
      hasBlockingFailure([
        { name: "a", ok: false, blocking: false, detail: "" },
        { name: "b", ok: true, blocking: true, detail: "" },
      ]),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Lancer les tests et vérifier qu'ils échouent**

Run: `bun test --isolate test/lib/preflight.test.ts`
Expected: FAIL — le module `../../src/lib/preflight` n'existe pas.

- [ ] **Step 3: Écrire l'implémentation**

`src/lib/preflight.ts` :

```ts
import { listNetworkServices } from "./shell";
import { runRemoteJson } from "./ssh";
import type { Config } from "../config";

export type CheckResult = {
  name: string;
  ok: boolean;
  /** Un echec bloquant arrete l'installation avant toute modification. */
  blocking: boolean;
  detail: string;
};

type RemoteFacts = {
  caption: string;
  build: number;
  gpus: string[];
  adapterPresent: boolean;
  adapterStatus: string | null;
};

const EXPECTED_BUILD = 26200;

const FACTS = (alias: string) => `
$os = Get-CimInstance Win32_OperatingSystem
$adapter = Get-NetAdapter -Name '${alias}' -ErrorAction SilentlyContinue
[pscustomobject]@{
  caption       = [string]$os.Caption
  build         = [int]$os.BuildNumber
  gpus          = @((Get-CimInstance Win32_VideoController).Name)
  adapterPresent = [bool]$adapter
  adapterStatus  = if ($adapter) { [string]$adapter.Status } else { $null }
}`;

export async function runPreflight(config: Config): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const services = await listNetworkServices();
  const macService = services.find((s) => s.name === config.mac.serviceName);
  results.push({
    name: "service-mac",
    ok: Boolean(macService),
    blocking: true,
    detail: macService
      ? `service "${config.mac.serviceName}" sur ${macService.device}`
      : `aucun service reseau nomme "${config.mac.serviceName}". Adaptateur USB debranche ?`,
  });

  let facts: RemoteFacts | undefined;
  try {
    const rows = await runRemoteJson<RemoteFacts>(
      config.ssh,
      FACTS(config.windows.interfaceAlias),
    );
    facts = rows[0];
    results.push({
      name: "ssh",
      ok: Boolean(facts),
      blocking: true,
      detail: facts ? `PC joignable sur ${config.ssh.host}` : "reponse vide du PC",
    });
  } catch (error) {
    results.push({
      name: "ssh",
      ok: false,
      blocking: true,
      detail: `PC injoignable sur ${config.ssh.host} : ${(error as Error).message}`,
    });
  }

  // Sans SSH, toute verification distante echouerait pour la meme raison.
  // On s'arrete la plutot que d'aligner des echecs redondants.
  if (!facts) return results;

  results.push({
    name: "windows-version",
    ok: facts.build === EXPECTED_BUILD,
    blocking: false,
    detail: `${facts.caption} build ${facts.build}${
      facts.build === EXPECTED_BUILD ? "" : ` (reference : ${EXPECTED_BUILD})`
    }`,
  });

  const nvidia = facts.gpus.find((name) => /nvidia/i.test(name));
  results.push({
    name: "gpu",
    ok: Boolean(nvidia),
    blocking: true,
    detail: nvidia ?? `aucun GPU NVIDIA parmi : ${facts.gpus.join(", ")}`,
  });

  const linkUp = facts.adapterPresent && facts.adapterStatus === "Up";
  results.push({
    name: "lien-windows",
    ok: linkUp,
    blocking: true,
    detail: linkUp
      ? `interface "${config.windows.interfaceAlias}" active`
      : `interface "${config.windows.interfaceAlias}" en etat ${facts.adapterStatus ?? "absent"}. Verifier le cable.`,
  });

  return results;
}

export function hasBlockingFailure(results: CheckResult[]): boolean {
  return results.some((r) => !r.ok && r.blocking);
}
```

- [ ] **Step 4: Lancer les tests et vérifier qu'ils passent**

Run: `bun test --isolate test/lib/preflight.test.ts`
Expected: PASS, neuf tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/preflight.ts test/lib/preflight.test.ts
git commit -m "feat: verification des preconditions avant toute modification"
```

---
### Task 9: Script d'amorçage et serveur éphémère

C'est la seule partie du projet qu'un humain exécute à la main, une fois par PC. Elle
doit donc être irréprochable : idempotente, lisible, et sans aucun piège de
localisation.

Trois écueils y sont traités, tous rencontrés pendant l'exploration. `icacls` refuse
`"Administrators:F"` sur un Windows français, où le groupe s'appelle « Administrateurs »
— on passe donc par les identifiants de sécurité, identiques dans toutes les langues.
`Add-Content -Encoding utf8` ajoute une marque d'ordre des octets qui rend le fichier de
clés illisible pour OpenSSH, en échouant silencieusement — on écrit en ASCII, ce qui
suffit pour une clé encodée en Base64. Et un compte membre du groupe Administrateurs
n'utilise pas `~/.ssh/authorized_keys` mais un fichier commun.

**Files:**
- Create: `src/assets/bootstrap.ps1`
- Create: `src/lib/bootstrap-server.ts`
- Test: `test/lib/bootstrap-server.test.ts`

**Interfaces:**
- Consumes: `Config` de `src/config.ts` (Task 5).
- Produces: `renderBootstrapScript`, `serveBootstrap`, et `localBootstrapUrl`.
  `src/commands/install.ts` en dépend.

- [ ] **Step 1: Écrire le script d'amorçage**

`src/assets/bootstrap.ps1` :

```powershell
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

Write-Host ''
Write-Host 'hardline - amorcage du PC' -ForegroundColor Cyan
Write-Host ''

# --- 1. OpenSSH Server ---------------------------------------------------
$capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
if ($capability.State -ne 'Installed') {
    Write-Host '  installation d''OpenSSH Server...'
    Add-WindowsCapability -Online -Name $capability.Name | Out-Null
} else {
    Write-Host '  OpenSSH Server deja installe'
}

Set-Service -Name sshd -StartupType Automatic
if ((Get-Service sshd).Status -ne 'Running') { Start-Service sshd }
Write-Host '  service sshd demarre'

# --- 2. Pare-feu ---------------------------------------------------------
if (-not (Get-NetFirewallRule -Name 'hardline-sshd' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'hardline-sshd' -DisplayName 'hardline - OpenSSH' `
        -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow -Profile Private | Out-Null
}
Write-Host '  regle de pare-feu SSH en place'

# --- 3. Cle publique du Mac ----------------------------------------------
# Un compte administrateur n'utilise PAS ~/.ssh/authorized_keys mais ce fichier commun.
$keyFile = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
$publicKey = '@@PUBLIC_KEY@@'

if (-not (Test-Path $keyFile)) { New-Item -ItemType File -Path $keyFile -Force | Out-Null }
if (-not (Select-String -Path $keyFile -SimpleMatch $publicKey -Quiet -ErrorAction SilentlyContinue)) {
    # ASCII et non utf8 : PowerShell 5.1 ajoute une marque d'ordre des octets
    # en utf8, qui rend le fichier illisible pour OpenSSH, sans aucune erreur.
    Add-Content -Path $keyFile -Value $publicKey -Encoding ascii
    Write-Host '  cle publique ajoutee'
} else {
    Write-Host '  cle publique deja presente'
}

# Identifiants de securite plutot que noms de groupes : "Administrators" n'existe
# pas sur un Windows francais, ou le groupe se nomme "Administrateurs".
icacls $keyFile /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null

# --- 4. Adresse du lien direct -------------------------------------------
$alias = '@@INTERFACE_ALIAS@@'
$adapter = Get-NetAdapter -Name $alias -ErrorAction SilentlyContinue
if (-not $adapter) {
    Write-Host ''
    Write-Host "  ECHEC : aucune interface nommee '$alias'." -ForegroundColor Red
    Write-Host '  Verifier que le cable Ethernet est branche.' -ForegroundColor Red
    exit 1
}

$target = '@@WINDOWS_IP@@'
$prefix = @@PREFIX_LENGTH@@

if (-not (Get-NetIPAddress -InterfaceAlias $alias -IPAddress $target -ErrorAction SilentlyContinue)) {
    Get-NetIPAddress -InterfaceAlias $alias -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Remove-NetIPAddress -Confirm:$false -ErrorAction SilentlyContinue
    New-NetIPAddress -InterfaceAlias $alias -IPAddress $target -PrefixLength $prefix | Out-Null
    Write-Host "  adresse $target posee sur $alias"
} else {
    Write-Host "  adresse $target deja posee"
}

Set-NetConnectionProfile -InterfaceAlias $alias -NetworkCategory Private -ErrorAction SilentlyContinue
Write-Host '  profil reseau prive'

Write-Host ''
Write-Host 'Amorcage termine. Lancer maintenant "hardline install" sur le Mac.' -ForegroundColor Green
Write-Host ''
```

- [ ] **Step 2: Écrire les tests qui échouent**

`test/lib/bootstrap-server.test.ts` :

```ts
import { test, expect, describe } from "bun:test";
import {
  renderBootstrapScript,
  serveBootstrap,
} from "../../src/lib/bootstrap-server";

const TEMPLATE = `$publicKey = '@@PUBLIC_KEY@@'
$alias = '@@INTERFACE_ALIAS@@'
$target = '@@WINDOWS_IP@@'
$prefix = @@PREFIX_LENGTH@@`;

const VARS = {
  publicKey: "ssh-ed25519 AAAAC3Nz test@mac",
  interfaceAlias: "Ethernet",
  windowsIp: "10.10.10.1",
  prefixLength: 24,
};

describe("renderBootstrapScript", () => {
  test("remplace tous les marqueurs", () => {
    const script = renderBootstrapScript(TEMPLATE, VARS);
    expect(script).not.toContain("@@");
    expect(script).toContain("ssh-ed25519 AAAAC3Nz test@mac");
    expect(script).toContain("10.10.10.1");
    expect(script).toContain("$prefix = 24");
  });

  test("echoue si un marqueur reste non substitue", () => {
    expect(() =>
      renderBootstrapScript("$x = '@@INCONNU@@'", VARS),
    ).toThrow(/INCONNU/);
  });

  test("refuse une cle publique contenant un apostrophe", () => {
    // Le marqueur est place entre apostrophes dans le script PowerShell :
    // une apostrophe dans la valeur casserait la chaine.
    expect(() =>
      renderBootstrapScript(TEMPLATE, { ...VARS, publicKey: "abc'def" }),
    ).toThrow(/apostrophe/);
  });
});

describe("serveBootstrap", () => {
  test("sert le script rendu puis s'arrete", async () => {
    const server = await serveBootstrap({ port: 0, template: TEMPLATE, ...VARS });
    try {
      const response = await fetch(`${server.url}/bootstrap.ps1`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("10.10.10.1");
    } finally {
      server.stop();
    }
  });

  test("repond 404 sur toute autre route", async () => {
    const server = await serveBootstrap({ port: 0, template: TEMPLATE, ...VARS });
    try {
      expect((await fetch(`${server.url}/autre`)).status).toBe(404);
    } finally {
      server.stop();
    }
  });

  test("le serveur ne repond plus apres arret", async () => {
    const server = await serveBootstrap({ port: 0, template: TEMPLATE, ...VARS });
    const url = server.url;
    server.stop();
    expect(fetch(`${url}/bootstrap.ps1`)).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Lancer les tests et vérifier qu'ils échouent**

Run: `bun test --isolate test/lib/bootstrap-server.test.ts`
Expected: FAIL — le module n'existe pas.

- [ ] **Step 4: Écrire l'implémentation**

`src/lib/bootstrap-server.ts` :

```ts
import { hostname } from "node:os";
import templatePath from "../assets/bootstrap.ps1" with { type: "file" };

export type BootstrapVars = {
  publicKey: string;
  interfaceAlias: string;
  windowsIp: string;
  prefixLength: number;
};

const MARKERS: Record<string, keyof BootstrapVars> = {
  "@@PUBLIC_KEY@@": "publicKey",
  "@@INTERFACE_ALIAS@@": "interfaceAlias",
  "@@WINDOWS_IP@@": "windowsIp",
  "@@PREFIX_LENGTH@@": "prefixLength",
};

export function renderBootstrapScript(
  template: string,
  vars: BootstrapVars,
): string {
  for (const value of Object.values(vars)) {
    if (typeof value === "string" && value.includes("'")) {
      // Les marqueurs sont places entre apostrophes cote PowerShell.
      throw new Error(
        `Valeur invalide : une apostrophe casserait le script PowerShell (${value})`,
      );
    }
  }

  let script = template;
  for (const [marker, key] of Object.entries(MARKERS)) {
    script = script.replaceAll(marker, String(vars[key]));
  }

  const leftover = script.match(/@@[A-Z_]+@@/);
  if (leftover) {
    throw new Error(`Marqueur non substitue dans le script d'amorcage : ${leftover[0]}`);
  }

  return script;
}

export async function loadBootstrapTemplate(): Promise<string> {
  return await Bun.file(templatePath).text();
}

export async function serveBootstrap(
  options: BootstrapVars & { port: number; template?: string },
): Promise<{ url: string; port: number; stop: () => void }> {
  const template = options.template ?? (await loadBootstrapTemplate());
  const script = renderBootstrapScript(template, options);

  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: options.port,
    routes: {
      "/bootstrap.ps1": () =>
        new Response(script, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });

  return {
    url: `http://localhost:${server.port}`,
    port: server.port,
    stop: () => server.stop(true),
  };
}

/** L'adresse a taper sur le PC : le nom mDNS du Mac, resolu nativement par Windows 11. */
export function localBootstrapUrl(port: number): string {
  return `http://${hostname()}:${port}/bootstrap.ps1`;
}
```

- [ ] **Step 5: Lancer les tests et vérifier qu'ils passent**

Run: `bun test --isolate test/lib/bootstrap-server.test.ts`
Expected: PASS, six tests.

- [ ] **Step 6: Vérifier que le PC atteint réellement le serveur**

Lancer le serveur, puis depuis le PC vérifier qu'il télécharge le script. Cela valide à
la fois la résolution mDNS et l'absence de blocage par le pare-feu du Mac.

Run: `bun -e 'import {serveBootstrap, localBootstrapUrl} from "./src/lib/bootstrap-server"; const s = await serveBootstrap({port:8080, publicKey:"ssh-ed25519 TEST", interfaceAlias:"Ethernet", windowsIp:"10.10.10.1", prefixLength:24}); console.log(localBootstrapUrl(8080)); await Bun.sleep(60000); s.stop()'`

Puis, dans un autre terminal :
`ssh -i ~/.ssh/id_ed25519_winpc arthur@192.168.1.48 'powershell -NoProfile -Command "(irm http://'$(hostname)'/bootstrap.ps1 -TimeoutSec 5).Length"'`

Expected: un nombre de caractères non nul, prouvant que le PC a bien téléchargé le
script depuis le Mac par son nom mDNS.

- [ ] **Step 7: Commit**

```bash
git add src/assets/bootstrap.ps1 src/lib/bootstrap-server.ts test/lib/bootstrap-server.test.ts
git commit -m "feat: script d'amorcage idempotent et serveur ephemere"
```

---
### Task 10: Orchestrateur, install et uninstall

Le cœur du programme. Un point y est non négociable, et c'est la raison pour laquelle
la spec a été amendée : **l'état antérieur est écrit sur disque avant que l'étape ne
modifie quoi que ce soit.** Une interruption au clavier pendant un indicateur d'activité
termine le processus sans exécuter le moindre traitement de rattrapage ; si le manifeste
n'était écrit qu'après coup, la machine resterait modifiée sans que rien ne connaisse
son état d'origine. En écrivant d'abord, le pire cas devient une étape enregistrée mais
non appliquée, que le passage suivant corrige de lui-même.

**Files:**
- Create: `src/lib/orchestrator.ts`
- Create: `src/commands/install.ts`
- Create: `src/commands/uninstall.ts`
- Modify: `src/cli.ts` — brancher les deux actions
- Test: `test/lib/orchestrator.test.ts`

**Interfaces:**
- Consumes: `Step` (Task 5), `macNetworkStep` (Task 5), `windowsNetworkStep` (Task 6),
  `ui` (Task 7), `runPreflight` / `hasBlockingFailure` (Task 8), `readManifest` /
  `writeManifest` / `recordStep` / `forgetStep` / `stepsInReverseOrder` (Task 4).
- Produces: `ALL_STEPS`, `applySteps`, `revertSteps`, `installCommand`,
  `uninstallCommand`.

- [ ] **Step 1: Écrire les tests qui échouent**

`test/lib/orchestrator.test.ts` :

```ts
import { test, expect, describe, mock, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "../../src/config";
import type { Step } from "../../src/steps/types";
import { readManifest, emptyManifest } from "../../src/lib/manifest";
import { applySteps, revertSteps } from "../../src/lib/orchestrator";

type Trace = string[];

function makeStep(
  name: string,
  conforming: boolean,
  trace: Trace,
  onApply?: () => void,
): Step<{ marker: string }> {
  return {
    name,
    label: `Etape ${name}`,
    async inspect() {
      trace.push(`inspect:${name}`);
      return { conforming, current: { marker: `avant-${name}` }, detail: "d" };
    },
    async apply() {
      trace.push(`apply:${name}`);
      onApply?.();
    },
    async restore(_c, previous) {
      trace.push(`restore:${name}:${previous.marker}`);
    },
  };
}

const reports: string[] = [];
const fakeUi = {
  skipped: ({ label }: { label: string }) => reports.push(`skipped:${label}`),
  applied: ({ label }: { label: string }) => reports.push(`applied:${label}`),
  failed: ({ label }: { label: string }) => reports.push(`failed:${label}`),
};

let dir: string;
let manifestPath: string;

beforeEach(async () => {
  reports.length = 0;
  dir = await mkdtemp(join(tmpdir(), "hardline-orch-"));
  manifestPath = join(dir, "manifest.json");
});

describe("applySteps", () => {
  test("saute une etape deja conforme sans l'appliquer", async () => {
    const trace: Trace = [];
    await applySteps([makeStep("a", true, trace)], CONFIG, manifestPath, fakeUi);
    expect(trace).toEqual(["inspect:a"]);
    expect(reports).toEqual(["skipped:Etape a"]);
  });

  test("applique une etape non conforme", async () => {
    const trace: Trace = [];
    await applySteps([makeStep("a", false, trace)], CONFIG, manifestPath, fakeUi);
    expect(trace).toEqual(["inspect:a", "apply:a"]);
    expect(reports).toEqual(["applied:Etape a"]);
  });

  test("ecrit le manifeste AVANT d'appliquer", async () => {
    // Le test qui protege l'invariant de surete : au moment ou apply s'execute,
    // l'etat anterieur doit deja etre sur disque.
    const trace: Trace = [];
    let manifestAtApplyTime: unknown;
    const step = makeStep("a", false, trace, () => {
      manifestAtApplyTime = Bun.file(manifestPath).size;
    });
    await applySteps([step], CONFIG, manifestPath, fakeUi);
    expect(manifestAtApplyTime).toBeGreaterThan(0);
  });

  test("conserve l'etat anterieur dans le manifeste", async () => {
    await applySteps([makeStep("a", false, [])], CONFIG, manifestPath, fakeUi);
    const manifest = await readManifest(manifestPath);
    expect(manifest.steps["a"]?.previous).toEqual({ marker: "avant-a" });
  });

  test("n'enregistre pas une etape deja conforme", async () => {
    await applySteps([makeStep("a", true, [])], CONFIG, manifestPath, fakeUi);
    expect((await readManifest(manifestPath)).order).toEqual([]);
  });

  test("s'arrete a la premiere etape en echec et signale laquelle", async () => {
    const trace: Trace = [];
    const boom = makeStep("b", false, trace, () => {
      throw new Error("refus");
    });
    const after = makeStep("c", false, trace);
    expect(
      applySteps([makeStep("a", false, trace), boom, after], CONFIG, manifestPath, fakeUi),
    ).rejects.toThrow("refus");
    await applySteps([makeStep("a", false, trace)], CONFIG, manifestPath, fakeUi).catch(
      () => {},
    );
    expect(trace).not.toContain("apply:c");
  });

  test("rejouer applySteps ne reapplique rien", async () => {
    const trace: Trace = [];
    await applySteps([makeStep("a", true, trace)], CONFIG, manifestPath, fakeUi);
    await applySteps([makeStep("a", true, trace)], CONFIG, manifestPath, fakeUi);
    expect(trace.filter((t) => t.startsWith("apply"))).toHaveLength(0);
  });
});

describe("revertSteps", () => {
  test("restaure dans l'ordre inverse de l'application", async () => {
    const trace: Trace = [];
    const steps = [makeStep("a", false, trace), makeStep("b", false, trace)];
    await applySteps(steps, CONFIG, manifestPath, fakeUi);
    trace.length = 0;
    await revertSteps(steps, CONFIG, manifestPath, fakeUi);
    expect(trace).toEqual(["restore:b:avant-b", "restore:a:avant-a"]);
  });

  test("vide le manifeste apres restauration", async () => {
    const steps = [makeStep("a", false, [])];
    await applySteps(steps, CONFIG, manifestPath, fakeUi);
    await revertSteps(steps, CONFIG, manifestPath, fakeUi);
    expect((await readManifest(manifestPath)).order).toEqual([]);
  });

  test("ignore une etape enregistree dont le code a disparu", async () => {
    const steps = [makeStep("a", false, [])];
    await applySteps(steps, CONFIG, manifestPath, fakeUi);
    // On restaure avec un registre vide : ne doit pas lever.
    await revertSteps([], CONFIG, manifestPath, fakeUi);
    expect(reports.some((r) => r.startsWith("failed"))).toBe(true);
  });
});
```

Nettoyage : ajouter en fin de fichier

```ts
import { afterEach } from "bun:test";
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Lancer les tests et vérifier qu'ils échouent**

Run: `bun test --isolate test/lib/orchestrator.test.ts`
Expected: FAIL — le module `../../src/lib/orchestrator` n'existe pas.

- [ ] **Step 3: Vérifier le registre des étapes**

`src/steps/index.ts` a été créé par la tâche 6b et doit déjà contenir les trois étapes dans cet ordre. Le relire et le laisser tel quel s'il est conforme :

```ts
import { macNetworkStep } from "./network-mac";
import { windowsNetworkStep } from "./network-windows";
import type { Step } from "./types";

/**
 * L'ordre compte : les etapes sont appliquees dans cet ordre et restaurees
 * dans l'ordre inverse. Le Mac d'abord, car c'est la machine depuis laquelle
 * on parle ; le PC ensuite, une fois le chemin etabli.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_STEPS: Step<any>[] = [macNetworkStep, windowsNetworkStep];
```

- [ ] **Step 4: Écrire l'orchestrateur**

`src/lib/orchestrator.ts` :

```ts
import type { Config } from "../config";
import type { Step } from "../steps/types";
import {
  forgetStep,
  readManifest,
  recordStep,
  stepsInReverseOrder,
  writeManifest,
} from "./manifest";

export type StepReporter = {
  skipped(r: { label: string; detail: string }): void;
  applied(r: { label: string; detail: string }): void;
  failed(r: { label: string; detail: string }): void;
};

export async function applySteps(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: Step<any>[],
  config: Config,
  manifestPath: string,
  reporter: StepReporter,
): Promise<void> {
  let manifest = await readManifest(manifestPath);

  for (const step of steps) {
    const state = await step.inspect(config);

    if (state.conforming) {
      reporter.skipped({ label: step.label, detail: state.detail });
      continue;
    }

    // Invariant de surete : le manifeste est ecrit AVANT la modification.
    // Une interruption pendant apply laisse alors une etape enregistree mais
    // non appliquee, que le passage suivant corrige de lui-meme.
    manifest = recordStep(
      manifest,
      step.name,
      state.current,
      new Date().toISOString(),
    );
    await writeManifest(manifestPath, manifest);

    await step.apply(config);
    reporter.applied({ label: step.label, detail: state.detail });
  }
}

export async function revertSteps(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps: Step<any>[],
  config: Config,
  manifestPath: string,
  reporter: StepReporter,
): Promise<void> {
  let manifest = await readManifest(manifestPath);
  const byName = new Map(steps.map((s) => [s.name, s]));

  for (const record of stepsInReverseOrder(manifest)) {
    const step = byName.get(record.step);

    if (!step) {
      reporter.failed({
        label: record.step,
        detail: "etape inconnue de cette version de hardline, ignoree",
      });
      manifest = forgetStep(manifest, record.step);
      await writeManifest(manifestPath, manifest);
      continue;
    }

    await step.restore(config, record.previous);
    reporter.applied({ label: step.label, detail: "etat anterieur restaure" });

    manifest = forgetStep(manifest, record.step);
    await writeManifest(manifestPath, manifest);
  }
}
```

- [ ] **Step 5: Lancer les tests et vérifier qu'ils passent**

Run: `bun test --isolate test/lib/orchestrator.test.ts`
Expected: PASS, dix tests.

- [ ] **Step 6: Écrire les deux commandes**

`src/commands/install.ts` :

```ts
import { CONFIG } from "../config";
import { ALL_STEPS } from "../steps";
import { applySteps } from "../lib/orchestrator";
import { defaultManifestPath } from "../lib/manifest";
import { hasBlockingFailure, runPreflight } from "../lib/preflight";
import { serveBootstrap, localBootstrapUrl } from "../lib/bootstrap-server";
import { configureOutput, ui, withSpinner } from "../lib/ui";
import { readFile } from "node:fs/promises";

export async function installCommand(): Promise<void> {
  configureOutput();
  ui.start("hardline — installation");

  const checks = await withSpinner("Verification des preconditions", async () =>
    runPreflight(CONFIG),
  );

  for (const check of checks) {
    const report = { label: check.name, detail: check.detail };
    if (check.ok) ui.skipped(report);
    else if (check.blocking) ui.failed(report);
    else ui.warn(`${check.name} — ${check.detail}`);
  }

  if (hasBlockingFailure(checks)) {
    const sshFailed = checks.some((c) => c.name === "ssh" && !c.ok);

    if (sshFailed) {
      const publicKey = (
        await readFile(`${CONFIG.ssh.identityFile}.pub`, "utf8")
      ).trim();

      const server = await serveBootstrap({
        port: CONFIG.bootstrapPort,
        publicKey,
        interfaceAlias: CONFIG.windows.interfaceAlias,
        windowsIp: CONFIG.windows.ip,
        prefixLength: CONFIG.windows.prefixLength,
      });

      ui.report("Amorcage du PC", [
        "Le PC n'est pas encore joignable. Sur le PC, dans un",
        "PowerShell administrateur, coller cette ligne :",
        "",
        `  irm ${localBootstrapUrl(server.port)} | iex`,
        "",
        "Puis relancer : hardline install",
      ]);

      ui.info("Serveur d'amorcage actif pendant 10 minutes. Ctrl+C pour arreter.");
      await Bun.sleep(10 * 60_000);
      server.stop();
      return;
    }

    ui.finish("Installation interrompue : precondition non satisfaite.");
    process.exitCode = 1;
    return;
  }

  await applySteps(ALL_STEPS, CONFIG, defaultManifestPath(), ui);
  ui.finish("Liaison etablie. Verifier avec : hardline doctor");
}
```

`src/commands/uninstall.ts` :

```ts
import { CONFIG } from "../config";
import { ALL_STEPS } from "../steps";
import { revertSteps } from "../lib/orchestrator";
import { defaultManifestPath } from "../lib/manifest";
import { configureOutput, confirmOrExit, ui } from "../lib/ui";

export async function uninstallCommand(options: { yes: boolean }): Promise<void> {
  configureOutput();
  ui.start("hardline — desinstallation");

  const confirmed = await confirmOrExit(
    "Restaurer la configuration reseau anterieure des deux machines ?",
    options.yes,
  );
  if (!confirmed) {
    ui.finish("Rien n'a ete modifie.");
    return;
  }

  await revertSteps(ALL_STEPS, CONFIG, defaultManifestPath(), ui);
  ui.finish("Etat anterieur restaure.");
}
```

- [ ] **Step 7: Brancher les commandes dans le CLI**

Dans `src/cli.ts`, remplacer les deux actions correspondantes :

```ts
import { installCommand } from "./commands/install";
import { uninstallCommand } from "./commands/uninstall";

// ...

  program
    .command("install")
    .description("Converge les deux machines vers l'état cible")
    .action(installCommand);

  program
    .command("uninstall")
    .description("Restaure l'état antérieur à partir du manifeste")
    .option("-y, --yes", "ne pas demander de confirmation", false)
    .action(uninstallCommand);
```

- [ ] **Step 8: Lancer la suite complète**

Run: `bun test --isolate`
Expected: PASS, tous les tests des tâches 1 à 10.

- [ ] **Step 9: Vérifier l'idempotence sur les vraies machines**

Run: `bun run src/cli.ts install`
Expected: les étapes s'appliquent, la liaison est établie.

Run: `bun run src/cli.ts install`
Expected: **toutes les étapes sont annoncées « déjà conforme »**, aucune n'est
réappliquée. C'est la validation de l'idempotence.

- [ ] **Step 10: Commit**

```bash
git add src/steps/index.ts src/lib/orchestrator.ts src/commands/ src/cli.ts test/lib/orchestrator.test.ts
git commit -m "feat: orchestrateur idempotent, install et uninstall"
```

---
### Task 11: Diagnostic

`doctor` ne modifie jamais rien. Il réutilise les `inspect` déjà écrits, y ajoute une
mesure de latence, et rend un rapport lisible. C'est l'outil qui évite d'avoir à
déboguer à l'aveugle quand la liaison se dégrade — typiquement le jour où Windows aura
rebasculé le lien en réseau public.

La sous-commande `up` reste volontairement non implémentée à ce stade : elle ouvre une
session de travail, ce qui suppose Moonlight, donc le plan 2.

**Files:**
- Create: `src/commands/doctor.ts`
- Modify: `src/cli.ts` — brancher l'action
- Test: `test/commands/doctor.test.ts`

**Interfaces:**
- Consumes: `runPreflight` (Task 8), `ALL_STEPS` (Task 10), `pingFrom` (Task 2),
  `ui` (Task 7).
- Produces: `doctorCommand` et la fonction pure `formatDiagnostic`.

- [ ] **Step 1: Écrire les tests qui échouent**

`test/commands/doctor.test.ts` :

```ts
import { test, expect, describe } from "bun:test";
import { formatDiagnostic } from "../../src/commands/doctor";

const HEALTHY = {
  checks: [
    { name: "ssh", ok: true, blocking: true, detail: "PC joignable sur 10.10.10.1" },
  ],
  steps: [
    { label: "Adresse fixe (Mac)", conforming: true, detail: "deja en 10.10.10.2" },
    { label: "Adresse fixe (PC)", conforming: true, detail: "deja en 10.10.10.1" },
  ],
  ping: {
    transmitted: 20,
    received: 20,
    lossPercent: 0,
    minMs: 0.465,
    avgMs: 1.04,
    maxMs: 1.734,
    stddevMs: 0.209,
  },
};

describe("formatDiagnostic", () => {
  test("rend la latence et la gigue avec deux decimales", () => {
    const lines = formatDiagnostic(HEALTHY);
    expect(lines.join("\n")).toContain("1.04 ms");
    expect(lines.join("\n")).toContain("0.21 ms");
  });

  test("signale une perte de paquets non nulle", () => {
    const lines = formatDiagnostic({
      ...HEALTHY,
      ping: { ...HEALTHY.ping, received: 18, lossPercent: 10 },
    });
    expect(lines.join("\n")).toContain("10");
    expect(lines.join("\n")).toMatch(/perte/i);
  });

  test("indique clairement qu'un hote est injoignable", () => {
    const lines = formatDiagnostic({
      ...HEALTHY,
      ping: {
        transmitted: 20,
        received: 0,
        lossPercent: 100,
        minMs: null,
        avgMs: null,
        maxMs: null,
        stddevMs: null,
      },
    });
    expect(lines.join("\n")).toMatch(/injoignable/i);
    expect(lines.join("\n")).not.toContain("null");
  });

  test("distingue une etape conforme d'une etape derivee", () => {
    const lines = formatDiagnostic({
      ...HEALTHY,
      steps: [
        { label: "Adresse fixe (PC)", conforming: false, detail: "profil Public" },
      ],
    });
    const text = lines.join("\n");
    expect(text).toContain("Adresse fixe (PC)");
    expect(text).toContain("profil Public");
  });

  test("ne mentionne pas le debit quand il n'a pas ete mesure", () => {
    expect(formatDiagnostic(HEALTHY).join("\n")).not.toMatch(/Mbit/);
  });
});
```

- [ ] **Step 2: Lancer les tests et vérifier qu'ils échouent**

Run: `bun test --isolate test/commands/doctor.test.ts`
Expected: FAIL — le module `../../src/commands/doctor` n'existe pas.

- [ ] **Step 3: Écrire l'implémentation**

`src/commands/doctor.ts` :

```ts
import { CONFIG } from "../config";
import { ALL_STEPS } from "../steps";
import { pingFrom, type PingStats } from "../lib/shell";
import { runPreflight, type CheckResult } from "../lib/preflight";
import { configureOutput, ui, withSpinner } from "../lib/ui";

export type StepSummary = {
  label: string;
  conforming: boolean;
  detail: string;
};

export type Diagnostic = {
  checks: CheckResult[];
  steps: StepSummary[];
  ping: PingStats;
};

function pad(label: string): string {
  return `${label} :`.padEnd(22);
}

export function formatDiagnostic(diagnostic: Diagnostic): string[] {
  const lines: string[] = [];

  for (const check of diagnostic.checks) {
    lines.push(`${check.ok ? "OK  " : "KO  "}${pad(check.name)}${check.detail}`);
  }

  lines.push("");

  for (const step of diagnostic.steps) {
    lines.push(
      `${step.conforming ? "OK  " : "KO  "}${pad(step.label)}${step.detail}`,
    );
  }

  lines.push("");

  const { ping } = diagnostic;
  if (ping.received === 0) {
    lines.push(`KO  ${pad("Liaison")}injoignable (${ping.transmitted} paquets envoyes)`);
    return lines;
  }

  lines.push(`OK  ${pad("Latence moyenne")}${ping.avgMs?.toFixed(2)} ms`);
  lines.push(`    ${pad("Gigue")}${ping.stddevMs?.toFixed(2)} ms`);
  lines.push(
    `${ping.lossPercent === 0 ? "OK  " : "KO  "}${pad("Perte de paquets")}${ping.lossPercent} %`,
  );

  return lines;
}

export async function doctorCommand(): Promise<void> {
  configureOutput();
  ui.start("hardline — diagnostic");

  const checks = await withSpinner("Verification des machines", async () =>
    runPreflight(CONFIG),
  );

  const steps: StepSummary[] = [];
  for (const step of ALL_STEPS) {
    try {
      const state = await step.inspect(CONFIG);
      steps.push({
        label: step.label,
        conforming: state.conforming,
        detail: state.detail,
      });
    } catch (error) {
      steps.push({
        label: step.label,
        conforming: false,
        detail: (error as Error).message,
      });
    }
  }

  const ping = await withSpinner("Mesure de la latence", async () =>
    pingFrom(CONFIG.mac.ip, CONFIG.windows.ip, 20),
  );

  ui.report("Diagnostic", formatDiagnostic({ checks, steps, ping }));

  const healthy =
    checks.every((c) => c.ok || !c.blocking) &&
    steps.every((s) => s.conforming) &&
    ping.received > 0;

  if (healthy) {
    ui.finish("Liaison operationnelle.");
  } else {
    ui.finish("Anomalies detectees. Relancer : hardline install");
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Lancer les tests et vérifier qu'ils passent**

Run: `bun test --isolate test/commands/doctor.test.ts`
Expected: PASS, cinq tests.

- [ ] **Step 5: Brancher la commande**

Dans `src/cli.ts` :

```ts
import { doctorCommand } from "./commands/doctor";

  program
    .command("doctor")
    .description("Diagnostique la liaison et les services")
    .action(doctorCommand);
```

- [ ] **Step 6: Vérifier contre les vraies machines**

Run: `bun run src/cli.ts doctor`
Expected: un rapport encadré où chaque ligne commence par `OK`, avec une latence
proche de 1 ms et 0 % de perte. Le code de sortie doit être 0 — le vérifier avec
`echo $?`.

- [ ] **Step 7: Vérifier que le diagnostic détecte une vraie panne**

Débrancher le câble Ethernet, puis relancer.

Run: `bun run src/cli.ts doctor; echo "code: $?"`
Expected: des lignes `KO`, la mention « injoignable », et un code de sortie 1.
Rebrancher ensuite.

- [ ] **Step 8: Commit**

```bash
git add src/commands/doctor.ts src/cli.ts test/commands/doctor.test.ts
git commit -m "feat: commande doctor"
```

---

### Task 12: Binaire autonome

**Files:**
- Create: `scripts/build.ts`
- Modify: `package.json` — le script `build` existe déjà et pointe ici
- Test: vérification manuelle du binaire produit

**Interfaces:**
- Consumes: `src/cli.ts` (Task 1) et tout ce qu'il importe.
- Produces: un exécutable `dist/hardline`.

- [ ] **Step 1: Écrire le script de construction**

`scripts/build.ts` :

```ts
const result = await Bun.build({
  entrypoints: ["./src/cli.ts"],
  outdir: "./dist",
  target: "bun",
  minify: true,
  compile: {
    target: "bun-darwin-arm64",
    outfile: "./dist/hardline",
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log("Binaire produit : ./dist/hardline");
```

Si l'API programmatique `Bun.build` ne prend pas l'option `compile` dans la version
installée, remplacer le contenu du script par un appel direct à la ligne de commande,
qui est la voie documentée :

```ts
const proc = Bun.spawn(
  [
    "bun",
    "build",
    "./src/cli.ts",
    "--compile",
    "--minify",
    "--bytecode",
    "--target=bun-darwin-arm64",
    "--outfile",
    "./dist/hardline",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
process.exit(await proc.exited);
```

- [ ] **Step 2: Construire**

Run: `bun run build`
Expected: `./dist/hardline` existe. Sa taille se compte en dizaines de mégaoctets,
c'est normal : le runtime Bun y est embarqué.

- [ ] **Step 3: Vérifier que le binaire est autonome et embarque le script d'amorçage**

Le point à valider est que `src/assets/bootstrap.ps1`, importé comme fichier, est bien
inclus dans le binaire et non lu depuis le disque.

Run: `cd /tmp && /Users/arthur/Documents/Dev/projects/thunderbolt-control/dist/hardline --help`
Expected: l'aide s'affiche, exécutée depuis un répertoire sans aucun fichier du projet.

Run: `cd /tmp && ~/Documents/Dev/projects/thunderbolt-control/dist/hardline doctor`
Expected: le diagnostic s'exécute normalement, prouvant que rien ne dépend du
répertoire de travail.

- [ ] **Step 4: Ajouter dist au .gitignore et committer**

```bash
echo "dist/" >> .gitignore
git add scripts/build.ts .gitignore
git commit -m "feat: production d'un binaire autonome"
```

---

## Vérification finale du plan 1

À l'issue des douze tâches, ces trois affirmations doivent être vraies et vérifiées,
pas supposées.

1. `bun test --isolate` passe intégralement.
2. `hardline install` lancé deux fois de suite n'applique rien la seconde fois, et
   l'annonce explicitement pour chaque étape.
3. `hardline uninstall` puis `hardline doctor` montre une liaison revenue à son état
   d'origine, et `hardline install` la rétablit.

Le plan 2 reprendra ici pour ajouter le pilote d'écran virtuel, Sunshine, l'appairage
automatique, le montage SMB et la commande `up`.
