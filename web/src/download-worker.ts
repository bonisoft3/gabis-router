// Streams a large .pmtiles file from the network and decomposes it into fixed 1 MB blocks
// inside Mecha's unmodified IndexedDB BlobStorage (`createIdbBlobStorage`).
import {
  getMechaBlobStorage,
  writePmtilesStreamToBlocks,
} from './pronto/decomposed-storage.ts';

export type DownloadRequest = { url: string; fileName: string; segmentId?: string };

export type DownloadEvent =
  | { type: 'progress'; received: number; total: number }
  | { type: 'done'; size: number }
  | { type: 'error'; error: string };

self.onmessage = async (e: MessageEvent<DownloadRequest>) => {
  const { url, fileName, segmentId } = e.data;
  const segId = segmentId || fileName.replace(/\.pmtiles$/i, '');
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    if ((res.headers.get('content-type') || '').includes('text/html')) {
      throw new Error(`${url} is not available on this server`);
    }
    const total = Number(res.headers.get('content-length')) || 0;

    if (navigator.storage?.estimate) {
      const { quota = 0, usage = 0 } = await navigator.storage.estimate();
      if (total > 0 && quota > 0 && total > quota - usage) {
        const needMb = Math.round(total / (1024 * 1024));
        const freeMb = Math.round((quota - usage) / (1024 * 1024));
        throw new Error(
          `Not enough browser storage for ${fileName}: needs ${needMb} MB, ${freeMb} MB free`,
        );
      }
    }

    const storage = getMechaBlobStorage();
    const meta = await writePmtilesStreamToBlocks(
      storage,
      segId,
      res.body,
      total,
      (received, tot) => {
        postMessage({ type: 'progress', received, total: tot } satisfies DownloadEvent);
      },
    );

    postMessage({ type: 'done', size: meta.size } satisfies DownloadEvent);
  } catch (err) {
    postMessage({
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    } satisfies DownloadEvent);
  }
};
