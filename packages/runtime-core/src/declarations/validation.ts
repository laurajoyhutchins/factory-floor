/* eslint-disable @typescript-eslint/no-explicit-any */
import Ajv2020Module from 'ajv/dist/2020.js';
const Ajv2020 = (Ajv2020Module as any).default ?? Ajv2020Module as any;
import { DomainError } from './errors.js';
const apiVersion = 'factory-floor.dev/v1alpha1';
const legacyApiVersion = 'factoryfloor.dev/v1alpha1';
export type RegKind = 'ArtifactSchema'|'ComponentDefinition'|'Template'|'Policy';
export function requireEnvelope(doc: any, kind?: string) {
  if (!doc || typeof doc !== 'object') throw new DomainError('invalid_declaration','Declaration must be an object');
  if (![apiVersion, legacyApiVersion].includes(doc.apiVersion)) throw new DomainError('unsupported_declaration_version', 'Unsupported apiVersion');
  if (kind && doc.kind !== kind) throw new DomainError('invalid_declaration', `Expected kind ${kind}`);
  if (!doc.metadata?.name || !doc.metadata?.version) throw new DomainError('invalid_declaration','metadata.name and metadata.version are required');
  if (typeof doc.metadata.name !== 'string' || !doc.metadata.name.trim() || typeof doc.metadata.version !== 'string' || !doc.metadata.version.trim()) throw new DomainError('invalid_declaration','metadata.name and metadata.version must be non-empty strings');
}
export function validateArtifactSchemaDeclaration(doc: any) {
  requireEnvelope(doc, 'ArtifactSchema');
  const schema = doc.spec?.schema;
  if (!schema || typeof schema !== 'object') throw new DomainError('invalid_declaration','spec.schema is required');
  schema.$schema ??= 'https://json-schema.org/draft/2020-12/schema';
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') throw new DomainError('invalid_declaration','Artifact schemas must use JSON Schema Draft 2020-12');
  try { new Ajv2020({ strict: true }).compile(schema); } catch (e) { throw new DomainError('invalid_declaration', `Invalid JSON Schema: ${(e as Error).message}`); }
}
export function validateComponentDefinitionDeclaration(doc: any) {
  requireEnvelope(doc, 'ComponentDefinition');
  if (!Array.isArray(doc.spec?.ports)) throw new DomainError('invalid_declaration','spec.ports is required');
  const seen = new Set<string>();
  for (const p of doc.spec.ports) {
    if (!p?.name || !['input','output','state'].includes(p.direction) || typeof p.required !== 'boolean') throw new DomainError('invalid_declaration','Each port requires name, direction, required');
    const ref = p.schema ?? p.schemaRef;
    if (!ref?.name || !ref?.version) throw new DomainError('invalid_declaration','Each port requires schema natural key');
    const key = `${p.name}:${p.direction}`; if (seen.has(key)) throw new DomainError('duplicate_port_identity', `Duplicate port ${key}`); seen.add(key);
  }
}
export function validateSimpleDeclaration(doc: any, kind: 'Template'|'Policy') { requireEnvelope(doc, kind); if (!doc.spec || typeof doc.spec !== 'object') throw new DomainError('invalid_declaration','spec is required'); }
export function validateSystemDeclaration(doc: any) { requireEnvelope(doc, 'System'); if (!doc.spec || typeof doc.spec !== 'object') throw new DomainError('invalid_declaration','spec is required'); }
