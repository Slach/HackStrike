import { defineConfig } from 'vite'

// Same-origin access to the Go server: /ws is the game WebSocket, /api is
// the HTTP API (map data). In the browser the client always talks to
// `${location.host}/...`, so it works unchanged through vite dev, nginx and
// the zrok public share.
const proxy = {
  '/ws': { target: 'ws://localhost:8080', ws: true },
  '/api': { target: 'http://localhost:8080', changeOrigin: true },
}

export default defineConfig({
  server: { port: 5173, proxy },
  preview: { port: 9999, proxy },
})
