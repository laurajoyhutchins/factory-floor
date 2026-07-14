const healthBody = { status: 'ok', service: 'control-plane' };

export function buildApp() {
  return {
    async inject(request) {
      if (request.method === 'GET' && request.url === '/health') {
        return { statusCode: 200, json: () => healthBody };
      }
      return { statusCode: 404, json: () => ({ status: 'not_found' }) };
    },
    async listen() {},
    async close() {},
  };
}
