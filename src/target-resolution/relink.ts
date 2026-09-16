import {
  runRemote as defaultRunRemote,
  type SSHTarget,
} from "../lib/ssh";
import type { Manifest } from "../lib/manifest";
import type { AskLink, MacBootstrapObservations } from "./bootstrap-target";
import { LinkAdapterUnavailableError } from "./link-recovery";
import { sharedLinkCandidates, type NetworkAdapterObservation } from "./network";
import type { LinkEndpoints, LinkKind, TargetProfile } from "./types";

/**
 * Re-choisir le chemin quand celui du profil n'existe plus.
 *
 * Le modele de surete du projet dit qu'une adresse est une localisation, jamais
 * une identite. Un ADAPTATEUR en est une aussi : un dongle se debranche, un port
 * meurt, une carte se remplace. Ce qui identifie la paire, ce sont les deux
 * identifiants machine, et eux ne bougent pas.
 *
 * D'ou cette operation, et sa limite. Elle n'adopte QUE des liens partages,
 * parce qu'un lien partage est le seul qui ne demande aucune ecriture nulle
 * part : les deux machines portent deja leurs adresses. Adopter un lien direct
 * exigerait d'adresser les interfaces, donc de muter le PC a travers le canal de
 * secours — ce que le projet interdit, et continue d'interdire ici.
 */
export class RelinkImpossibleError extends Error {
  constructor(
    readonly reason: "pc-inaccessible" | "no-shared-network" | "identity-mismatch",
  ) {
    super(
      reason === "pc-inaccessible"
        ? "The paired PC could not be reached under any of its known names."
        : reason === "identity-mismatch"
          ? "The machine that answered is not the paired machine."
          : "The two machines share no network, and Hardline will not build a dedicated link without the adapter its Target Profile names.",
    );
    this.name = "RelinkImpossibleError";
  }
}

export type RelinkWindowsObservation = {
  readonly machineId: string;
  readonly computerName: string;
  readonly adapters: readonly NetworkAdapterObservation[];
};

export type RelinkDependencies = {
  readonly observeMac: () => Promise<MacBootstrapObservations>;
  readonly observeWindows: (target: SSHTarget) => Promise<RelinkWindowsObservation>;
  readonly probe: (candidate: TargetProfile) => Promise<boolean>;
  readonly recoveryTarget: (profile: TargetProfile, host: string) => SSHTarget;
  readonly persist: (profile: TargetProfile) => Promise<void>;
  readonly ask: AskLink;
};

export async function relinkShared(
  profile: TargetProfile,
  dependencies: RelinkDependencies,
): Promise<{ readonly profile: TargetProfile; readonly resolution: "recovered" }> {
  const mac = await dependencies.observeMac();
  if (mac.machineId !== profile.mac.machineId) {
    throw new RelinkImpossibleError("identity-mismatch");
  }

  // Le canal de secours ne sert qu'a LIRE, ici comme ailleurs. Aucun des noms
  // essayes ne peut porter une modification.
  let windows: RelinkWindowsObservation | undefined;
  for (const alias of profile.windows.hostAliases) {
    try {
      const observed = await dependencies.observeWindows(
        dependencies.recoveryTarget(profile, alias),
      );
      if (observed.machineId === profile.windows.machineId) {
        windows = observed;
        break;
      }
    } catch {
      // Un nom qui ne repond pas n'est pas une panne : on essaie le suivant.
    }
  }
  if (!windows) throw new RelinkImpossibleError("pc-inaccessible");

  const paths = sharedLinkCandidates(mac.adapters, windows.adapters);
  if (paths.length === 0) throw new RelinkImpossibleError("no-shared-network");
  const path =
    paths.length === 1
      ? paths[0]!
      : paths[await dependencies.ask({ kind: "path", candidates: paths })] ?? paths[0]!;

  const { pendingMigration: _, ...withoutPending } = profile;
  const candidate: TargetProfile = {
    ...withoutPending,
    revision: profile.revision + 1,
    linkKind: "shared",
    // Le lien dedie qu'on quitte ne s'efface pas : son adressage est toujours
    // pose sur les deux interfaces, et hardline est seul a savoir le decrire.
    // Quand on quittait deja un lien partage, il n'y a rien de neuf a retenir,
    // et ce qui dormait continue de dormir.
    ...(dormantLinkOf(profile) ? { dormantLink: dormantLinkOf(profile)! } : {}),
    mac: {
      ...profile.mac,
      hostAliases: mac.hostAliases,
      ethernet: {
        hardwareId: canonicalId(path.mac.macAddress),
        macAddress: path.mac.macAddress,
        interfaceId: path.mac.stableId,
        serviceName: path.mac.alias,
      },
    },
    windows: {
      ...profile.windows,
      hostAliases: [windows.computerName].filter(Boolean),
      ethernet: {
        hardwareId: path.windows.stableId,
        macAddress: path.windows.macAddress,
        interfaceAlias: path.windows.alias,
        wireless: path.windows.transport === "wifi",
      },
    },
    directLink: {
      subnet: path.subnet,
      macAddress: path.macAddress,
      windowsAddress: path.windowsAddress,
      prefixLength: path.prefixLength,
    },
  };

  // Le profil n'est reecrit qu'apres que le lien qu'il decrit a repondu par
  // lui-meme, sur son propre adaptateur. Un releve pris par le canal de secours
  // prouve que le PC vit, pas que ce chemin-la porte une session.
  if (!(await dependencies.probe(candidate))) {
    throw new RelinkImpossibleError("no-shared-network");
  }
  await dependencies.persist(candidate);
  return { profile: candidate, resolution: "recovered" };
}

