import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    globals: true,
    deps: {
      interopDefault: true
    }
  },
  resolve: {
    extensions: ['.ts', '.js']
  }
})
