import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server:  { port: 3000 },
  preview: { port: 4173 },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Bundle Three.js core + all jsm examples together so they share one instance
          three: ['three', 'three/examples/jsm/loaders/OBJLoader.js'],
        },
      },
    },
  },
})
