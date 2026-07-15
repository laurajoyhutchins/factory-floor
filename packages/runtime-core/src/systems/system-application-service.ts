/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Kysely } from 'kysely';
import type { Database, Json } from '@factory-floor/db';
import { DefinitionRepository, TopologyRepository } from '@factory-floor/db';
import { canonicalJsonDigest } from '../declarations/canonical-json.js';
import { DomainError } from '../declarations/errors.js';
import { validateSystemDeclaration } from '../declarations/validation.js';
export interface SystemApplyResult { disposition:'created'|'existing'; digest:string; regions: unknown[]; }
function parseRef(ref:string) { const [name, version] = ref.split('@'); if (!name || !version) throw new DomainError('invalid_declaration',`Invalid reference ${ref}`); return {name, version}; }
function endpoint(s:string) { const i=s.lastIndexOf('.'); if (i<1) throw new DomainError('invalid_declaration',`Invalid endpoint ${s}`); return {instance:s.slice(0,i), port:s.slice(i+1)}; }
export class SystemApplicationService {
  constructor(private db: Kysely<Database>, private defs = new DefinitionRepository(), private topo = new TopologyRepository()) {}
  async apply(doc:any): Promise<SystemApplyResult> { validateSystemDeclaration(doc); const digest=canonicalJsonDigest(doc); const rootName=doc.spec.rootRegion?.id ?? doc.metadata.name; const template = Array.isArray(doc.spec.regions) ? doc.spec.regions.find((r:any)=>r.id==='investigation') : undefined; const top = template?.initialTopology ?? doc.spec.initialTopology ?? doc.spec.topology ?? doc.spec; const instances = top.instances ?? []; const connections = top.connections ?? []; return this.db.transaction().execute(async (trx) => { let root=await this.topo.findRoot(trx, rootName); let disposition: 'created'|'existing'='existing'; if (!root) { root=await this.topo.createRegion(trx, rootName, null); disposition='created'; }
      let region=await this.topo.findChild(trx, root.id, 'investigation'); if (!region) { region=await this.topo.createRegion(trx,'investigation',root.id); disposition='created'; }
      const active=await this.topo.activeRevision(trx, region.id); if (active) { if (active.content_digest===digest) return {disposition:'existing', digest, regions:[root,region]}; throw new DomainError('system_conflict','Static system exists with different content'); }
      const defByInst = new Map<string, {id:string; ports:Set<string>}>();
      for (const inst of instances) { const ref=parseRef(inst.component); const def=await this.defs.findComponentDefinition(trx, ref.name, ref.version); if (!def) throw new DomainError('component_definition_not_found',`Component definition ${inst.component} was not found`); const ports=await this.defs.listPorts(trx, def.id); defByInst.set(inst.name,{id:def.id, ports:new Set(ports.map(p=>p.name))}); }
      for (const c of connections) { const from=endpoint(c.from); const to=endpoint(c.to); if (from.instance==='region' || to.instance==='region') continue; if (!defByInst.get(from.instance)?.ports.has(from.port) || !defByInst.get(to.instance)?.ports.has(to.port)) throw new DomainError('invalid_port_reference',`Invalid connection ${c.from} -> ${c.to}`); }
      const rev=await this.topo.createRevision(trx, region.id, digest, doc as Json); const instanceIds=new Map<string,string>(); for (const inst of instances) { const def=defByInst.get(inst.name)!; const row=await this.topo.createInstance(trx,{regionId:region.id, revisionId:rev.id, definitionId:def.id, name:inst.name, configuration:(inst.configuration??{}) as Json}); instanceIds.set(inst.name,row.id); }
      for (const c of connections) { const from=endpoint(c.from); const to=endpoint(c.to); if (from.instance==='region' || to.instance==='region') continue; await this.topo.createConnection(trx,{revisionId:rev.id, sourceId:instanceIds.get(from.instance)!, sourcePort:from.port, targetId:instanceIds.get(to.instance)!, targetPort:to.port}); }
      await this.topo.activate(trx, region.id, rev.id); return {disposition, digest, regions:[root,region]}; }); }
}
