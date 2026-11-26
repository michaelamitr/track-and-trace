import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.int.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['src/**/*.int.test.ts'],
          // Kills a started main.ts that a test left behind, also after a worker was ended.
          globalSetup: ['@tt/lifecycle/test-global-setup'],
          // Starting a container takes a few seconds.
          hookTimeout: 60_000,
          testTimeout: 20_000,
        },
      },
    ],
  },
})
