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
 * macOS ne laisse pas n'importe quel binaire joindre le reseau local.
 *
 * Depuis macOS 15, toute connexion vers une adresse du LAN exige l'autorisation
 * « Reseau local », accordee a l'application RESPONSABLE — le terminal, pour un
 * outil en ligne de commande. Les binaires d'Apple (`ssh`, `curl`, `nc`) en sont
 * exemptes, pas les autres. Un terminal sans cette autorisation laisse donc
 * passer tout le canal SSH de hardline et coupe TOUTES ses requetes vers Apollo,
 * ce que Bun rapporte par un laconique « Was there a typo in the url or port? ».
 *
 * Mesure sur la machine : la meme requete, a la meme seconde, rend 200 depuis un
 * processus autorise et `FailedToOpenSocket` depuis iTerm, pendant que `curl`
 * obtient 307 des deux cotes.
 */
export function estBloqueParMacos(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "FailedToOpenSocket";
}

/** Le seul endroit ou une requete Apollo part, donc le seul ou ce refus se nomme. */
async function apolloRequest(url: string, init: RequestInit & { tls: { rejectUnauthorized: boolean } }): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (!estBloqueParMacos(error)) throw error;
    throw new Error(
      `macOS a refusé la connexion vers ${url}\u00a0: l'application qui a lancé ` +
        "hardline n'a pas l'autorisation «\u00a0Réseau local\u00a0». Le lien SSH, lui, " +
        "fonctionne, parce que les binaires d'Apple en sont exemptés. Ouvrir " +
        "Réglages Système → Confidentialité et sécurité → Réseau local, y activer " +
        "le terminal utilisé, puis relancer «\u00a0hardline install\u00a0». Si la case " +
        "est DÉJÀ cochée, quitter complètement le terminal et le rouvrir\u00a0: macOS " +
        "fige cette décision au lancement du processus, et un terminal ouvert avant " +
        "l'autorisation continue de la refuser à tout ce qu'il lance.",
    );
  }
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
  const response = await apolloRequest(apolloUrl(config, "/api/login"), {
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

/** Au-dela, Apollo ne repond pas : on rend la main plutot que d'attendre. */
export const APOLLO_TIMEOUT_MS = 20_000;

async function apolloFetch(
  config: Config,
  creds: ApolloCredentials,
  path: string,
  init: ApolloRequestInit = {},
): Promise<Response> {
  const send = (cookie: string) =>
    apolloRequest(apolloUrl(config, path), {
      method: init.method,
      body: init.body,
      headers: { ...init.headers, cookie },
      tls: { rejectUnauthorized: false },
      // Apollo garde une requete ouverte quand elle attend un pair qui ne vient
      // pas : un PIN envoye a cote d'une session, et l'installation reste
      // suspendue indefiniment sans rien dire. Une requete qui n'aboutit pas
      // doit rendre la main, pour que l'appairage puisse recommencer.
      signal: AbortSignal.timeout(APOLLO_TIMEOUT_MS),
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

/**
 * Le port GameStream ecoute-t-il ?
 *
 * Apollo ouvre son interface web AVANT ce port-la. Attendre l'API seule, c'est
 * lancer Moonlight sur un serveur qui ne l'ecoute pas encore : il repond « Was
 * there a typo in the url or port? » et l'appairage echoue sur un serveur qui
 * allait etre pret. Mesure sur la machine, sur une premiere installation
 * d'Apollo.
 */
export async function gamestreamListening(
  config: Config,
  timeoutMs = 2_000,
): Promise<boolean> {
  // Apollo sert GameStream en clair un port sous son API. Le point /serverinfo
  // repond sans appairage, c'est exactement ce que Moonlight interroge.
  const port = config.apollo.apiPort - 1;
  try {
    const response = await apolloRequest(`http://${config.ssh.host}:${port}/serverinfo`, {
      signal: AbortSignal.timeout(timeoutMs),
      tls: { rejectUnauthorized: false },
    });
    return response.ok;
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
