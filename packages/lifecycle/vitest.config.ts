import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.int.test.ts'],
          // Kills child processes a test left behind (test-process.ts).
          globalSetup: ['./src/test-global-setup.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts'],
          // Starting a container takes a few seconds.
          hookTimeout: 60_000,
          testTimeout: 20_000,
        },
      },
    ],
  },
})
