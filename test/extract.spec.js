// @ts-check
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ARCHIVE_PATH = fileURLToPath(new URL('./test-files/test.7z', import.meta.url));

// Reused from the pre-rewrite test/cli.spec.js fixture checksums, recomputed
// directly against test-files/test.7z during development.
const EXPECTED_CHECKSUMS = {
  '.gitignore': 'd1e8d4fa856e17b2ad54a216aae527a880873df76cc30a85d6ba6b32d2ee23cc',
  'README.md': 'b4555fd8dd6e81599625c1232e58d5e09fc36f3f6614bf792a6978b30cfe65bb',
  'addon/addon.py': 'e0ab20fe5fd7ab5c2b38511d81d93b9cb6246e300d0893face50e8a5b9485b90',
  'addon/addon.xml': 'd26a8bdf02e7ab2eaeadf2ab603a1d11b2a5bfe57a6ac672d1a1c4940958eba8',
};

test.beforeEach(async ({ page }) => {
  await page.goto('/test/harness.html');
  await page.waitForFunction(() => window.__harnessReady === true);
  await page.evaluate(() => window.removeOpfsEntry('out'));
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.removeOpfsEntry('out')).catch(() => {});
});

test('extracts test.7z into OPFS with correct file contents', async ({ page }) => {
  const archiveBytes = await readFile(ARCHIVE_PATH);

  const events = await page.evaluate(
    async (archiveArray) => window.runExtract(new Uint8Array(archiveArray), 'out'),
    Array.from(archiveBytes),
  );

  const doneEvents = events.filter((e) => e.type === 'done');
  expect(doneEvents).toHaveLength(1);

  for (const [relPath, expectedSha256] of Object.entries(EXPECTED_CHECKSUMS)) {
    const hex = await page.evaluate((p) => window.readOpfsFileAsHex('out/' + p), relPath);
    const actualSha256 = await page.evaluate((h) => window.sha256Hex(h), hex);
    expect(actualSha256, `checksum mismatch for ${relPath}`).toBe(expectedSha256);
  }
});

test('reports monotonically increasing progress up to the real total', async ({ page }) => {
  const archiveBytes = await readFile(ARCHIVE_PATH);

  const events = await page.evaluate(
    async (archiveArray) => window.runExtract(new Uint8Array(archiveArray), 'out'),
    Array.from(archiveBytes),
  );

  const progressEvents = events.filter((e) => e.type === 'progress');
  expect(progressEvents.length).toBeGreaterThan(0);

  const totalBytes = progressEvents[0].totalBytes;
  expect(totalBytes).toBeGreaterThan(0);

  let last = -1;
  for (const e of progressEvents) {
    expect(e.totalBytes).toBe(totalBytes);
    expect(e.processedBytes).toBeGreaterThanOrEqual(last);
    last = e.processedBytes;
  }
  expect(last).toBe(totalBytes);
});

test('reports an error message for a corrupt archive instead of hanging', async ({ page }) => {
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  await expect(
    page.evaluate(async (bytes) => window.runExtract(new Uint8Array(bytes), 'out'), Array.from(garbage)),
  ).rejects.toThrow();
});
