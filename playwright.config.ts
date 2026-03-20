import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'web.spec.js',
  use: {
    headless: true,
  },
});
