/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { canonicalJsonDigest, canonicalizeJson } from '../src/index.js';
import { parse } from 'yaml';
describe('canonical JSON', () => {
  it('sorts object keys and preserves array order', () => { expect(canonicalizeJson({b:1,a:[{d:4,c:3}]})).toBe('{"a":[{"c":3,"d":4}],"b":1}'); expect(canonicalJsonDigest({a:[1,2]})).not.toBe(canonicalJsonDigest({a:[2,1]})); });
  it('gives YAML and JSON equivalent content the same digest', () => { expect(canonicalJsonDigest(parse('b: 2\na: 1\n'))).toBe(canonicalJsonDigest(JSON.parse('{"a":1,"b":2}'))); });
  it('rejects unsupported values', () => { expect(()=>canonicalizeJson({a:undefined})).toThrow(); expect(()=>canonicalizeJson({a:Infinity})).toThrow(); const x:any={}; x.x=x; expect(()=>canonicalizeJson(x)).toThrow(); });
});
