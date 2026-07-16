import process from 'node:process';

const marker = Symbol.for('factory-floor.control-plane-fetch-auth');

export function shouldAttachControlPlaneAuthorization(url, baseUrl) {
  const controlPlane = new URL(baseUrl);
  return (
    url.origin === controlPlane.origin &&
    url.pathname.startsWith('/api/v1/')
  );
}

if (!globalThis[marker] && typeof globalThis.fetch === 'function') {
  globalThis[marker] = true;
  const originalFetch = globalThis.fetch.bind(globalThis);
  const baseUrl =
    process.env.FACTORY_FLOOR_CONTROL_PLANE_URL ??
    process.env.CONTROL_PLANE_PUBLIC_URL ??
    'http://127.0.0.1:3000';

  globalThis.fetch = async (input, init = {}) => {
    const request =
      typeof globalThis.Request === 'function' &&
      input instanceof globalThis.Request
        ? input
        : undefined;
    const url = new URL(request?.url ?? String(input), baseUrl);
    const method = String(init.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = new globalThis.Headers(init.headers ?? request?.headers);

    if (
      shouldAttachControlPlaneAuthorization(url, baseUrl) &&
      !headers.has('authorization')
    ) {
      const inspectionRead =
        (method === 'GET' || method === 'HEAD') &&
        url.pathname.startsWith('/api/v1/inspect/');
      const token = inspectionRead
        ? process.env.CONTROL_PLANE_OPERATOR_TOKEN ??
          process.env.CONTROL_PLANE_ADMIN_TOKEN
        : process.env.CONTROL_PLANE_ADMIN_TOKEN;
      if (token) headers.set('authorization', `Bearer ${token}`);
    }

    return originalFetch(request ?? url, { ...init, headers });
  };
}
