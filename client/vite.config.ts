import { defineConfig } from 'vite'

// Same-origin WebSocket: dev/preview servers proxy /ws to the Go server,
// exactly like nginx does in the docker image. In the browser the client
// always connects to `${location.host}/ws`, so it works unchanged through
// vite dev, nginx and the zrok public share.
const wsProxy = {
  '/ws': { target: 'ws://localhost:8080', ws: true },
}

export default defineConfig({
  server: { port: 5173, proxy: wsProxy },
  preview: { port: 9999, proxy: wsProxy },
})
