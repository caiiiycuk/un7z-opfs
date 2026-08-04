export interface ProgressInfo {
  processedBytes: number;
  totalBytes: number;
  currentFile: string | null;
}

export interface ExtractOptions {
  /** Raw .7z archive bytes. */
  archive: Uint8Array | ArrayBuffer;
  /**
   * Destination folder path, relative to the OPFS root
   * (`navigator.storage.getDirectory()`). Must not start with "/" and must
   * not contain ".." segments. There is no way to target an arbitrary
   * pre-existing `FileSystemDirectoryHandle` -- see README.
   */
  destPath: string;
  onProgress?: (info: ProgressInfo) => void;
}

/**
 * Extracts a .7z archive directly into OPFS. Must be called from inside a
 * dedicated Web Worker (FileSystemSyncAccessHandle, which the underlying FS
 * backend depends on, is unavailable elsewhere). Rejects on extraction
 * failure (invalid archive, I/O error, etc).
 */
export function extractToOpfs(options: ExtractOptions): Promise<void>;

export type InboundMessage = {
  type: 'extract';
  id?: string;
  archive: ArrayBuffer;
  destPath: string;
};

export type OutboundMessage =
  | ({ type: 'progress'; id?: string } & ProgressInfo)
  | { type: 'done'; id?: string }
  | { type: 'error'; id?: string; message: string; stack?: string };
