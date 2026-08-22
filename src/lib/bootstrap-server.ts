import { hostname } from "node:os";
import templatePath from "../assets/bootstrap.ps1" with { type: "file" };

export type BootstrapVars = {
  publicKey: string;
  interfaceAlias: string;
  windowsIp: string;
  prefixLength: number;
};

const MARKERS: Record<string, keyof BootstrapVars> = {
  "@@PUBLIC_KEY@@": "publicKey",
  "@@INTERFACE_ALIAS@@": "interfaceAlias",
  "@@WINDOWS_IP@@": "windowsIp",
  "@@PREFIX_LENGTH@@": "prefixLength",
};

export function renderBootstrapScript(
  template: string,
  vars: BootstrapVars,
): string {
  // On n'inspecte que les valeurs reellement substituees : l'appelant passe un objet
  // plus large (port, gabarit), et le gabarit contient lui-meme des apostrophes.
  for (const key of Object.values(MARKERS)) {
    const value = vars[key];
    if (typeof value === "string" && value.includes("'")) {
      // Les marqueurs sont places entre apostrophes cote PowerShell.
      throw new Error(
        `Valeur invalide\u00a0: une apostrophe casserait le script PowerShell (${value})`,
      );
    }
  }

  let script = template;
  for (const [marker, key] of Object.entries(MARKERS)) {
    script = script.replaceAll(marker, String(vars[key]));
  }

  const leftover = script.match(/@@[A-Z_]+@@/);
  if (leftover) {
    throw new Error(
      `Marqueur non substitué dans le script d'amorçage\u00a0: ${leftover[0]}`,
    );
  }

  return script;
}

export async function loadBootstrapTemplate(): Promise<string> {
  return await Bun.file(templatePath).text();
}

export async function serveBootstrap(
  options: BootstrapVars & { port: number; template?: string },
): Promise<{ url: string; port: number; stop: () => void }> {
  const template = options.template ?? (await loadBootstrapTemplate());
  const script = renderBootstrapScript(template, options);

  const server = Bun.serve({
    hostname: "0.0.0.0",
    port: options.port,
    routes: {
      "/bootstrap.ps1": () =>
        new Response(script, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });

  // Un serveur TCP (par opposition a un socket unix) a toujours un port assigne.
  const port = server.port as number;

  return {
    url: `http://localhost:${port}`,
    port,
    stop: () => server.stop(true),
  };
}

/** L'adresse a taper sur le PC : le nom mDNS du Mac, resolu nativement par Windows 11. */
export function localBootstrapUrl(port: number): string {
  return `http://${hostname()}:${port}/bootstrap.ps1`;
}