function dormantLinkOf(profile: TargetProfile): LinkEndpoints | undefined {
  if ((profile.linkKind ?? "direct") === "shared") return profile.dormantLink;
  return {
    mac: profile.mac.ethernet,
    windows: profile.windows.ethernet,
    directLink: profile.directLink,
  };
}

export type ReviveDependencies = {
  readonly observeMac: () => Promise<MacBootstrapObservations>;
  readonly probe: (candidate: TargetProfile) => Promise<boolean>;
  readonly persist: (profile: TargetProfile) => Promise<void>;
};

export type LinkResolution = {
  readonly profile: TargetProfile;
  readonly resolution: "validated" | "recovered";
};

/**
 * Pourquoi le lien dedie n'a pas ete repris. Chacune de ces raisons appelle un
 * geste different de l'operateur, et c'est pour cela qu'elles sont distinctes
 * plutot que reduites a une absence.
 */
export type ReviveResult =
  | { readonly kind: "revived"; readonly result: LinkResolution }
  /** Aucun lien dedie n'a jamais ete etabli pour cette paire. */
  | { readonly kind: "unknown" }
  /** Il en existe un, mais son adaptateur n'est pas branche. */
  | { readonly kind: "adapter-absent" }
  /** L'adaptateur est la, et le PC ne repond pas dessus. */
  | { readonly kind: "unreachable" };

/**
 * Reprendre le cable des qu'il repond.
 *
 * Le lien dedie est ce que le projet existe pour offrir : une latence bornee
 * que personne d'autre ne partage. Y revenir ne coute aucune ecriture — les
 * deux interfaces portent toujours l'adressage pose a l'installation — donc la
 * seule chose a faire est de REGARDER, et la seule chose a ne pas faire est de
 * s'y accrocher : tant que l'adaptateur n'est pas la, on ne demande rien au
 * reseau.
 *
 * Renvoie null quand il n'y a rien a reprendre. Ce n'est pas un echec : c'est
 * le cas ordinaire d'une machine qui travaille sur son reseau partage.
 */
export async function reviveDormantLink(
  profile: TargetProfile,
  dependencies: ReviveDependencies,
): Promise<ReviveResult> {
  const dormant = profile.dormantLink;
  if (!dormant) return { kind: "unknown" };

  // Sonde locale d'abord. Sans adaptateur branche, aucune session SSH n'a de
  // raison d'etre tentee, et le cas courant ne coute rien.
  //
  // L'adresse materielle est la seule chose stable : macOS renumerote ses
  // interfaces au rebranchement, et un dongle parti en en14 revient en en15.
  // Le nom BSD et le service sont donc RELUS, jamais exiges — c'est deja ce
  // que fait la recuperation de lien pour la meme raison.
  const mac = await dependencies.observeMac();
  const cable = mac.adapters.find(
    (adapter) =>
      adapter.linkState === "up" &&
      normalized(adapter.macAddress) === normalized(dormant.mac.macAddress),
  );
  if (!cable) return { kind: "adapter-absent" };

  const { dormantLink: _, ...withoutDormant } = profile;
  const candidate: TargetProfile = {
    ...withoutDormant,
    revision: profile.revision + 1,
    linkKind: "direct",
    mac: {
      ...profile.mac,
      ethernet: {
        ...dormant.mac,
        interfaceId: cable.stableId,
        serviceName: cable.alias,
      },
    },
    windows: { ...profile.windows, ethernet: dormant.windows },
    directLink: dormant.directLink,
  };
  if (!(await dependencies.probe(candidate))) return { kind: "unreachable" };
  await dependencies.persist(candidate);
  return { kind: "revived", result: { profile: candidate, resolution: "recovered" } };
}

