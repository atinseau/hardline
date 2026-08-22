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

const SERVICES_DISABLED = `An asterisk (*) denotes that a network service is disabled.
(1) *AX88179A
(Hardware Port: AX88179A, Device: en14)
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
      enabled: true,
    });
  });

  test("ignore la ligne d'avertissement en tete", () => {
    expect(parseNetworkServices(SERVICES).map((s) => s.name)).toEqual([
      "Thunderbolt Ethernet",
      "AX88179A",
      "Wi-Fi",
    ]);
  });

  test("retire l'asterisque et marque le service desactive", () => {
    const [service] = parseNetworkServices(SERVICES_DISABLED);
    expect(service?.name).toBe("AX88179A");
    expect(service?.enabled).toBe(false);
  });

  test("marque actifs les services sans asterisque", () => {
    expect(parseNetworkServices(SERVICES).every((s) => s.enabled)).toBe(true);
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
