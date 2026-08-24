import { errorMessage } from "./errors";
import { runRemote } from "./ssh";
import type { Config } from "../config";

const IPERF_PORT = 5201;
const IPERF_CLIENT_SECONDS = 2;
const SERVER_STARTUP_MS = 300;

export type ThroughputStats = {
  mbitsPerSecond: number | null;
  seconds: number | null;
  error: string | null;
  /**
   * Vrai quand iperf3 est absent d'une des deux machines. iperf3 n'est pas
   * une dependance du projet (voir la spec) : son absence est rapportee mais
   * ne dit rien de la sante du lien, contrairement a une mesure tentee et
   * ratee.
   */
  unavailable: boolean;
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function unavailableOn(machine: "Mac" | "PC"): ThroughputStats {
  return {
    mbitsPerSecond: null,
    seconds: null,
    error: `not measured: iperf3 is missing on the ${machine}`,
    unavailable: true,
  };
}

function measurementFailed(message: string): ThroughputStats {
  return { mbitsPerSecond: null, seconds: null, error: message, unavailable: false };
}

/** Fonction pure. Toute la logique de lecture est ici, testee sans machine. */
export function parseIperf3Json(stdout: string): ThroughputStats {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return measurementFailed("iperf3 output was empty");
  }

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return measurementFailed("iperf3 output was unreadable; expected JSON");
  }

  if (typeof data !== "object" || data === null) {
    return measurementFailed("iperf3 output was unreadable; expected JSON");
  }

  const record = data as Record<string, unknown>;

  // iperf3 rapporte ses propres echecs (connexion refusee, port occupe...)
  // dans ce champ plutot que par un code de sortie exploitable : son message
  // est deja lisible, on le transmet tel quel.
  if (typeof record.error === "string") {
    return measurementFailed("iperf3 reported a measurement failure");
  }

  const end = record.end as Record<string, unknown> | undefined;
  const sumReceived = end?.sum_received as Record<string, unknown> | undefined;
  const bitsPerSecond = sumReceived?.bits_per_second;
  const seconds = sumReceived?.seconds;

  if (typeof bitsPerSecond !== "number" || typeof seconds !== "number") {
    return measurementFailed(
      "incomplete measurement: iperf3 returned neither throughput nor a usable error",
    );
  }

  return {
    mbitsPerSecond: round1(bitsPerSecond / 1e6),
    seconds: round1(seconds),
    error: null,
    unavailable: false,
  };
}

/**
 * Frontiere systeme. Aucune logique de lecture : le lancement du serveur
 * local, la verification de presence d'iperf3 des deux cotes, et le parsing.
 */
export async function measureThroughput(config: Config): Promise<ThroughputStats> {
  let proc: ReturnType<typeof Bun.spawn> | undefined;

  try {
    // Verification locale, sans aucun aller-retour reseau : si iperf3 manque
    // ici, inutile de deranger le PC.
    if (!Bun.which("iperf3", { PATH: process.env.PATH ?? "" })) {
      return unavailableOn("Mac");
    }

    // -ErrorAction SilentlyContinue rend l'absence d'iperf3 silencieuse cote
    // PowerShell : un code de sortie non nul ici signale donc un vrai
    // probleme (SSH mort en route), pas une simple absence.
    const presence = await runRemote(
      config.ssh,
      "(Get-Command iperf3 -ErrorAction SilentlyContinue).Source",
    );
    if (presence.exitCode !== 0) {
      throw new Error(`could not check iperf3 on the PC (code ${presence.exitCode}).`);
    }
    if (presence.stdout.trim() === "") {
      return unavailableOn("PC");
    }

    // -1 fait sortir le serveur apres un seul client : la mesure se termine
    // d'elle-meme meme si le kill du finally echouait.
    proc = Bun.spawn(["iperf3", "-s", "-1", "-p", String(IPERF_PORT)], {
      stdout: "ignore",
      stderr: "ignore",
    });

    // Laisse le serveur ouvrir son socket avant que le PC ne s'y connecte.
    await Bun.sleep(SERVER_STARTUP_MS);

    // Le client tourne sur le PC via la session SSH existante : les donnees
    // vont PC -> Mac, le sens du flux video que ce diagnostic verifie.
    // runRemote, pas runRemoteJson : ce dernier reencapsule la sortie dans un
    // ConvertTo-Json PowerShell qui detruirait le JSON d'iperf3.
    const result = await runRemote(
      config.ssh,
      `iperf3 -c ${config.mac.ip} -p ${IPERF_PORT} -t ${IPERF_CLIENT_SECONDS} -J`,
    );

    return parseIperf3Json(result.stdout);
  } catch (error) {
    return measurementFailed(errorMessage(error));
  } finally {
    proc?.kill();
  }
}
