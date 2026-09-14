import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assertRunDirectory } from './db.ts';
import { loopbackUrl } from './http.ts';
import { renderTask, type AgentTask } from './agent-input.ts';
import type { AgentEvidence } from './agent-verdict.ts';
import { verifyIsolation } from './isolation-probe.ts';

export interface LaunchOptions {
  directory: string; codexBinary: string; mode: 'live' | 'mock'; model: string;
  modelProxyUrl: string; modelProxyToken: string; mcpUrl: string; grantToken: string;
  task: AgentTask; timeoutMs: number; resume?: { runtimeDirectory: string; sessionId: string };
  instanceId?: string; inheritProcessGroup?: boolean;
}
export class CodexRun {
  child: ChildProcess; directory: string; runtimeDirectory: string; evidence: AgentEvidence;
  done: Promise<AgentEvidence>; outputBytes = 0; usage: unknown[] = [];
  closed = false;
  private ownGroup: boolean;
  constructor(options: LaunchOptions) {
    const parent = assertRunDirectory(options.directory);
    loopbackUrl(options.modelProxyUrl); loopbackUrl(options.mcpUrl);
    if (options.timeoutMs < 1000 || options.timeoutMs > 180_000) throw new Error('Invalid bounded agent timeout');
    if(options.instanceId&&!/^[0-9a-f-]{36}$/.test(options.instanceId))throw new Error('Invalid instance id');
    this.ownGroup=!options.inheritProcessGroup;
    this.directory = join(parent, `agent-${options.instanceId??randomUUID()}`); mkdirSync(this.directory, { mode: 0o700 });
    this.runtimeDirectory = options.resume?.runtimeDirectory ?? join(this.directory, 'runtime');
    // Resume coordinates must point to a runtime created inside this owned episode, never --last or a user session.
    if (options.resume) {
      const suffix = this.runtimeDirectory.slice(parent.length);
      if (!this.runtimeDirectory.startsWith(parent) || !/^\/agent-[0-9a-f-]{36}\/runtime$/.test(suffix)
        || !/^[a-zA-Z0-9-]+$/.test(options.resume.sessionId) || realpathSync(this.runtimeDirectory) !== this.runtimeDirectory
        || lstatSync(join(this.runtimeDirectory, 'config.toml')).isSymbolicLink()) throw new Error('Unowned session');
      const prior = JSON.parse(readFileSync(join(this.runtimeDirectory, '..', 'run.json'), 'utf8'));
      if (prior.sessionId !== options.resume.sessionId || prior.taskId !== options.task.taskId || prior.mode !== options.mode) throw new Error('Session provenance mismatch');
    }
    mkdirSync(this.runtimeDirectory, { recursive: true, mode: 0o700 });
    const workspace = join(this.directory, 'workspace'); mkdirSync(workspace, { mode: 0o700 });
    const config = [
      `model=${JSON.stringify(options.model)}`, 'model_provider="poc"', 'model_reasoning_effort="low"',
      'approval_policy="never"', 'web_search="disabled"', 'default_permissions="poc"',
      'cli_auth_credentials_store="ephemeral"', 'check_for_update_on_startup=false',
      '[shell_environment_policy]', 'inherit="none"',
      '[features]', 'shell_tool=false', 'unified_exec=false', 'multi_agent=false', 'apps=false',
      'hooks=false', 'memories=false', 'shell_snapshot=false', 'enable_request_compression=false',
      '[permissions.poc.filesystem]', '":root"="deny"', '":minimal"="read"', '":tmpdir"="deny"', '":slash_tmp"="deny"',
      '[permissions.poc.filesystem.":workspace_roots"]', '"."="read"',
      '[permissions.poc.network]', 'enabled=false',
      '[model_providers.poc]', 'name="Isolated acceptance provider"', `base_url=${JSON.stringify(options.modelProxyUrl)}`,
      'wire_api="responses"', 'env_key="POC_MODEL_PROXY_TOKEN"', 'request_max_retries=0', 'stream_max_retries=0',
      '[mcp_servers.governance]', `url=${JSON.stringify(options.mcpUrl)}`, 'bearer_token_env_var="POC_RUN_GRANT"',
      'required=true', 'startup_timeout_sec=10', 'tool_timeout_sec=10',
      'enabled_tools=["inventory_reservation_submit","operation_get","operation_cancel_request"]',
      ...['inventory_reservation_submit','operation_get','operation_cancel_request'].flatMap(name => [`[mcp_servers.governance.tools.${name}]`, 'approval_mode="approve"']),
    ].join('\n') + '\n';
    writeFileSync(join(this.runtimeDirectory, 'config.toml'), config, { mode: 0o600 });
    const input = renderTask(options.task); writeFileSync(join(this.directory, 'task.txt'), input, { mode: 0o600 });
    verifyIsolation(options.codexBinary, this.runtimeDirectory, workspace, parent);
    this.evidence = { mode: options.mode, sessionId: null, exitCode: null, stopReason: null, messages: [], toolEvents: [], errors: [] };
    const args = options.resume ? ['exec', 'resume', options.resume.sessionId, '--skip-git-repo-check', '--json', '-']
      : ['exec', '--json', '--skip-git-repo-check', '--cd', workspace, '-'];
    // CODEX_HOME is the documented child-runtime configuration directory, never a shell scratch/deletion variable.
    this.child = spawn(options.codexBinary, args, { cwd: workspace, detached: this.ownGroup && process.platform !== 'win32', stdio: ['pipe','pipe','pipe'],
      env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', CODEX_HOME: this.runtimeDirectory,
        POC_MODEL_PROXY_TOKEN: options.modelProxyToken, POC_RUN_GRANT: options.grantToken } });
    const redact = (text: string) => text.replaceAll(options.modelProxyToken, '[REDACTED]').replaceAll(options.grantToken, '[REDACTED]');
    let partial = '';
    this.child.stdout!.on('data', raw => {
      this.outputBytes += raw.length;
      if (this.outputBytes > 2_000_000) { this.stop('OUTPUT_LIMIT'); return; }
      partial += raw.toString('utf8');
      let end: number;
      while ((end = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, end); partial = partial.slice(end + 1); const at = Date.now();
        try {
          const event = JSON.parse(line);
          if (event.type === 'thread.started') this.evidence.sessionId = event.thread_id;
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') this.evidence.messages.push({ text: event.item.text, at });
          if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') this.evidence.toolEvents!.push({ item: event.item, at });
          if (event.type === 'turn.completed') this.usage.push(event.usage);
          if (event.type === 'error' || event.type === 'turn.failed') this.evidence.errors!.push({at,message:redact(String(event.message??event.error?.message??''))});
          // Do not archive private reasoning contents; keep public actions and outcomes only.
          if (event.item?.type !== 'reasoning') appendFileSync(join(this.directory, 'runtime-events.jsonl'), redact(JSON.stringify({ at, event })) + '\n', { mode: 0o600 });
        } catch { appendFileSync(join(this.directory, 'parse-errors.log'), 'Unparsed runtime event\n', { mode: 0o600 }); }
      }
    });
    this.child.stderr!.on('data', raw => {
      this.outputBytes += raw.length; if (this.outputBytes > 2_000_000) { this.stop('OUTPUT_LIMIT'); return; }
      appendFileSync(join(this.directory, 'stderr.log'), redact(raw.toString('utf8')), { mode: 0o600 });
    });
    const timer = setTimeout(() => this.stop('TIME_LIMIT'), options.timeoutMs);
    this.done = new Promise(resolve => {
      this.child.once('error', () => { this.closed = true; this.evidence.stopReason = 'SPAWN_FAILED'; clearTimeout(timer); resolve(this.evidence); });
      this.child.once('close', code => {
        this.closed = true;
        clearTimeout(timer); this.evidence.exitCode = code;
        writeFileSync(join(this.directory, 'run.json'), redact(JSON.stringify({ ...this.evidence, taskId: options.task.taskId, pid: this.child.pid, usage: this.usage }, null, 2)), { mode: 0o600 });
        resolve(this.evidence);
      });
    });
    this.child.stdin!.on('error', () => {}); this.child.stdin!.end(input);
  }
  stop(reason = 'INJECTED_INTERRUPTION'): void {
    if (this.closed || !this.child.pid) return;
    this.evidence.stopReason = reason;
    // Only this freshly created process group: includes the Node launcher and native Codex child.
    try { process.kill(process.platform === 'win32' || !this.ownGroup ? this.child.pid : -this.child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  async close(): Promise<void> { this.stop('CLEANUP'); await this.done; await delay(0); }
}
