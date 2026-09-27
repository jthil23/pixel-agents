import { execFile } from 'node:child_process';

export type ExecFn = (file: string, args: string[], timeoutMs: number) => Promise<string>;

export const OMP_EXEC_TIMEOUT_MS = 5000;

export const execFileText: ExecFn = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });

export async function transcriptLinkFor(
  sessionId: string,
  exec: ExecFn,
): Promise<{ url?: string; reason?: string }> {
  let hosts: { instanceId?: unknown; sessionId?: unknown }[];
  try {
    hosts =
      (
        JSON.parse(await exec('omp', ['collab', 'list', '--json'], OMP_EXEC_TIMEOUT_MS)) as {
          hosts?: typeof hosts;
        }
      ).hosts ?? [];
  } catch {
    return { reason: 'omp collab list failed' };
  }
  const host = hosts.find((h) => h.sessionId === sessionId && typeof h.instanceId === 'string');
  if (!host) return { reason: 'not hosted: enable collab.autoStart' };
  try {
    const out = JSON.parse(
      await exec(
        'omp',
        ['collab', 'link', host.instanceId as string, '--view', '--json'],
        OMP_EXEC_TIMEOUT_MS,
      ),
    ) as { url?: unknown };
    return typeof out.url === 'string'
      ? { url: out.url }
      : { reason: 'omp collab link returned no url' };
  } catch {
    return { reason: 'omp collab link failed' };
  }
}
