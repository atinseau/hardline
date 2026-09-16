import {
  DirectLinkUnavailableError,
  validateMacIdentity,
  validateWindowsIdentity,
  type LinkRecoveryAdapters,
  type LinkRecoveryResult,
} from "./link-recovery";
import { parseIpv4Cidr } from "./network";
import type { DirectLink, TargetProfile } from "./types";

/**
 * Sur un lien partage, « recuperer » ne veut pas dire reparer.
 *
 * Hardline n'a rien pose sur ce lien, donc il n'a rien a y remettre : les
 * adresses appartiennent au reseau et derivent au gre des baux DHCP. Recuperer,
 * c'est RELIRE ou les deux machines se trouvent aujourd'hui, verifier que c'est
 * toujours la meme paire, et reecrire le profil. Aucune mutation, d'aucun cote —
 * et c'est precisement pourquoi ce chemin tient en quelques dizaines de lignes
 * la ou le lien direct doit orchestrer une migration d'adressage.
 */
export async function recoverSharedLink(
  profile: TargetProfile,
  adapters: LinkRecoveryAdapters,
): Promise<LinkRecoveryResult> {
  const mac = await adapters.macObservation.observeMacLink();
  validateMacIdentity(profile, mac);

  const direct = await adapters.strictDirectProbe.probeDirect(profile);
  if (direct.kind === "reachable") {
    validateWindowsIdentity(profile, direct.windows);
    // Le PC repond a l'adresse du profil par le chemin du profil : le lien
    // decrit est le lien reel, il n'y a rien a corriger.
    return { profile, resolution: "validated" };
  }

  const recovery = await adapters.recoveryChannel.observeRecovery(profile);
  if (recovery.kind === "pc-inaccessible") {
    throw new DirectLinkUnavailableError("pc-inaccessible");
  }
  validateWindowsIdentity(profile, recovery.windows);

  const link = commonSubnet(
    mac.selectedEthernet.addresses,
    recovery.windows.selectedEthernet.addresses,
  );
  if (!link) throw new DirectLinkUnavailableError("pc-alive/direct-link-broken");

  const updated: TargetProfile = {
    ...profile,
    revision: profile.revision + 1,
    directLink: link,
    mac: {
      ...profile.mac,
      hostAliases: mac.hostAliases,
      ethernet: {
        ...profile.mac.ethernet,
        interfaceId: mac.selectedEthernet.interfaceId,
        serviceName: mac.selectedEthernet.serviceName,
      },
    },
    windows: {
      ...profile.windows,
      hostAliases: recovery.windows.hostAliases,
      ethernet: {
        ...profile.windows.ethernet,
        interfaceAlias: recovery.windows.selectedEthernet.interfaceAlias,
      },
    },
  };

  // Le profil n'est reecrit qu'apres que le lien qu'il decrit a repondu. Un
  // releve pris par le canal de secours prouve que le PC est vivant, pas que le
  // Mac peut le joindre par l'adaptateur choisi.
  const proof = await adapters.strictDirectProbe.probeDirect(updated);
  if (proof.kind !== "reachable") {
    throw new DirectLinkUnavailableError("pc-alive/direct-link-broken");
  }
  validateWindowsIdentity(profile, proof.windows);
  await adapters.profilePersistence.persistProfileAtomically(updated);
  return { profile: updated, resolution: "recovered" };
}

/**
 * Fonction pure. Le premier sous-reseau que les deux machines partagent, lu
 * dans leurs adresses telles qu'elles sont maintenant.
 */
export function commonSubnet(
  macAddresses: readonly string[],
  windowsAddresses: readonly string[],
): DirectLink | null {
  for (const macEntry of macAddresses) {
    const macParsed = usable(macEntry);
    if (!macParsed) continue;
    for (const windowsEntry of windowsAddresses) {
      const windowsParsed = usable(windowsEntry);
      if (!windowsParsed) continue;
      if (
        macParsed.prefixLength !== windowsParsed.prefixLength ||
        macParsed.network !== windowsParsed.network ||
        macParsed.address === windowsParsed.address
      ) continue;
      return {
        subnet: macParsed.network,
        macAddress: macParsed.address,
        windowsAddress: windowsParsed.address,
        prefixLength: macParsed.prefixLength,
      };
    }
  }
  return null;
}

function usable(
  entry: string,
): { address: string; prefixLength: number; network: string } | null {
  const parsed = parseIpv4Cidr(entry);
  if (parsed.kind === "invalid") return null;
  const address = entry.split("/")[0]!;
  if (address.startsWith("169.254.") || address.startsWith("127.")) return null;
  if (parsed.prefixLength < 1 || parsed.prefixLength > 30) return null;
  return { address, prefixLength: parsed.prefixLength, network: parsed.cidr };
}
