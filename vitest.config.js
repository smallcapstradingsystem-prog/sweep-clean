import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'worker/test/**/*.test.js',
      'src/test/**/*.test.js',
    ],
    environment: 'node',
    globals: false,
    clearMocks: true,

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      all: false,
      include: [
        'worker/payment-worker.js',
        'src/config.js',
        'src/scrub.js',
        'src/chain-verify.js',
        'src/retry.js',
      ],
    },
  },
});