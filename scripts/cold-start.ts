import { readFileSync } from 'node:fs';
import { coldScenarios, runColdScenario, type ColdScenario } from '../src/cold-scenario.ts';
import { budgetSchema } from '../src/model-budget.ts';
const scenario=process.argv[2] as ColdScenario;const live=process.argv.includes('--live');
if(!coldScenarios.includes(scenario))throw new Error('Usage: npm run agent:cold -- before_launch|after_spawn|after_commit|before_consume [--live budget.local.json]');
if(live&&(process.env.POC_ALLOW_LIVE!=='1'||!process.env.POC_OPENAI_API_KEY))throw new Error('Live execution requires POC_ALLOW_LIVE=1 and dedicated POC_OPENAI_API_KEY');
const policy=live?budgetSchema.parse(JSON.parse(readFileSync(process.argv[process.argv.indexOf('--live')+1],'utf8'))):undefined;
if(policy){const age=Date.now()-Date.parse(policy.pricingCheckedAt);if(age< -60_000||age>7*86400_000||!['developers.openai.com','platform.openai.com','learn.chatgpt.com'].includes(new URL(policy.pricingSource).hostname))throw new Error('Verify current model prices using an official source');}
const abort=new AbortController();process.once('SIGTERM',()=>abort.abort());process.once('SIGINT',()=>abort.abort());
const result=await runColdScenario(scenario,policy,abort.signal);console.log(JSON.stringify(result,null,2));if(result.failure)process.exitCode=1;
