const marker = Symbol.for('factory-floor.control-plane-fetch-auth');

if (!globalThis[marker] && typeof globalThis.fetch === 'function') {
  globalThis[marker] = true;
  const originalFetch = globalThis.fetch.bind(globalThis);
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  const baseUrl =
    process.env.FACTORY_FLOOR_CONTROL_PLANE_URL ??
    process.env.CONTROL_PLANE_PUBLIC_URL ??
    'http://127.0.0.1:3000';

  globalThis.fetch = async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? String(input), baseUrl);
    const method = String(init.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? request?.headers);

    if (
      localHosts.has(url.hostname) &&
      url.pathname.startsWith('/api/v1/') &&
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

    return originalFetch(input, { ...init, headers });
  };
}
