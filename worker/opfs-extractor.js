/**
 * Extracts a .7z archive directly into the browser's Origin Private File
 * System (OPFS), inside a dedicated Web Worker. Must run in a worker: OPFS's
 * FileSystemSyncAccessHandle (which the OPFS FS backend depends on) is only
 * available there.
 *
 * Import the build output relative to this file so it can be dropped into
 * any project layout without editing paths here.
 */
import SevenZipFactory from '../dist/7zz.js';

const MOUNT = '/opfs-out';
const ARCHIVE_PATH = '/input/archive.7z';

function parseSltTotalBytes(lines) {
  let total = 0;
  let current = {};

  function flush() {
    if (current.Path !== undefined) {
      const attrs = (current.Attributes || '').trim();
      const isDir = current.Folder === '+' || attrs.startsWith('D');
      if (!isDir) {
        const size = parseInt(current.Size, 10);
        if (!Number.isNaN(size)) total += size;
      }
    }
    current = {};
  }

  for (const line of lines) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    const idx = line.indexOf(' = ');
    if (idx === -1) continue;
    current[line.slice(0, idx)] = line.slice(idx + 3);
  }
  flush();

  return total;
}

/**
 * @param {object} opts
 * @param {Uint8Array|ArrayBuffer} opts.archive - raw .7z archive bytes
 * @param {string} opts.destPath - destination folder path, relative to the
 *   OPFS root (e.g. "downloads/my-archive"); must not start with "/" or
 *   contain ".." segments. Pass "" or "." to extract directly into the OPFS
 *   root.
 * @param {(info: {processedBytes: number, totalBytes: number, currentFile: string|null}) => void} [opts.onProgress]
 * @returns {Promise<void>}
 */
export async function extractToOpfs({ archive, destPath, onProgress }) {
  if (typeof destPath !== 'string' || destPath.startsWith('/') ||
      destPath.split('/').includes('..')) {
    throw new Error('destPath must be a path relative to the OPFS root ("" or "." for the root), without ".." segments');
  }
  const isRoot = destPath === '' || destPath === '.';

  let phase = 'list';
  let currentFile = null;
  const listLines = [];

  const sevenZip = await SevenZipFactory({
    print: (line) => {
      if (phase === 'list') {
        listLines.push(line);
      } else if (phase === 'extract') {
        // -bb1 lines look like "  0%\b\b\b\b    \b\b\b\b- path/to/file":
        // 7-Zip's own progress percentage is backspace-erased and rewritten
        // in place (raw \b control characters, not whitespace) immediately
        // before the "- " marker that precedes the path about to be
        // extracted. Match the marker anywhere on the line rather than
        // anchoring on what precedes it, since that varies with percent
        // width and backspace count.
        const m = /-\s(.+)$/.exec(line);
        if (m) currentFile = m[1];
      }
    },
    printErr: () => {},
  });

  sevenZip.FS.mkdir('/input');
  sevenZip.FS.writeFile(ARCHIVE_PATH, archive instanceof Uint8Array ? archive : new Uint8Array(archive));

  sevenZip.FS.mkdir(MOUNT);
  sevenZip.FS.mount(sevenZip.OPFS, {}, MOUNT);

  // Mandatory listing pass (header-only, no decompression): without a real
  // totalBytes up front, progress reporting would have to degrade to
  // "unknown total", which this API intentionally never does.
  const listExit = await sevenZip.callMain(['l', '-slt', ARCHIVE_PATH]);
  if (listExit !== 0) {
    throw new Error(`7z listing failed with exit code ${listExit}`);
  }
  const totalBytes = parseSltTotalBytes(listLines);

  let processedBytes = 0;
  sevenZip.OPFS.onWrite = (_path, n) => {
    processedBytes += n;
    onProgress?.({ processedBytes, totalBytes, currentFile });
  };

  phase = 'extract';
  const destFsPath = isRoot ? MOUNT : `${MOUNT}/${destPath}`;
  const extractExit = await sevenZip.callMain(['x', ARCHIVE_PATH, `-o${destFsPath}`, '-y', '-bb1', '-bso1']);
  if (extractExit !== 0) {
    throw new Error(`7z extraction failed with exit code ${extractExit}`);
  }

  onProgress?.({ processedBytes, totalBytes, currentFile: null });
}

const isDedicatedWorker = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;

if (isDedicatedWorker) {
  self.onmessage = async (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'extract') return;
    const { id, archive, destPath } = msg;
    try {
      await extractToOpfs({
        archive,
        destPath,
        onProgress: (info) => self.postMessage({ type: 'progress', id, ...info }),
      });
      self.postMessage({ type: 'done', id });
    } catch (err) {
      self.postMessage({ type: 'error', id, message: err?.message ?? String(err), stack: err?.stack });
    }
  };
}
