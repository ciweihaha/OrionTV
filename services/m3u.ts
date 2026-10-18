import Logger from '@/utils/Logger';

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
 */
const readTextWithLimit = async (response: Response, maxBytes: number): Promise<string | null> => {
  const reader = response.body?.getReader();
  if (!reader) {
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
