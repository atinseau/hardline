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

function authHeader(creds: ApolloCredentials): string {
  return `Basic ${Buffer.from(`${creds.user}:${creds.password}`).toString("base64")}`;
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
  return fetch(apolloUrl(config, path), {
    method: init.method,
    body: init.body,
    headers: { ...init.headers, Authorization: authHeader(creds) },
    tls: { rejectUnauthorized: false },
  });
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
