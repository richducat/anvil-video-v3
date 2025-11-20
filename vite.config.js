import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/anvil-video-v3/',
  build: {
    outDir: 'docs',
  },
});

  
