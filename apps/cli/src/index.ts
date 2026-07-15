#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
function arg(argv:string[], name:string, def?:string) { const i=argv.indexOf(name); return i>=0 ? argv[i+1] : def; }
function load(file:string) { const text=readFileSync(file,'utf8'); return file.endsWith('.json') ? JSON.parse(text) : parse(text); }
const routes: Record<string,string> = { 'schema register':'/api/v1/registrations/artifact-schemas', 'component register':'/api/v1/registrations/component-definitions', 'template register':'/api/v1/registrations/templates', 'policy register':'/api/v1/registrations/policies', 'system apply':'/api/v1/systems/apply' };
export async function main(argv=process.argv.slice(2)) {
  const key=`${argv[0]??''} ${argv[1]??''}`; const endpoint=routes[key]; const file=argv[2]; const server=arg(argv,'--server','http://127.0.0.1:3000')!; const asJson=argv.includes('--json');
  if (!endpoint || !file) { console.error('Usage: ff <schema|component|template|policy> register <file> [--server URL] [--json]\n       ff system apply <file> [--server URL] [--json]'); return 2; }
  try { const body=load(file); const res=await fetch(new URL(endpoint, server), {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); const json=await res.json().catch(()=>({error:{code:'transport_error',message:res.statusText}})); if (!res.ok) { console.error(asJson ? JSON.stringify(json) : `${json.error?.code ?? 'error'}: ${json.error?.message ?? res.statusText}`); return 1; } console.log(asJson ? JSON.stringify(json) : `${json.disposition} ${json.digest}`); return 0; } catch(e) { console.error(asJson ? JSON.stringify({error:{code:'transport_error',message:(e as Error).message}}) : (e as Error).message); return 1; }
}
if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
