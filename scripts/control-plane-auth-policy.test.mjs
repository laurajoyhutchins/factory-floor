import { describe, expect, it } from 'vitest';
import {
  shouldAttachControlPlaneAuthorization,
} from './control-plane-auth-policy.mjs';

describe('control-plane fetch authorization policy', () => {
  const baseUrl = 'http://127.0.0.1:3000';

  it('authorizes only API requests to the exact configured origin', () => {
    expect(
      shouldAttachControlPlaneAuthorization(
        new URL('http://127.0.0.1:3000/api/v1/commands'),
        baseUrl,
      ),
    ).toBe(true);
    expect(
      shouldAttachControlPlaneAuthorization(
        new URL('http://127.0.0.1:9999/api/v1/commands'),
        baseUrl,
      ),
    ).toBe(false);
    expect(
      shouldAttachControlPlaneAuthorization(
        new URL('http://localhost:3000/api/v1/commands'),
        baseUrl,
      ),
    ).toBe(false);
    expect(
      shouldAttachControlPlaneAuthorization(
        new URL('http://127.0.0.1:3000/health'),
        baseUrl,
      ),
    ).toBe(false);
  });
});