/**
 * Ce que l'operateur a demande pour cette execution. `auto` prend le meilleur
 * lien qui repond ; les deux autres exigent le leur, et echouent en le disant
 * plutot que de rendre un service sur un chemin qu'on ne voulait pas.
 */
export type RunLink = "auto" | LinkKind;

export class RequestedLinkUnavailableError extends Error {
  constructor(
    readonly requested: LinkKind,
    readonly reason: "unknown" | "adapter-absent" | "unreachable",
    detail: { readonly serviceName?: string; readonly address?: string } = {},
  ) {
    super(
      reason === "unknown"
        ? "No dedicated link is known for this pair. Connect a cable at both ends and run 'hardline install' to establish one."
        : reason === "adapter-absent"
          ? `The dedicated link runs over ${detail.serviceName ?? "an adapter"}, which is not connected. Plug it in, or drop --link direct to use the network both machines share.`
          : `${detail.serviceName ?? "The adapter"} is connected, but the PC does not answer at ${detail.address ?? "its dedicated address"} over it. Check the cable at the PC end, or drop --link direct.`,
    );
    this.name = "RequestedLinkUnavailableError";
  }
}

export type LinkSelectionDependencies = {
  readonly revive: (profile: TargetProfile) => Promise<ReviveResult>;
  readonly relink: (profile: TargetProfile) => Promise<LinkResolution>;
  /** Revalide le lien que le profil decrit deja, sans en changer. */
  readonly recoverCurrent: (profile: TargetProfile) => Promise<LinkResolution>;
};

/**
 * Le chemin d'une execution, une fois pour toutes les commandes.
 *
 * `auto` reprend le cable des qu'il repond, et ne retombe sur un reseau partage
 * que lorsque l'adaptateur du profil a disparu. Les deux modes explicites ne
 * retombent nulle part : demander un lien et en recevoir un autre sans le savoir
 * est exactement la surprise que le drapeau existe pour supprimer.
 */
export async function selectLinkForRun(
  profile: TargetProfile,
  requested: RunLink,
  dependencies: LinkSelectionDependencies,
): Promise<LinkResolution> {
  const current = profile.linkKind ?? "direct";
  const recoverOrRelink = async (): Promise<LinkResolution> => {
    try {
      return await dependencies.recoverCurrent(profile);
    } catch (error) {
      if (!(error instanceof LinkAdapterUnavailableError)) throw error;
      return await dependencies.relink(profile);
    }
  };

  if (requested === "direct") {
    if (current === "direct") {
      try {
        return await dependencies.recoverCurrent(profile);
      } catch (error) {
        if (!(error instanceof LinkAdapterUnavailableError)) throw error;
        throw new RequestedLinkUnavailableError("direct", "adapter-absent", {
          serviceName: profile.mac.ethernet.serviceName,
        });
      }
    }
    const revived = await dependencies.revive(profile);
    if (revived.kind === "revived") return revived.result;
    throw new RequestedLinkUnavailableError("direct", revived.kind, {
      ...(profile.dormantLink
        ? {
            serviceName: profile.dormantLink.mac.serviceName,
            address: profile.dormantLink.directLink.windowsAddress,
          }
        : {}),
    });
  }

  if (requested === "shared") {
    // Quitter un cable qui marche est un choix, pas un accident : le lien dedie
    // part en sommeil et une execution sans drapeau le reprendra.
    return current === "shared" ? await recoverOrRelink() : await dependencies.relink(profile);
  }

  const revived = await dependencies.revive(profile);
  return revived.kind === "revived" ? revived.result : await recoverOrRelink();
}

function normalized(macAddress: string): string {
  return macAddress.toLowerCase().replaceAll("-", ":");
}

function canonicalId(macAddress: string): string {
  return "ether:" + macAddress.toLowerCase().replaceAll("-", ":");
}

/**
 * Fonction pure. Inscrit dans le manifeste l'adaptateur auquel appartiennent
 * les etats d'adressage deja enregistres.
 *
 * Ces etats ont ete releves quand le lien ne pouvait pas changer d'adaptateur :
 * l'interface visee etait implicite, c'etait celle du profil. Le ré-appariement
 * rend cet implicite faux — apres lui, la configuration nomme une AUTRE
 * interface, et une restauration rendrait le DHCP au mauvais service. On ne
 * devine rien ici : on ecrit l'interface que le profil nommait a l'instant ou
 * ces etats ont ete releves, et seulement la ou rien n'est deja inscrit.
 */
