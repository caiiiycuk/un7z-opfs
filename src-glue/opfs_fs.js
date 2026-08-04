/**
 * Custom Emscripten FS backend that writes directly into the browser's
 * Origin Private File System (OPFS), using synchronous
 * FileSystemSyncAccessHandle I/O once a handle has been resolved.
 *
 * Only `__syscall_openat` and `__syscall_mkdirat` are overridden here and
 * marked async (see ASYNCIFY_IMPORTS in the build flags) — those are the
 * only points where a *new* path needs an OPFS directory/file handle, which
 * is inherently asynchronous to obtain. Emscripten's own FS.open()/FS.mkdir()
 * do NOT await stream_ops.open()/node_ops.mknod(), so making those backend
 * methods themselves `async` would silently race; instead we resolve and
 * cache the handle *before* delegating to the stock (synchronous) FS.open()/
 * FS.mkdir() call chain, which then finds an already-ready handle waiting
 * for it via SZOPFS.fileHandles/dirHandles.
 *
 * This keeps the module classic-Asyncify-only (`-sASYNCIFY=1`): no pthreads,
 * no JSPI, no SharedArrayBuffer, no COOP/COEP.
 *
 * Named SZOPFS (not "OPFS") internally: Emscripten reserves the plain name
 * "OPFS" for its own deprecated built-in backend placeholder
 * (`var OPFS = 'OPFS is no longer included by default; build with -lopfs.js'`),
 * and a legacy-property-access trap later installed on the Module object
 * collides with it, turning `Module.OPFS = ...` into a "setting a
 * getter-only property" TypeError. The public property exposed on Module
 * (see post.js) is still called `OPFS` — only this internal library symbol
 * needed renaming to dodge the collision.
 */

