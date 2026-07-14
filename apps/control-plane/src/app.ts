export interface InjectRequest {
  method: 'GET';
  url: string;
}

export interface InjectResponse {
  statusCode: number;
  json(): unknown;
}

export interface ControlPlaneApp {
  inject(request: InjectRequest): Promise<InjectResponse>;
  listen(options: { port: number; host: string }): Promise<void>;
  close(): Promise<void>;
}

const healthBody = { status: 'ok', service: 'control-plane' } as const;

export function buildApp(): ControlPlaneApp {
  return {
    async inject(request) {
      if (request.method === 'GET' && request.url === '/health') {
        return { statusCode: 200, json: () => healthBody };
      }

      return { statusCode: 404, json: () => ({ status: 'not_found' }) };
    },
    async listen() {
      // Runtime HTTP serving is intentionally deferred until the baseline dependencies are installed.
    },
    async close() {
      // No resources are acquired by the baseline app.
    },
  };
}