export function stampLinkOwnership(
  manifest: Manifest,
  owner: { readonly serviceName: string; readonly interfaceAlias: string },
): Manifest {
  const fields: Record<string, readonly [string, string]> = {
    "network-mac": ["serviceName", owner.serviceName],
    "network-windows": ["interfaceAlias", owner.interfaceAlias],
  };
  let changed = false;
  const steps: Manifest["steps"] = { ...manifest.steps };
  for (const [step, [field, value]] of Object.entries(fields)) {
    const record = steps[step];
    const previous = record?.previous;
    if (
      !record ||
      typeof previous !== "object" ||
      previous === null ||
      Array.isArray(previous) ||
      (previous as Record<string, unknown>)[field] !== undefined
    ) continue;
    steps[step] = { ...record, previous: { ...(previous as Record<string, unknown>), [field]: value } };
    changed = true;
  }
  return changed ? { ...manifest, steps } : manifest;
}

// --- Frontiere systeme. ---

/**
 * Le releve distant liste TOUS les adaptateurs physiques, contrairement a celui
 * de la recuperation de lien qui ne connait que celui du profil : c'est
 * justement celui-la qui a disparu.
 *
 * Meme forme tabulee que l'autre releve, et pour la meme raison : Windows
 * PowerShell 5.1 peut se bloquer en serialisant des collections NetTCPIP.
 */
export const RELINK_OBSERVATION = [
  "$ErrorActionPreference = 'Stop'",
  "$separator = [char]9",
  "$machineId = [string](Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID",
  '"machine$separator$machineId$separator$([string]$env:COMPUTERNAME)"',
  "$defaultRoutes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.InterfaceIndex })",
  "Get-NetAdapter -Physical -ErrorAction Stop | ForEach-Object {",
  "  $index = [int]$_.ifIndex",
  "  $media = [string]$_.PhysicalMediaType",
  "  $transport = if ($media -match '802\\.3|Ethernet') { 'ethernet' } elseif ($media -match '802\\.11|Wireless') { 'wifi' } elseif ($media -match 'Bluetooth') { 'bluetooth' } else { 'other' }",
  '  $addresses = @(Get-NetIPAddress -InterfaceIndex $index -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { "$($_.IPAddress)/$($_.PrefixLength)" })',
  "  $state = if ([string]$_.Status -eq 'Up') { 'up' } else { 'down' }",
  "  $gateway = if ($defaultRoutes -contains $index) { 'yes' } else { 'no' }",
  '  "adapter$separator$($_.Name)$separator$($_.InterfaceGuid)$separator$($_.InterfaceDescription)$separator$($_.MacAddress)$separator$transport$separator$state$separator$gateway$separator$([bool]$_.Virtual)$separator$($addresses -join \',\')"',
  "}",
].join("\n");

export function parseRelinkObservation(stdout: string): RelinkWindowsObservation {
  let machineId: string | undefined;
  let computerName: string | undefined;
  const adapters: NetworkAdapterObservation[] = [];

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const fields = line.split("\t");
    if (fields[0] === "machine") {
      if (fields.length !== 3) throw new Error("Invalid Windows machine observation.");
      machineId = fields[1]!;
      computerName = fields[2]!;
      continue;
    }
    if (fields[0] !== "adapter" || fields.length !== 10) {
      throw new Error("Invalid Windows adapter observation.");
    }
    const transport = fields[5]!;
    const addresses = fields[9]!.length > 0 ? fields[9]!.split(",") : [];
    adapters.push({
      stableId: fields[2]!,
      alias: fields[1]!,
      hardwareName: fields[3]!,
      macAddress: fields[4]!,
      speedMbps: null,
      physical: true,
      transport: (["ethernet", "wifi", "bluetooth"].includes(transport)
        ? transport
        : "other") as NetworkAdapterObservation["transport"],
      virtual: fields[8]! === "True",
      linkState: fields[6] === "up" ? "up" : "down",
      inUse: addresses.some((address) => !address.startsWith("169.254.")),
      hasDefaultRoute: fields[7] === "yes",
      ipv4Addresses: addresses,
    });
  }

  if (machineId === undefined || computerName === undefined) {
    throw new Error("Windows machine observation is missing.");
  }
  return { machineId, computerName, adapters };
}

export async function observeWindowsForRelink(
  target: SSHTarget,
  runRemote = defaultRunRemote,
): Promise<RelinkWindowsObservation> {
  const result = await runRemote(target, RELINK_OBSERVATION, 30_000);
  if (result.exitCode !== 0) {
    throw new Error("The PC did not answer the relink observation.");
  }
  return parseRelinkObservation(result.stdout);
}
