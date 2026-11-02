import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    target: 'chrome120',
    rollupOptions: {
      input: { dashboard: 'dashboard.html', sidepanel: 'sidepanel.html', popup: 'popup.html' },
    },
  },
});
