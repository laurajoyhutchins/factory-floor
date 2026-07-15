/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
describe('admin route mapping', () => {
  it('keeps health and maps registration status codes', async () => {
    const app=await buildApp({ registrationService: { registerArtifactSchema: async () => ({disposition:'created', digest:'d'.repeat(64), entity:{id:'1'}}) } as any, systemApplicationService: { apply: async()=>({disposition:'existing', digest:'e'.repeat(64), regions:[]}) } as any });
    expect((await app.inject('/health')).statusCode).toBe(200);
    const res=await app.inject({method:'POST',url:'/api/v1/registrations/artifact-schemas',payload:{}}); expect(res.statusCode).toBe(201);
    const sys=await app.inject({method:'POST',url:'/api/v1/systems/apply',payload:{}}); expect(sys.statusCode).toBe(200);
    await app.close();
  });
});
