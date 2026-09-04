import { $ } from "bun";

const MAGIC_PACKET_BYTES = 102;
const PREAMBLE_BYTES = 6;
const MAC_BYTES = 6;
const MAC_REPETITIONS = 16;
const WOL_PORT = 9;
const WOL_PACKET_COUNT = 10;
const WOL_PACKET_INTERVAL_MS = 250;

const MAC_PATTERN = /^([0-9a-fA-F]{1,2}:){5}[0-9a-fA-F]{1,2}$/;

/** Fonction pure. Compose les 102 octets : 6 fois 0xFF puis 16 fois l'adresse. */
export function magicPacket(mac: string): Uint8Array {
  const normalizedMac = mac.replaceAll("-", ":");
  if (!MAC_PATTERN.test(normalizedMac)) {
    throw new Error(`Invalid hardware address: ${mac}`);
  }

  const macBytes = normalizedMac.split(":").map((part) => Number.parseInt(part, 16));

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
    for (let sent = 0; sent < WOL_PACKET_COUNT; sent++) {
      socket.send(packet, WOL_PORT, broadcast);
      if (sent < WOL_PACKET_COUNT - 1) await Bun.sleep(WOL_PACKET_INTERVAL_MS);
    }
  } finally {
    socket.close();
  }
}
