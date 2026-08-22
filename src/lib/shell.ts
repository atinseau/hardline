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
