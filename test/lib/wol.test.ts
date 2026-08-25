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

  test("accepte l'adresse persistée au format Windows avec des tirets", () => {
    const packet = magicPacket("E8-9C-25-2A-70-E1");
    const macBytes = [0xe8, 0x9c, 0x25, 0x2a, 0x70, 0xe1];
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
