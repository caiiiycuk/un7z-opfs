// @ts-check
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  fullyParallel: false,
  retries: 0,
  webServer: {
    command: 'node test/static-server.mjs',
    url: 'http://localhost:8177/test/harness.html',
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://localhost:8177',
  },
  projects: [
    // OPFS's FileSystemSyncAccessHandle (required by the custom FS backend)
    // has the most mature support in Chromium; Firefox/WebKit support is
    // newer/less consistent, so this suite intentionally covers Chromium
    // only for now -- see README's browser support note.
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
