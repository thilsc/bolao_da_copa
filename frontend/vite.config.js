import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  publicDir: 'public',
  server: {
    port: 5173,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    //comentando pq o app vai voltar a ser SPA
    /*rollupOptions: {
      input: {
        main: './main.html',
        login: './login.html',
        verify: './verify.html',
      },
    },*/
  },
});
