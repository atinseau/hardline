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

  test("sendPin rend false quand le serveur repond 200 avec status: false", async () => {
    responses.push(new Response(JSON.stringify({ status: false }), { status: 200 }));
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
