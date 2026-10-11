// Streams a large file from the network straight to the Origin Private File System (OPFS).
// Each chunk is written to disk as it arrives, so memory use stays flat no matter the file size.
// Runs in a worker because createSyncAccessHandle is only available off the main thread.

export type DownloadRequest = { url: string; fileName: string };

export type DownloadEvent =
  | { type: 'progress'; received: number; total: number }
  | { type: 'done'; size: number }
  | { type: 'error'; error: string };

self.onmessage = async (e: MessageEvent<DownloadRequest>) => {
  const { url, fileName } = e.data;
  let handle: FileSystemSyncAccessHandle | null = null;
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    // Static hosts answer missing files with index.html and HTTP 200.
    if ((res.headers.get('content-type') || '').includes('text/html')) {
      throw new Error(`${url} is not available on this server`);
    }
    const total = Number(res.headers.get('content-length')) || 0;

    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    if (total > quota - usage) {
      const needMb = Math.round(total / (1024 * 1024));
      const freeMb = Math.round((quota - usage) / (1024 * 1024));
      throw new Error(`Not enough browser storage for ${fileName}: needs ${needMb} MB, ${freeMb} MB free`);
    }

    const dir = await navigator.storage.getDirectory();
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    handle = await fileHandle.createSyncAccessHandle();
    handle.truncate(0);

    const reader = res.body.getReader();
    let received = 0;
    let lastReport = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      handle.write(value, { at: received });
      received += value.byteLength;
      const now = Date.now();
      if (now - lastReport > 250) {
        lastReport = now;
        postMessage({ type: 'progress', received, total } satisfies DownloadEvent);
      }
    }
    handle.flush();

    if (total > 0 && received !== total) {
      throw new Error(`Incomplete download of ${url}: ${received} of ${total} bytes`);
    }
    postMessage({ type: 'done', size: received } satisfies DownloadEvent);
  } catch (err) {
    postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) } satisfies DownloadEvent);
  } finally {
    handle?.close();
  }
};
