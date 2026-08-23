import type { Config } from "../config";

export type ApolloClient = { name: string; uuid: string };

export type ApolloCredentials = { user: string; password: string };

type ApolloRequestInit = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
};

function apolloUrl(config: Config, path: string): string {
  return `https://${config.ssh.host}:${config.apollo.apiPort}${path}`;
}

/**
 * Apollo 0.4.6 n'accepte PAS l'authentification HTTP « Basic ». Mesure sur la
 * machine : `/` repond 307 vers `/login?redir=./`, et `/api/clients/list`
 * rend 401 avec le meme corps qu'on envoie un en-tete Authorization ou pas —
 * sans jamais emettre de `WWW-Authenticate`. L'en-tete etait donc ignore, et
 * le 401 n'avait rien a voir avec le mot de passe : la meme requete echouait
 * depuis le PC lui-meme, par curl, sur 127.0.0.1, une minute apres un
 * `--creds` reussi.
 *
 * Le protocole reel, lu dans l'interface d'Apollo (assets\web\assets\login-*.js) :
 *   fetch("./api/login", {method: "POST", body: JSON.stringify({username, password})})
 * puis un cookie `auth` que le serveur pose et que toute requete suivante
 * doit porter.
 */
const AUTH_COOKIE = "auth";

/** Le cookie de session, par hote. Une session vaut 30 jours cote serveur. */
const sessions = new Map<string, string>();

/**
 * Oublie les sessions en cache. Utile aux tests, ou l'etat de module
 * survivrait d'un cas au suivant et masquerait la reconnexion.
 */
export function resetSessions(): void {
  sessions.clear();
}

function sessionKey(config: Config, creds: ApolloCredentials): string {
  return `${config.ssh.host}:${config.apollo.apiPort}:${creds.user}`;
}

/**
 * Extrait le cookie d'authentification d'un Set-Cookie. Sa VALEUR contient
 * des caracteres qui ressemblent a des separateurs — le serveur en emet qui
 * portent `!`, `%`, `&`, `(`, `)`, `=` — donc on decoupe sur le PREMIER `=`
 * seulement, et sur le premier `;` qui suit, jamais avec une expression
 * reguliere gourmande qui tronquerait le jeton en silence.
 */
export function parseAuthCookie(setCookie: string | null): string | null {
  if (setCookie === null) return null;

  for (const part of setCookie.split(/,(?=\s*[A-Za-z_-]+=)/)) {
    const pair = part.trim().split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== AUTH_COOKIE) continue;

    const value = pair.slice(eq + 1);
    if (value !== "") return `${AUTH_COOKIE}=${value}`;
  }
  return null;
}

/**
 * POST /api/login. Rend le cookie a presenter ensuite, et le met en cache.
 * Un identifiant refuse leve ici, ou le diagnostic est net, plutot que de
 * laisser chaque appel suivant rendre un 401 anonyme.
 */
export async function login(
  config: Config,
  creds: ApolloCredentials,
): Promise<string> {
  const response = await fetch(apolloUrl(config, "/api/login"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: creds.user, password: creds.password }),
    tls: { rejectUnauthorized: false },
  });

  if (!response.ok) {
    throw new Error(
      `Connexion à l'interface Apollo refusée (code ${response.status})\u00a0: ` +
        `vérifier que le compte «\u00a0${creds.user}\u00a0» et son mot de passe sont ` +
        "bien ceux posés sur le PC.",
    );
  }

  const cookie = parseAuthCookie(response.headers.get("set-cookie"));
  if (cookie === null) {
    throw new Error(
      "L'interface Apollo a accepté la connexion sans poser de cookie de session.",
    );
  }

  sessions.set(sessionKey(config, creds), cookie);
  return cookie;
}

/**
 * Point d'entree unique des appels HTTP. Le relachement TLS est confine ici,
 * jamais par NODE_TLS_REJECT_UNAUTHORIZED : cette variable n'est pas fiable
 * sous Bun et porterait bien au-dela de ce client.
 */
async function apolloFetch(
  config: Config,
  creds: ApolloCredentials,
  path: string,
  init: ApolloRequestInit = {},
): Promise<Response> {
  const send = (cookie: string) =>
    fetch(apolloUrl(config, path), {
      method: init.method,
      body: init.body,
      headers: { ...init.headers, cookie },
      tls: { rejectUnauthorized: false },
    });

  const cached = sessions.get(sessionKey(config, creds));
  if (cached !== undefined) {
    const response = await send(cached);
    // Une session expire, ou le mot de passe change sous nos pieds : on se
    // reconnecte UNE fois et on rejoue. Sans cela, un cache devenu caduc
    // ferait echouer l'etape sur un 401 que personne ne saurait relier a
    // l'age du cookie.
    if (response.status !== 401) return response;
    sessions.delete(sessionKey(config, creds));
  }

  return send(await login(config, creds));
}

/** Fonction pure. Lit la reponse de /api/clients/list. */
export function parseClientList(body: unknown): ApolloClient[] {
  if (typeof body !== "object" || body === null) return [];

  const namedCerts = (body as Record<string, unknown>).named_certs;
  if (!Array.isArray(namedCerts)) return [];

  const clients: ApolloClient[] = [];
  for (const entry of namedCerts) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name === "string" && typeof record.uuid === "string") {
      clients.push({ name: record.name, uuid: record.uuid });
    }
  }
  return clients;
}

/**
 * POST /api/pin. Rend ce que le serveur pretend, sans le croire : ce point
 * d'entree est documente comme repondant parfois "c'est fait" alors qu'aucune
 * session d'appairage n'est en attente. C'est listClients qui fait foi.
 */
export async function sendPin(
  config: Config,
  creds: ApolloCredentials,
  pin: string,
  name: string,
): Promise<boolean> {
  try {
    const response = await apolloFetch(config, creds, "/api/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin, name }),
    });
    if (!response.ok) return false;

    const body = (await response.json()) as unknown;
    if (typeof body === "object" && body !== null && "status" in body) {
      return Boolean((body as Record<string, unknown>).status);
    }
    return true;
  } catch {
    return false;
  }
}

/** GET /api/clients/list. C'est LUI qui fait foi, pas la reponse de sendPin. */
export async function listClients(
  config: Config,
  creds: ApolloCredentials,
): Promise<ApolloClient[]> {
  const response = await apolloFetch(config, creds, "/api/clients/list", {
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(
      `liste des clients Apollo illisible (code ${response.status})`,
    );
  }
  const body = (await response.json()) as unknown;
  return parseClientList(body);
}

/** POST /api/clients/unpair pour un client donne. */
export async function unpairClient(
  config: Config,
  creds: ApolloCredentials,
  uuid: string,
): Promise<void> {
  const response = await apolloFetch(config, creds, "/api/clients/unpair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uuid }),
  });
  if (!response.ok) {
    throw new Error(
      `échec du dépairage Apollo pour ${uuid} (code ${response.status})`,
    );
  }
}

/** GET /api/config. Sert de test de vie authentifie. */
export async function apiReachable(
  config: Config,
  creds: ApolloCredentials,
): Promise<boolean> {
  try {
    const response = await apolloFetch(config, creds, "/api/config", {
      method: "GET",
    });
    return response.ok;
  } catch {
    return false;
  }
}
