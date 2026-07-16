import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target =
    env.FACTORY_FLOOR_CONSOLE_CONTROL_PLANE_URL ?? 'http://127.0.0.1:3000';
  return {
    plugins: [react()],
    server: { host: '127.0.0.1', proxy: { '/api': target, '/health': target } },
    preview: { host: '127.0.0.1' },
  };
});
