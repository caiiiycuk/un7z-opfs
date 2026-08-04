# un7z-opfs

Extracts `.7z` archives straight into the browser's [Origin Private File
System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
(OPFS), from inside a dedicated Web Worker, with minimal JS-side memory use.

**Why this exists:**

- **Runs entirely in the browser.** No server-side unpacking, no upload/download round-trip — the archive is decompressed and written to OPFS by a WASM build of 7-Zip running in a Web Worker on the client.
- **Minimal memory footprint.** Extracted bytes are written straight into a `FileSystemSyncAccessHandle` as 7-Zip decompresses each entry — nothing is buffered in JS/wasm memory for the extracted output. The only memory held is the input archive itself (kept in the WASM heap for the duration of extraction) and small per-chunk buffers as each write happens. A 2GB archive does not require 2GB of JS heap to extract.

- **.7z archives only** (LZMA/LZMA2/XZ/BCJ/BCJ2/Delta/Copy) — no Zip/Rar/Tar/gzip. If you need those, use the full [7-Zip](https://www.7-zip.org/) build instead.
- **Worker-only.** OPFS's synchronous file I/O (`FileSystemSyncAccessHandle`) only exists inside dedicated Web Workers — this is a platform requirement, not a choice.
- **No COOP/COEP, no `SharedArrayBuffer`.** The WASM module uses classic Emscripten Asyncify (not pthreads, not JSPI) to bridge 7-Zip's synchronous C++ code with OPFS's asynchronous handle-acquisition API, so it needs none of the cross-origin-isolation headers pthreads-based WASM usually requires.

## Quick start

```sh
npm install un7z-opfs
```

This package ships plain, unbundled ESM files (`worker/opfs-extractor.js` +
`dist/7zz.js`/`dist/7zz.wasm`) rather than a single bundled artifact, so the
browser can load the worker directly via a URL — no bundler-specific worker
loader required. The `./node_modules/...` path below only resolves if
whatever serves your page also serves `node_modules` over HTTP at that
path, which dev servers like Vite/`webpack-dev-server` do by default, but a
typical production static host (serving only `dist/`/`public/`) does not.
For production, either copy `worker/opfs-extractor.js` and `dist/7zz.js`/
`dist/7zz.wasm` into your served assets directory as a build step, or point
your bundler's native worker syntax (e.g. `new Worker(new URL('un7z-opfs/worker/opfs-extractor.js', import.meta.url), { type: 'module' })`)
at the package so it gets bundled and copied automatically.

```js
// main.js (the page)
const worker = new Worker('./node_modules/un7z-opfs/worker/opfs-extractor.js', { type: 'module' });

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
import { extractToOpfs } from 'un7z-opfs/worker/opfs-extractor.js';

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

# copy the freshly built output over the committed dist/ used at runtime
cp build/dist/7zz.js build/dist/7zz.wasm dist/
```

Output lands at `build/dist/7zz.js` + `build/dist/7zz.wasm`. The repo ships
pre-built copies at `dist/7zz.js`/`dist/7zz.wasm` so consumers don't need
Emscripten just to `npm install` this package — rebuild and copy them over
manually (as above) if you change `src-glue/opfs_fs.js` or
`patches/7zz-emcc.patch`. The Testing section below (`npm test`) runs
against whatever is currently in `dist/`, so re-run the copy step before
testing local changes to the C++/glue side.

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

## Trying a local build in another project

To sanity-check a local build (or a change to `src-glue`/`worker`) inside a
real consuming project, before publishing to npm:

```sh
# in this repo, after `cmake --build build` + copying dist/ (see Building above)
npm pack
# produces un7z-opfs-<version>.tgz in this directory

# in your consuming project
npm install /path/to/un7z-opfs/un7z-opfs-<version>.tgz
```

`npm link` works too (`npm link` here, then `npm link un7z-opfs` in the
consuming project), but `npm pack`/`npm install <tarball>` is closer to what
consumers actually get from the registry — it only includes the files
listed in `package.json`'s `files` field, so it also catches accidental
"works locally, missing from the published package" bugs that a symlink via
`npm link` would hide.

## Publishing to npm

Prerequisites: an npm account with publish rights to `un7z-opfs` (`npm login`
if you aren't already authenticated — `npm whoami` confirms).

```sh
# 1. make sure dist/ reflects the current source (see Building above)
cmake -S . -B build && cmake --build build
cp build/dist/7zz.js build/dist/7zz.wasm dist/

# 2. run the test suite against that build
npx playwright install --with-deps chromium
npm test

# 3. bump the version (updates package.json + package-lock.json, commits,
#    and tags -- run from a clean working tree)
npm version patch   # or: minor / major

# 4. sanity-check exactly what would be published
npm pack --dry-run

# 5. publish (the package is unscoped, so no --access flag is needed;
#    add --access public if you rename it to a scoped name like @you/un7z-opfs)
npm publish

# 6. push the version bump commit + tag created by `npm version`
git push && git push --tags
```

### What actually gets published

npm includes only the paths listed in `package.json`'s `"files"` array
(plus `package.json`, `README.md`, and the license file, which npm always
includes regardless of `"files"`). Verified with `npm pack --dry-run`
against the current tree:

| path | purpose for a consumer |
|---|---|
| `dist/7zz.js`, `dist/7zz.wasm` | the compiled 7-Zip WASM module — what `main` points at and what `worker/opfs-extractor.js` imports |
| `worker/opfs-extractor.js` | the ready-to-use worker entry point / `extractToOpfs()` export — what the Quick start examples above actually load |
| `index.d.ts` | TypeScript types for `extractToOpfs()` and the message protocol |
| `src-glue/opfs_fs.js`, `patches/7zz-emcc.patch` | build-time inputs only (the Emscripten FS backend source and the 7-Zip patch) — not imported at runtime by consumers, only needed if you're rebuilding the WASM module yourself per the Building section |
| `License.txt` | required by the LGPL + unRAR terms this project inherits from 7-Zip |

`patches/` and `src-glue/` add a little dead weight to the published
tarball for a pure consumer (they're only read by `CMakeLists.txt`), but are
kept in `files` so `npm pack`/`npm install <tarball>`-based local testing
(see above) exercises the exact same file set that a from-source rebuild
depends on.

## Differences from upstream `7z-wasm`

`un7z-opfs` is a from-scratch rewrite of [use-strict/7z-wasm](https://github.com/use-strict/7z-wasm)
(itself formerly published to npm as `7z-wasm`), not a drop-in replacement:

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
