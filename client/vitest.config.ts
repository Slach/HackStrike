import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['src/palenv.ts'],
    include: ['src/**/*.test.ts'],
  },
})
