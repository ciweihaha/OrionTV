import Logger from '@/utils/Logger';

const logger = Logger.withTag('M3U8');

interface CacheEntry {
  resolution: string | null;
  timestamp: number;
}

const resolutionCache: { [url: string]: CacheEntry } = {};
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
// 缓存上限：防 URL 枚举导致内存无限增长（R13）
const MAX_CACHE_ENTRIES = 500;
// 播放列表最大体积：m3u8 索引文件通常 < 100KB，1MB 已足够（R13）
const MAX_PLAYLIST_BYTES = 1024 * 1024;
// 无外部 signal 时的默认超时（R13）
const DEFAULT_TIMEOUT_MS = 10_000;

const evictCacheIfNeeded = () => {
  const keys = Object.keys(resolutionCache);
  if (keys.length >= MAX_CACHE_ENTRIES) {
    // 删除最旧的 1/4 条目（按 timestamp）
    const sorted = keys
      .map((k) => ({ k, t: resolutionCache[k].timestamp }))
      .sort((a, b) => a.t - b.t);
    const toDelete = Math.ceil(keys.length / 4);
    for (let i = 0; i < toDelete; i++) {
      delete resolutionCache[sorted[i].k];
    }
    logger.info(`[M3U8] Cache evicted ${toDelete} entries, ${keys.length - toDelete} remaining`);
  }
};

export const getResolutionFromM3U8 = async (
  url: string,
  signal?: AbortSignal
): Promise<string | null> => {
  const perfStart = performance.now();
  logger.info(`[PERF] M3U8 resolution detection START - url: ${url.substring(0, 100)}...`);
  
  // 1. Check cache first
  const cachedEntry = resolutionCache[url];
  if (cachedEntry && Date.now() - cachedEntry.timestamp < CACHE_DURATION) {
    const perfEnd = performance.now();
    logger.info(`[PERF] M3U8 resolution detection CACHED - took ${(perfEnd - perfStart).toFixed(2)}ms, resolution: ${cachedEntry.resolution}`);
    return cachedEntry.resolution;
  }

  if (!url.toLowerCase().endsWith(".m3u8")) {
    logger.info(`[PERF] M3U8 resolution detection SKIPPED - not M3U8 file`);
    return null;
  }

  // 无外部 signal 时使用默认超时（R13）
  const controller = signal ? null : new AbortController();
  const timeoutId = controller ? setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS) : null;
  try {
    const fetchStart = performance.now();
    const response = await fetch(url, { signal: signal ?? controller!.signal });
    const fetchEnd = performance.now();
    logger.info(`[PERF] M3U8 fetch took ${(fetchEnd - fetchStart).toFixed(2)}ms, status: ${response.status}`);

    if (!response.ok) {
      return null;
    }

    const parseStart = performance.now();
    // 流式读取并限制体积：防恶意服务端返回超大播放列表占满内存（R13）
    const playlist = await readTextWithLimit(response, MAX_PLAYLIST_BYTES);
    if (playlist === null) {
      logger.info(`[PERF] M3U8 playlist exceeded ${MAX_PLAYLIST_BYTES} bytes, rejected`);
      return null;
    }
    const lines = playlist.split("\n");
    let highestResolution = 0;
    let resolutionString: string | null = null;

    for (const line of lines) {
      if (line.startsWith("#EXT-X-STREAM-INF")) {
        const resolutionMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
        if (resolutionMatch) {
          const height = parseInt(resolutionMatch[2], 10);
          if (height > highestResolution) {
            highestResolution = height;
            resolutionString = `${height}p`;
          }
        }
      }
    }
    
    const parseEnd = performance.now();
    logger.info(`[PERF] M3U8 parsing took ${(parseEnd - parseStart).toFixed(2)}ms, lines: ${lines.length}`);

    // 2. Store result in cache
    evictCacheIfNeeded();
    resolutionCache[url] = {
      resolution: resolutionString,
      timestamp: Date.now(),
    };

    const perfEnd = performance.now();
    logger.info(`[PERF] M3U8 resolution detection COMPLETE - took ${(perfEnd - perfStart).toFixed(2)}ms, resolution: ${resolutionString}`);
    
    return resolutionString;
  } catch (error) {
    const perfEnd = performance.now();
    logger.info(`[PERF] M3U8 resolution detection ERROR - took ${(perfEnd - perfStart).toFixed(2)}ms, error: ${error}`);
    return null;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

/**
 * 流式读取响应体文本，超限返回 null（R13）
 */
const readTextWithLimit = async (response: Response, maxBytes: number): Promise<string | null> => {
  const reader = response.body?.getReader();
  if (!reader) {
    // 无 body 流时回退（通常不会发生）
    const text = await response.text();
    return text.length <= maxBytes ? text : null;
  }
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let result = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();
    return result;
  } finally {
    reader.releaseLock();
  }
};
