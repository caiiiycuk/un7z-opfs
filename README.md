# 7z-wasm

Extracts `.7z` archives straight into the browser's [Origin Private File
System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
(OPFS), from inside a dedicated Web Worker, with minimal JS-side memory use.

- **.7z archives only** (LZMA/LZMA2/XZ/BCJ/BCJ2/Delta/Copy) — no Zip/Rar/Tar/gzip. If you need those, use the full [7-Zip](https://www.7-zip.org/) build instead.
- **Worker-only.** OPFS's synchronous file I/O (`FileSystemSyncAccessHandle`) only exists inside dedicated Web Workers — this is a platform requirement, not a choice.
- **No COOP/COEP, no `SharedArrayBuffer`.** The WASM module uses classic Emscripten Asyncify (not pthreads, not JSPI) to bridge 7-Zip's synchronous C++ code with OPFS's asynchronous handle-acquisition API, so it needs none of the cross-origin-isolation headers pthreads-based WASM usually requires.
- **Streams straight to disk.** Extracted bytes go directly into an OPFS `FileSystemSyncAccessHandle`; nothing is buffered in JS/wasm memory beyond the input archive itself and per-chunk write buffers.

## Quick start

```js
// main.js (the page)
const worker = new Worker('./node_modules/7z-wasm/worker/opfs-extractor.js', { type: 'module' });

worker.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'progress') {
    console.log(`${msg.currentFile ?? ''}: ${msg.processedBytes}/${msg.totalBytes} bytes`);
  } else if (msg.type === 'done') {
    console.log('extraction complete');
  } else if (msg.type === 'error') {
    console.error('extraction failed:', msg.message);
  }
};

const archive = await (await fetch('/some-archive.7z')).arrayBuffer();
worker.postMessage({ type: 'extract', archive, destPath: 'my-extracted-archive' }, [archive]);
```

```js
// after extraction, read the result back from the main thread
const root = await navigator.storage.getDirectory();
const dir = await root.getDirectoryHandle('my-extracted-archive');
const fileHandle = await dir.getFileHandle('some-file.txt');
const file = await fileHandle.getFile();
console.log(await file.text());
```

You can also import `extractToOpfs()` directly and compose it into your own
worker script instead of using `worker/opfs-extractor.js` as the whole
worker entry point:

```js
import { extractToOpfs } from '7z-wasm/worker/opfs-extractor.js';

await extractToOpfs({
  archive: someArrayBuffer,
  destPath: 'my-folder',
  onProgress: (info) => console.log(info.processedBytes, '/', info.totalBytes),
});
```

## Message protocol

Inbound (main thread → worker):

| field | type | notes |
|---|---|---|
| `type` | `"extract"` | |
| `id` | `string?` | optional correlation id, echoed back on every response |
| `archive` | `ArrayBuffer` | raw `.7z` bytes — transfer it (`postMessage(msg, [archive])`) to avoid a copy |
| `destPath` | `string` | destination folder, **relative to the OPFS root** — see limitation below |

Outbound (worker → main thread):

| message | fields |
|---|---|
| `{ type: "progress", ... }` | `id?`, `processedBytes`, `totalBytes`, `currentFile` (`string \| null`) |
| `{ type: "done", ... }` | `id?` |
| `{ type: "error", ... }` | `id?`, `message`, `stack?` |

`totalBytes` always reflects the archive's real uncompressed size — the
extractor runs a header-only `7zz l -slt` pass first specifically so
progress is never reported against an unknown total.

## OPFS path limitation

`destPath` is **always relative to `navigator.storage.getDirectory()`**.
There is no way to pass in an arbitrary `FileSystemDirectoryHandle` you
already have a reference to — this is a structural limitation of how
Emscripten's filesystem mounting works, not something this project chose to
omit. If you need the result under a specific handle, extract to a path
under the OPFS root and then move/reference it from there.

Extraction always starts from an empty destination: this mount doesn't
reflect pre-existing OPFS content at the destination path, so it can't
detect or merge with files already there.

## Building

Prerequisites:

- [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html), version **6.0.5** (this is what the patch and build flags were verified against — other versions may work but aren't guaranteed to)
- CMake ≥ 3.20

```sh
emsdk install 6.0.5
emsdk activate 6.0.5
source /path/to/emsdk/emsdk_env.sh

cmake -S . -B build
cmake --build build
```

Output lands at `build/dist/7zz.js` + `build/dist/7zz.wasm`. The repo ships
pre-built copies at `dist/7zz.js`/`dist/7zz.wasm` so consumers don't need
Emscripten just to `npm install` this package — rebuild and copy them over
manually if you change `src-glue/opfs_fs.js` or `patches/7zz-emcc.patch`.

7-Zip's source itself is fetched by `CMakeLists.txt` (via `ExternalProject_Add`)
from the [ip7z/7zip](https://github.com/ip7z/7zip) GitHub releases (7-zip.org
no longer hosts source archives for every version). The build compiles
7-Zip's own minimal `Alone7z` bundle (the `7zr` binary's source set —
LZMA/LZMA2/XZ/BCJ/BCJ2/Delta/Copy only, no Zip/Rar/Tar/Nsis handlers),
patched via `patches/7zz-emcc.patch` to target Emscripten and to link in the
custom OPFS filesystem backend (`src-glue/opfs_fs.js`).

## Architecture notes

The custom FS backend (`src-glue/opfs_fs.js`) overrides exactly two
Emscripten syscalls — `__syscall_openat` and `__syscall_mkdirat` — as
`async` functions (using classic Asyncify's `__async: 'auto'` library
metadata) that resolve and cache real OPFS `FileSystemDirectoryHandle`/
`FileSystemSyncAccessHandle`s the first time a given path is touched.
Everything else (`read`/`write`/`close`/`llseek`) runs as plain synchronous
JS against an already-open handle, since those OPFS methods are synchronous
by spec once a handle exists. This is what lets the whole thing avoid
pthreads/JSPI/SharedArrayBuffer entirely.

## Testing

```sh
npm install
npx playwright install --with-deps chromium
npm test
```

The suite (`test/extract.spec.js`) drives a real Chromium instance via
Playwright — OPFS and Web Workers aren't available in Node, so this can't
be a plain unit test. It's Chromium-only for now: Firefox/WebKit support for
`FileSystemSyncAccessHandle` is newer and less consistently available.

## Differences from upstream `7z-wasm`

This is a from-scratch rewrite of [use-strict/7z-wasm](https://github.com/use-strict/7z-wasm),
not a drop-in replacement:

- Only `.7z` archives (upstream supports everything 7-Zip does: zip, rar, tar, gzip, bzip2, nsis, ...)
- Browser Worker + OPFS only (upstream also supports Node.js via a CLI and NODEFS/WORKERFS)
- CMake + `ExternalProject_Add` build (upstream uses a Dockerfile + bash scripts)
- Single ESM build artifact (upstream ships both UMD and ESM)
- Message-based extraction API with progress reporting (upstream exposes the raw Emscripten `FS`/`callMain` surface)

## License

7-Zip itself is distributed under the GNU LGPL + unRAR restriction (see
[License.txt](License.txt)); this project's own code (the CMake build,
`src-glue/opfs_fs.js`, `worker/opfs-extractor.js`, tests) follows the same
terms as it's a derivative build of 7-Zip's source.
