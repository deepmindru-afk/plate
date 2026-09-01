import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  // NOTE: a local postcss.config.mjs shadows the repo-root Tailwind config,
  // since this demo lives inside a monorepo and doesn't use Tailwind.
});
