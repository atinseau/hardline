import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import type { Config } from "../../src/config";
import {
  parseClientList,
  sendPin,
  listClients,
  unpairClient,
  apiReachable,
  login,
  parseAuthCookie,
  resetSessions,
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

/**
 * Apollo 0.4.6 n'accepte pas le Basic auth : toute requete est precedee d'un
 * POST /api/login qui pose un cookie. Chaque cas empile donc sa reponse de
 * connexion avant celles qu'il attend vraiment.
 */
const COOKIE = "auth=oMDEbr5FVE!kCrpVQd4Z)NMiAa&6L=hsiLg";

function pushLogin(): void {
  responses.push(
    new Response(null, { status: 200, headers: { "set-cookie": `${COOKIE}; Secure; SameSite=Strict; Max-Age=2592000; Path=/` } }),
  );
}

beforeEach(() => {
  resetSessions();
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
    pushLogin();
    responses.push(new Response(JSON.stringify({ status: true }), { status: 200 }));

    const result = await sendPin(CONFIG, CREDS, "4821", "hardline-mac");

    expect(result).toBe(true);
    expect(calls).toHaveLength(2);

    const auth = calls[0]!;
    expect(auth.url).toBe("https://10.10.10.1:47990/api/login");
    expect(JSON.parse(String(auth.init.body))).toEqual({
      username: CREDS.user,
      password: CREDS.password,
    });

    const call = calls[1]!;
    expect(call.url).toBe("https://10.10.10.1:47990/api/pin");
    expect(JSON.parse(String(call.init.body))).toEqual({ pin: "4821", name: "hardline-mac" });

    // Le cookie remplace l'en-tete Basic, qu'Apollo ignore purement et
    // simplement : il ne repond meme pas de WWW-Authenticate.
    expect((call.init.headers as Record<string, string>).cookie).toBe(COOKIE);
    expect((call.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(call.init.tls?.rejectUnauthorized).toBe(false);
  });

  test("sendPin rend ce que le serveur pretend sans qu'aucun appairage ne soit reellement en cours : c'est listClients qui fait foi", async () => {
    pushLogin();
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
    pushLogin();
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
    pushLogin();
    responses.push(new Response(JSON.stringify({ status: true }), { status: 200 }));
    await expect(unpairClient(CONFIG, CREDS, "uuid-9")).resolves.toBeUndefined();
    expect(calls[1]!.url).toBe("https://10.10.10.1:47990/api/clients/unpair");
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ uuid: "uuid-9" });
  });

  /**
   * Sans pushLogin(), le 404 serait consomme par la CONNEXION et le test
   * passerait pour la mauvaise raison : « Connexion refusee (code 404) »
   * contient « 404 » lui aussi. La connexion reussit donc ici, et c'est bien
   * le depairage qui echoue.
   */
  test("leve quand le depairage echoue", async () => {
    pushLogin();
    responses.push(new Response("", { status: 404 }));
    await expect(unpairClient(CONFIG, CREDS, "uuid-inconnu")).rejects.toThrow("404");
    expect(calls[1]!.url).toContain("/api/clients/unpair");
  });
});

describe("apiReachable", () => {
  test("rend true quand /api/config repond", async () => {
    pushLogin();
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

/**
 * Le protocole reel d'Apollo 0.4.6, releve sur la machine : `/` repond 307
 * vers `/login?redir=./`, `/api/clients/list` rend 401 avec ou sans en-tete
 * Authorization et sans jamais emettre de WWW-Authenticate, et
 * POST /api/login pose un cookie `auth`.
 */
describe("session par cookie", () => {
  test("parseAuthCookie garde la valeur entière, séparateurs compris", () => {
    // Valeur reelle emise par le serveur : elle contient ! % & ( ) =
    const brut =
      "auth=oMDEbr5FVE!kCrpVQd4ZtX2MzTmLh%ekDUJVXI1)NMiAa&6L)BkRuXJNoT=hsiLg; Secure; SameSite=Strict; Max-Age=2592000; Path=/";
    expect(parseAuthCookie(brut)).toBe(
      "auth=oMDEbr5FVE!kCrpVQd4ZtX2MzTmLh%ekDUJVXI1)NMiAa&6L)BkRuXJNoT=hsiLg",
    );
  });

  test("parseAuthCookie ignore les autres cookies et l'absence de cookie", () => {
    expect(parseAuthCookie("session=abc; Path=/")).toBeNull();
    expect(parseAuthCookie(null)).toBeNull();
    expect(parseAuthCookie("auth=; Path=/")).toBeNull();
  });

  test("login poste les identifiants en JSON et rend le cookie", async () => {
    pushLogin();
    const cookie = await login(CONFIG, CREDS);
    expect(cookie).toBe(COOKIE);
    expect(calls[0]!.url).toBe("https://10.10.10.1:47990/api/login");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      username: CREDS.user,
      password: CREDS.password,
    });
  });

  test("un identifiant refusé lève à la connexion, pas plus loin", async () => {
    responses.push(new Response("", { status: 401 }));
    await expect(listClients(CONFIG, CREDS)).rejects.toThrow(/Connexion à l'interface Apollo refusée/);
  });

  test("une connexion acceptée sans cookie est signalée", async () => {
    responses.push(new Response(null, { status: 200 }));
    await expect(login(CONFIG, CREDS)).rejects.toThrow(/sans poser de cookie/);
  });

  test("la session est réutilisée : une seule connexion pour deux appels", async () => {
    pushLogin();
    responses.push(new Response(JSON.stringify({ status: true, named_certs: [] }), { status: 200 }));
    responses.push(new Response(JSON.stringify({ status: true, named_certs: [] }), { status: 200 }));

    await listClients(CONFIG, CREDS);
    await listClients(CONFIG, CREDS);

    expect(calls.filter((c) => c.url.endsWith("/api/login"))).toHaveLength(1);
  });

  /**
   * Une session expire au bout de 30 jours, et le mot de passe peut changer
   * sous nos pieds. Sans cette reprise, un cookie caduc ferait echouer
   * l'etape sur un 401 que personne ne saurait relier a l'age du cookie.
   */
  test("un cookie devenu caduc déclenche une reconnexion et un seul rejeu", async () => {
    pushLogin();
    responses.push(new Response(JSON.stringify({ status: true, named_certs: [] }), { status: 200 }));
    await listClients(CONFIG, CREDS);

    responses.push(new Response("", { status: 401 }));
    pushLogin();
    responses.push(
      new Response(JSON.stringify({ status: true, named_certs: [{ name: "Mac", uuid: "u" }] }), { status: 200 }),
    );

    expect(await listClients(CONFIG, CREDS)).toEqual([{ name: "Mac", uuid: "u" }]);
    expect(calls.filter((c) => c.url.endsWith("/api/login"))).toHaveLength(2);
  });
});
