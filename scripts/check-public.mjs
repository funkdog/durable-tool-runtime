import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const root=resolve(new URL('..',import.meta.url).pathname);let checked=0;const findings=[];
const patterns=[/\/Users\/[^/\s]+/,/\/private\/var\/folders\//,/thread_[a-z0-9]{8,}/,/backend-api\/codex/,/@antgroup\.com/,
  /\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{20,}/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
function visit(directory){for(const entry of readdirSync(directory,{withFileTypes:true})){
  if(['.git','node_modules'].includes(entry.name))continue;
  const path=join(directory,entry.name);if(entry.isSymbolicLink()){findings.push(`${path}: symlink`);continue;}
  if(entry.isDirectory()){visit(path);continue;}
  if(/\.(?:sqlite(?:-.*)?|jsonl|log)$/.test(entry.name)||/^\.env(?:\..*)?$/.test(entry.name)&&entry.name!=='.env.example'){
    findings.push(`${path}: runtime artifact`);continue;
  }
  const text=readFileSync(path,'utf8');checked++;
  for(const pattern of patterns)if(pattern.test(text))findings.push(`${path}: private reference or credential-shaped content`);
  if(path.endsWith('.md'))for(const m of text.matchAll(/\]\(([^)]+)\)/g)){
    const target=m[1].split('#')[0];if(!target||/^(?:https?:|mailto:)/.test(target))continue;
    if(!existsSync(resolve(dirname(path),target)))findings.push(`${path}: broken local link ${target}`);
  }
}}
visit(root);
const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const lock=JSON.parse(readFileSync(join(root,'package-lock.json'),'utf8'));
if(manifest.name!==lock.name||manifest.name!==lock.packages[''].name)findings.push('Package/lock identity mismatch');
if(manifest.license!=='MIT'||!existsSync(join(root,'LICENSE')))findings.push('MIT license missing');
for(const command of Object.values(manifest.scripts))for(const m of command.matchAll(/\bnode (scripts\/[\w.-]+\.(?:ts|mjs))/g)){
  if(!existsSync(join(root,m[1])))findings.push(`Missing command entry: ${m[1]}`);
}
console.log(JSON.stringify({checked,findings},null,2));if(findings.length)process.exitCode=1;
