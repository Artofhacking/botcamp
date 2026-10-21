import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { kernelProxy } from './kernelProxy'

export default defineConfig({
  plugins: [react(), kernelProxy()],
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  test: {
    environment: 'node',
  },
})
