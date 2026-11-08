import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // g2-ssr + canvas render in Node, not a browser/jsdom env.
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
  },
});
