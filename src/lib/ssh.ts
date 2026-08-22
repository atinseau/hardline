export type SSHTarget = {
  host: string;
  user: string;
  identityFile: string;
  connectTimeoutSec?: number;
};

export type RemoteResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly result: RemoteResult,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}

/**
 * PowerShell attend du UTF-16LE encode en Base64. Ce detour supprime tout
 * probleme de quoting et d'accents entre macOS, SSH, cmd.exe et PowerShell.
 */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

const OUTPUT_UTF8 = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()";

/**
 * -EncodedCommand ne regle que l'ENTREE du script. La sortie de PowerShell part
 * dans la page de code OEM de la console — cp850 sur un Windows francais — ce qui
 * mutile les accents au retour. Ce prefixe force une sortie UTF-8 sans marque
 * d'ordre des octets.
 */
export function withOutputEncoding(script: string): string {
  return `${OUTPUT_UTF8}\n${script}`;
}

export function buildSSHArgs(target: SSHTarget, remoteCommand: string): string[] {
  return [
    "ssh",
    "-i",
    target.identityFile,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `ConnectTimeout=${target.connectTimeoutSec ?? 8}`,
    `${target.user}@${target.host}`,
    remoteCommand,
  ];
}

// --- Frontière système. ---

export async function runRemote(
  target: SSHTarget,
  script: string,
  timeoutMs = 120_000,
): Promise<RemoteResult> {
  const remoteCommand = `powershell -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(withOutputEncoding(script))}`;

  const proc = Bun.spawn(buildSSHArgs(target, remoteCommand), {
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Parse une sortie JSON de PowerShell. Gère les trois cas de ConvertTo-Json :
 * - $null ou vide -> '[]'
 * - un objet seul -> JSON objet nu (enveloppé dans un tableau par @($result))
 * - plusieurs objets -> JSON tableau
 */
export function parseRemoteJson<T>(stdout: string): T[] {
  if (stdout === "") return [];

  try {
    return JSON.parse(stdout) as T[];
  } catch {
    throw new Error(
      `Sortie distante illisible, JSON attendu\u00a0: ${stdout.slice(0, 200)}`,
    );
  }
}

/**
 * Execute un script dont la derniere expression est convertie en JSON cote
 * Windows. Renvoie toujours un tableau : ConvertTo-Json emet un objet nu
 * quand il n'y a qu'un element, et rien du tout quand il n'y en a aucun.
 */
export async function runRemoteJson<T>(
  target: SSHTarget,
  script: string,
  timeoutMs = 120_000,
): Promise<T[]> {
  const wrapped = `$ErrorActionPreference = 'Stop'
$result = & { ${script} }
if ($null -eq $result) { '[]' } else { ConvertTo-Json -InputObject @($result) -Depth 6 -Compress }`;

  const result = await runRemote(target, wrapped, timeoutMs);

  if (result.exitCode !== 0) {
    throw new RemoteError(
      `Commande distante en échec (code ${result.exitCode})\u00a0: ${result.stderr || result.stdout}`,
      result,
    );
  }

  try {
    return parseRemoteJson(result.stdout);
  } catch (err) {
    throw new RemoteError(
      err instanceof Error ? err.message : "Erreur de parsing inconnue",
      result,
    );
  }
}

/**
 * Execute un script de modification, en verifiant que tout a reussi.
 * Contrairement a runRemote, leve une exception si le code de retour est
 * non-zero, sans quoi les echecs distants (elevations de privilege refusees,
 * par exemple) passent inapercus.
 */
export async function runRemoteChecked(
  target: SSHTarget,
  script: string,
  timeoutMs = 120_000,
): Promise<RemoteResult> {
  const wrapped = `$ErrorActionPreference = 'Stop'
${script}`;

  const result = await runRemote(target, wrapped, timeoutMs);

  if (result.exitCode !== 0) {
    throw new RemoteError(
      `Commande distante en échec (code ${result.exitCode})\u00a0: ${result.stderr || result.stdout}`,
      result,
    );
  }

  return result;
}
