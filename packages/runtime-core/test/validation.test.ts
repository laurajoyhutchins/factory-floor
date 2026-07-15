import { describe, expect, it } from 'vitest';
import { validateArtifactSchemaDeclaration, validateComponentDefinitionDeclaration } from '../src/index.js';
describe('declaration validation', () => {
  it('rejects invalid schemas and duplicate ports', () => {
    expect(()=>validateArtifactSchemaDeclaration({apiVersion:'factory-floor.dev/v1alpha1',kind:'ArtifactSchema',metadata:{name:'x',version:'1'},spec:{schema:{type:1}}})).toThrow();
    const doc={apiVersion:'factory-floor.dev/v1alpha1',kind:'ComponentDefinition',metadata:{name:'c',version:'1'},spec:{ports:[{name:'in',direction:'input',schema:{name:'s',version:'1'},required:true},{name:'in',direction:'input',schema:{name:'s',version:'1'},required:true}]}};
    expect(()=>validateComponentDefinitionDeclaration(doc)).toThrow(/Duplicate/);
  });
});