addToLibrary({
  $SZOPFS__deps: ['$FS', '$PATH', '$SYSCALLS'],
  $SZOPFS: {
    // Path this backend is mounted at (set in mount()), e.g. "/opfs-out".
    mountpoint: null,

    // relative-dir-path ('' = OPFS root) -> FileSystemDirectoryHandle
    dirHandles: new Map(),
    // absolute FS path -> FileSystemSyncAccessHandle, populated just before
    // FS.open() is called for that path, consumed by stream_ops.close().
    fileHandles: new Map(),

    // Optional hook the JS wrapper can set to observe bytes written, for
    // progress reporting: SZOPFS.onWrite = (path, bytesWritten) => {...}
    onWrite: null,

    isUnderMount(path) {
      return SZOPFS.mountpoint != null &&
        (path === SZOPFS.mountpoint || path.startsWith(SZOPFS.mountpoint + '/'));
    },

    relParts(path) {
      var rel = path.slice(SZOPFS.mountpoint.length);
      return rel.split('/').filter(Boolean);
    },

    async getDirHandle(relDirPath) {
      if (SZOPFS.dirHandles.has(relDirPath)) {
        return SZOPFS.dirHandles.get(relDirPath);
      }
      var root = SZOPFS.dirHandles.get('');
      if (!root) {
        root = await navigator.storage.getDirectory();
        SZOPFS.dirHandles.set('', root);
      }
      if (!relDirPath) {
        return root;
      }
      var parts = relDirPath.split('/');
      var dir = root;
      var acc = '';
      for (var i = 0; i < parts.length; i++) {
        acc = acc ? (acc + '/' + parts[i]) : parts[i];
        if (SZOPFS.dirHandles.has(acc)) {
          dir = SZOPFS.dirHandles.get(acc);
          continue;
        }
        dir = await dir.getDirectoryHandle(parts[i], { create: true });
        SZOPFS.dirHandles.set(acc, dir);
      }
      return dir;
    },

    // Ensures the OPFS directory chain for an absolute FS directory path
    // exists. Called from the async __syscall_mkdirat override.
    async prepareDir(path) {
      if (!SZOPFS.isUnderMount(path)) return;
      await SZOPFS.getDirHandle(SZOPFS.relParts(path).join('/'));
    },

    // Ensures the parent dir + file + a SyncAccessHandle exist for an
    // absolute FS file path, and caches the handle by that path. Called from
    // the async __syscall_openat override, before FS.open() runs.
    async prepareFile(path) {
      if (!SZOPFS.isUnderMount(path)) return;
      if (SZOPFS.fileHandles.has(path)) return;
      var parts = SZOPFS.relParts(path);
      var name = parts.pop();
      var dir = await SZOPFS.getDirHandle(parts.join('/'));
      var fileHandle = await dir.getFileHandle(name, { create: true });
      var accessHandle = await fileHandle.createSyncAccessHandle();
      // A fresh extraction should always start from an empty file; truncate
      // any stale content left over from a previous run at this same path.
      accessHandle.truncate(0);
      SZOPFS.fileHandles.set(path, accessHandle);
    },

    createNode(parent, name, mode, dev) {
      var node = FS.createNode(parent, name, mode, dev);
      node.node_ops = SZOPFS.node_ops;
      node.stream_ops = SZOPFS.stream_ops;
      node.opfsSize = 0;
      return node;
    },

    mount(mount) {
      SZOPFS.mountpoint = mount.mountpoint;
      SZOPFS.dirHandles.clear();
      SZOPFS.fileHandles.clear();
      return SZOPFS.createNode(null, '/', {{{ cDefs.S_IFDIR }}} | 0o777, 0);
    },

    node_ops: {
      getattr(node) {
        return {
          dev: 1,
          ino: node.id,
          mode: node.mode,
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: 0,
          size: node.opfsSize || 0,
          atime: new Date(node.timestamp || 0),
          mtime: new Date(node.timestamp || 0),
          ctime: new Date(node.timestamp || 0),
          blksize: 4096,
          blocks: Math.ceil((node.opfsSize || 0) / 4096),
        };
      },
      setattr(node, attr) {
        // 7-Zip calls this after writing (mtime/mode bookkeeping) — accepted
        // as in-memory-only bookkeeping; OPFS access handles don't need an
        // explicit flush/truncate step beyond what close() already does.
        if (attr.mode !== undefined) node.mode = attr.mode;
        if (attr.timestamp !== undefined) node.timestamp = attr.timestamp;
        if (attr.size !== undefined) node.opfsSize = attr.size;
      },
      lookup(parent, name) {
        // This mount only reflects paths created during THIS extraction
        // (via mknod, wired up from the FS in-memory node tree); anything
        // not already known is reported as not existing. Pre-existing OPFS
        // content at the destination is intentionally not visible through
        // this mount — see README's "fresh destination folder" note.
        throw new FS.ErrnoError({{{ cDefs.ENOENT }}});
      },
      mknod(parent, name, mode, dev) {
        return SZOPFS.createNode(parent, name, mode, dev);
      },
      rename(oldNode, newDir, newName) {
        throw new FS.ErrnoError({{{ cDefs.ENOSYS }}});
      },
      unlink(parent, name) {
        throw new FS.ErrnoError({{{ cDefs.ENOSYS }}});
      },
      rmdir(parent, name) {
        throw new FS.ErrnoError({{{ cDefs.ENOSYS }}});
      },
      readdir(node) {
        return [];
      },
    },

    stream_ops: {
      open(stream) {
        var handle = SZOPFS.fileHandles.get(stream.path);
        if (!handle) {
          // Should not happen: __syscall_openat always resolves the handle
          // (via prepareFile) before FS.open() reaches this point.
          throw new FS.ErrnoError({{{ cDefs.EIO }}});
        }
        stream.opfsHandle = handle;
      },
      close(stream) {
        if (stream.opfsHandle) {
          stream.opfsHandle.flush();
          stream.opfsHandle.close();
          SZOPFS.fileHandles.delete(stream.path);
          stream.opfsHandle = null;
        }
      },
      read(stream, buffer, offset, length, position) {
        return stream.opfsHandle.read(buffer.subarray(offset, offset + length), { at: position });
      },
      write(stream, buffer, offset, length, position) {
        var n = stream.opfsHandle.write(buffer.subarray(offset, offset + length), { at: position });
        stream.node.opfsSize = Math.max(stream.node.opfsSize || 0, position + n);
        SZOPFS.onWrite?.(stream.path, n);
        return n;
      },
      llseek(stream, offset, whence) {
        var position = offset;
        if (whence === {{{ cDefs.SEEK_CUR }}}) {
          position += stream.position;
        } else if (whence === {{{ cDefs.SEEK_END }}}) {
          position += stream.node.opfsSize || 0;
        }
        if (position < 0) {
          throw new FS.ErrnoError({{{ cDefs.EINVAL }}});
        }
        return position;
      },
    },
  },

  // --- Async bridge: the only two functions that need to await OPFS handle
  // acquisition. Both are the actual wasm-import boundary (verified against
  // Emscripten's src/lib/libsyscall.js), which is exactly where classic
  // Asyncify needs to know an import may suspend (see ASYNCIFY_IMPORTS).
  __syscall_openat__deps: ['$SYSCALLS', '$syscallGetVarargI', '$SZOPFS', '$FS'],
  // Required for classic Asyncify (-sASYNCIFY=1): merely declaring the JS
  // function `async` is not enough -- this metadata flag is what makes the
  // build wrap the function body in Asyncify.handleAsync(), which is the
  // actual bridge between a Promise-returning JS import and the
  // unwind/rewind protocol Binaryen instruments into the wasm call graph.
  // Without it, the raw Promise leaks back into wasm as if it were the
  // plain (synchronous) return value, corrupting later syscalls.
  __syscall_openat__async: 'auto',
  // Asyncify.instrumentWasmImports() only wraps imports in try/finally, not
  // try/catch -- and for an async function, a thrown FS.ErrnoError becomes a
  // *rejected promise*, not a synchronous throw, so that finally-only wrapper
  // never sees it. Left uncaught, it surfaces as a crashing unhandled
  // rejection instead of the negative-errno return value libc's syscall
  // callers (and 7-Zip's own EEXIST-tolerant mkdir-chain logic) expect. So we
  // must do the ErrnoError-to-errno conversion ourselves here.
  __syscall_openat: async (dirfd, path, flags, varargs) => {
    try {
      path = SYSCALLS.getStr(path);
      path = SYSCALLS.calculateAt(dirfd, path);
      var mode = varargs ? syscallGetVarargI() : 0;
      if (flags & {{{ cDefs.O_CREAT }}}) {
        mode &= ~SYSCALLS.currentUmask;
        await SZOPFS.prepareFile(path);
      }
      return FS.open(path, flags, mode).fd;
    } catch (e) {
      if (e instanceof FS.ErrnoError) return -e.errno;
      throw e;
    }
  },

  __syscall_mkdirat__deps: ['$SYSCALLS', '$SZOPFS', '$FS'],
  __syscall_mkdirat__async: 'auto',
  __syscall_mkdirat: async (dirfd, path, mode) => {
    try {
      path = SYSCALLS.getStr(path);
      path = SYSCALLS.calculateAt(dirfd, path);
      mode &= ~SYSCALLS.currentUmask;
      await SZOPFS.prepareDir(path);
      FS.mkdir(path, mode, 0);
      return 0;
    } catch (e) {
      if (e instanceof FS.ErrnoError) return -e.errno;
      throw e;
    }
  },
});
