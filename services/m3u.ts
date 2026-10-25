import Logger from '@/utils/Logger';
import { utf8ByteLength } from '../utils/utf8ByteLength';

const logger = Logger.withTag('M3U');

export interface Channel {
  id: string;
  name: string;
  url: string;
  logo: string;
  group: string;
}

const parseM3U = (m3uText: string): Channel[] => {
  const parsedChannels: Channel[] = [];
  const lines = m3uText.split('\n');
  let currentChannelInfo: Partial<Channel> | null = null;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith('#EXTINF:')) {
      currentChannelInfo = {}; // Start a new channel
      const commaIndex = trimmedLine.lastIndexOf(',');
      if (commaIndex !== -1) {
        currentChannelInfo.name = trimmedLine.substring(commaIndex + 1).trim();
        const attributesPart = trimmedLine.substring(8, commaIndex);
        const logoMatch = attributesPart.match(/tvg-logo="([^"]*)"/i);
        if (logoMatch && logoMatch[1]) {
          currentChannelInfo.logo = logoMatch[1];
        }
        const groupMatch = attributesPart.match(/group-title="([^"]*)"/i);
        if (groupMatch && groupMatch[1]) {
          currentChannelInfo.group = groupMatch[1];
        }
      } else {
        currentChannelInfo.name = trimmedLine.substring(8).trim();
      }
    } else if (currentChannelInfo && trimmedLine && !trimmedLine.startsWith('#') && trimmedLine.includes('://')) {
      currentChannelInfo.url = trimmedLine;
      currentChannelInfo.id = currentChannelInfo.url; // Use URL as ID
      
      // Ensure all required fields are present, providing defaults if necessary
      const finalChannel: Channel = {
        id: currentChannelInfo.id,
        url: currentChannelInfo.url,
        name: currentChannelInfo.name || 'Unknown',
        logo: currentChannelInfo.logo || '',
        group: currentChannelInfo.group || 'Default',
      };
      
      parsedChannels.push(finalChannel);
      currentChannelInfo = null; // Reset for the next channel
    }
  }
  return parsedChannels;
};

// M3U 拉取超时（毫秒）
const M3U_FETCH_TIMEOUT_MS = 15_000;
// M3U 播放列表最大体积：频道列表通常 < 1MB，5MB 已足够（R13）
const MAX_M3U_BYTES = 5 * 1024 * 1024;

export const fetchAndParseM3u = async (m3uUrl: string): Promise<Channel[]> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), M3U_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(m3uUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch M3U: ${response.statusText}`);
    }
    // 流式读取并限制体积：防超大列表占满内存（R13）
    const m3uText = await readTextWithLimit(response, MAX_M3U_BYTES);
    if (m3uText === null) {
      logger.info(`M3U playlist exceeded ${MAX_M3U_BYTES} bytes, rejected: ${m3uUrl.substring(0, 80)}`);
      return [];
    }
    return parseM3U(m3uText);
  } catch (error) {
    logger.info("Error fetching or parsing M3U:", error);
    return []; // Return empty array on error
  } finally {
    clearTimeout(timeoutId);
  }
};

export const getPlayableUrl = (originalUrl: string | null): string | null => {
  if (!originalUrl) {
    return null;
  }
  // 直播流地址直接播放（历史代理方案已下线）。
  return originalUrl;
};

/**
 * 流式读取响应体文本，超限返回 null（R13）
 * OTV-3：与 api.ts 的 readJsonLimited 同步——无流分支不再用 text.length
 * （UTF-16 码元数）判断，改用共享工具 utf8ByteLength 按 UTF-8 字节判断；
 * 并移植 Content-Length 预检，诚实偏大的声明在读体前即返回 null。
 * 超限后返回空列表（fail-closed，见 fetchAndParseM3u）保持不变。
 * 注意：个别超大中文列表会由“放行”变“拒绝并返回空列表”，属预期收紧。
 */
const readTextWithLimit = async (response: Response, maxBytes: number): Promise<string | null> => {
  // Content-Length 预检：与 api.ts 的 early reject 一致，缺失或谎报的声明
  // 仍由后续字节校验兜底。
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return utf8ByteLength(text) <= maxBytes ? text : null;
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
