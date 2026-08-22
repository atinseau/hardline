import { test, expect, describe, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../src/config";
import type { RemoteResult } from "../../src/lib/ssh";

const IPERF3_OK = readFileSync(join(import.meta.dir, "../assets/iperf3-ok.json"), "utf8");
const IPERF3_KO = readFileSync(join(import.meta.dir, "../assets/iperf3-ko.json"), "utf8");

/**
 * Reponses controlables des deux appels distants de measureThroughput : la
 * verification de presence (Get-Command) et le client iperf3 lui-meme,
 * distingues par le contenu du script envoye.
 */
let presenceResult: RemoteResult = {
  exitCode: 0,
  stdout: "C:\\ProgramData\\chocolatey\\bin\\iperf3.exe",
  stderr: "",
};
let clientResult: RemoteResult = { exitCode: 0, stdout: IPERF3_OK, stderr: "" };

const realSsh = await import("../../src/lib/ssh");

mock.module("../../src/lib/ssh", () => ({
  ...realSsh,
  runRemote: async (_target: unknown, script: string) => {
    if (script.includes("Get-Command iperf3")) return presenceResult;
    return clientResult;
  },
}));

const { parseIperf3Json, measureThroughput } = await import("../../src/lib/throughput");

const CONFIG: Config = {
  mac: { serviceName: "AX88179A", ip: "10.10.10.2", subnetMask: "255.255.255.0" },
  windows: { interfaceAlias: "Ethernet", ip: "10.10.10.1", prefixLength: 24 },
  ssh: { host: "10.10.10.1", user: "arthur", identityFile: "/dev/null", connectTimeoutSec: 8 },
  bootstrapPort: 8080,
};

beforeEach(() => {
  presenceResult = {
    exitCode: 0,
    stdout: "C:\\ProgramData\\chocolatey\\bin\\iperf3.exe",
    stderr: "",
  };
  clientResult = { exitCode: 0, stdout: IPERF3_OK, stderr: "" };
});

describe("parseIperf3Json", () => {
  test("calcule le debit et la duree exacts depuis bits_per_second de la fixture", () => {
    // Recalcule depuis la fixture elle-meme : une valeur codee en dur passerait
    // meme si la formule de conversion etait fausse.
    const fixture = JSON.parse(IPERF3_OK);
    const bitsPerSecond = fixture.end.sum_received.bits_per_second as number;
    const seconds = fixture.end.sum_received.seconds as number;
    const expectedMbits = Math.round((bitsPerSecond / 1e6) * 10) / 10;
    const expectedSeconds = Math.round(seconds * 10) / 10;

    expect(parseIperf3Json(IPERF3_OK)).toEqual({
      mbitsPerSecond: expectedMbits,
      seconds: expectedSeconds,
      error: null,
      unavailable: false,
    });
  });

  test("rapporte le message d'echec d'iperf3 tel quel sur une connexion refusee", () => {
    const result = parseIperf3Json(IPERF3_KO);
    expect(result.mbitsPerSecond).toBeNull();
    expect(result.seconds).toBeNull();
    expect(result.unavailable).toBe(false);
    expect(result.error).toContain("unable to connect");
  });

  test("ne leve pas d'exception sur une sortie vide", () => {
    expect(() => parseIperf3Json("")).not.toThrow();
    const result = parseIperf3Json("");
    expect(result.mbitsPerSecond).toBeNull();
    expect(result.error).not.toBeNull();
  });

  test("ne leve pas d'exception sur du texte qui n'est pas du JSON", () => {
    expect(() => parseIperf3Json("pas du json")).not.toThrow();
    const result = parseIperf3Json("pas du json");
    expect(result.mbitsPerSecond).toBeNull();
    expect(result.error).not.toBeNull();
  });

  test("signale une mesure incomplete quand ni end.sum_received ni error ne sont presents", () => {
    const result = parseIperf3Json(JSON.stringify({ start: {}, intervals: [], end: {} }));
    expect(result.mbitsPerSecond).toBeNull();
    expect(result.unavailable).toBe(false);
    expect(result.error).toContain("mesure incomplète");
  });
});

describe("measureThroughput", () => {
  test("rapporte l'absence d'iperf3 sur le Mac sans interroger le PC", async () => {
    // Bun.which lit process.env.PATH : le vider simule une machine sans
    // iperf3 installe, sans toucher au reseau.
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = await measureThroughput(CONFIG);
      expect(result.unavailable).toBe(true);
      expect(result.mbitsPerSecond).toBeNull();
      expect(result.error).toContain("Mac");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("rapporte l'absence d'iperf3 sur le PC sans la confondre avec une panne", async () => {
    // Get-Command reussit (exitCode 0) mais ne trouve rien : c'est une
    // absence, pas un SSH mort.
    presenceResult = { exitCode: 0, stdout: "", stderr: "" };
    const result = await measureThroughput(CONFIG);
    expect(result.unavailable).toBe(true);
    expect(result.mbitsPerSecond).toBeNull();
    expect(result.error).toContain("PC");
  });

  test("distingue un SSH mort pendant la verification de presence d'une simple absence", async () => {
    presenceResult = {
      exitCode: 255,
      stdout: "",
      stderr: "ssh: connect to host 10.10.10.1 port 22: Operation timed out",
    };
    const result = await measureThroughput(CONFIG);
    expect(result.unavailable).toBe(false);
    expect(result.mbitsPerSecond).toBeNull();
    expect(result.error).not.toBeNull();
  });

  test("mesure avec succes quand iperf3 est present des deux cotes", async () => {
    const result = await measureThroughput(CONFIG);
    expect(result.unavailable).toBe(false);
    expect(result.error).toBeNull();
    expect(result.mbitsPerSecond).toBe(946.5);
  });

  test("rapporte un echec de connexion comme une mesure ratee, pas comme une absence", async () => {
    clientResult = { exitCode: 1, stdout: IPERF3_KO, stderr: "" };
    const result = await measureThroughput(CONFIG);
    expect(result.unavailable).toBe(false);
    expect(result.mbitsPerSecond).toBeNull();
    expect(result.error).toContain("unable to connect");
  });
});
