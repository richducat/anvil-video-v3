import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Use a relative base so the app can load whether it's served from
  // https://<user>.github.io/anvil-video-v3/ or from a custom domain root.
  base: './',
  build: {
    outDir: 'docs',
  },
});

  
