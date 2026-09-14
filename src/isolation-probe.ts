import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export function verifyIsolation(binary: string, runtimeDirectory: string, workspace: string, parent: string) {
  const nonce = randomUUID(); const publicFile = join(workspace, 'public-probe.txt'); const privateFile = join(parent, `private-probe-${nonce}.txt`);
  writeFileSync(publicFile, nonce, { mode: 0o600 }); writeFileSync(privateFile, nonce, { mode: 0o600 });
  const run = (command: string[]) => spawnSync(binary, ['sandbox', '-P', 'poc', '-C', workspace, '--', ...command], {
    cwd: workspace, env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', CODEX_HOME: runtimeDirectory }, encoding: 'utf8', timeout: 10_000, maxBuffer: 32_768,
  });
  const allowed = run(['/bin/cat', publicFile]);
  const denied = run(['/bin/cat', privateFile]);
  const write = run(['/bin/mkdir', join(parent, `forbidden-write-${nonce}`)]);
  const result = { positiveRead: allowed.status === 0 && allowed.stdout === nonce, privateReadDenied: denied.status !== 0 && !denied.stdout.includes(nonce),
    privateWriteDenied: write.status !== 0, exitCodes: [allowed.status, denied.status, write.status] };
  writeFileSync(join(runtimeDirectory, 'isolation.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  if (!result.positiveRead || !result.privateReadDenied || !result.privateWriteDenied) throw new Error('ISOLATION_PROBE_FAILED: model has not been started');
  return result;
}
