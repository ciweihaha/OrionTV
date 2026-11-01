import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { api, PlayRecord as ApiPlayRecord, Favorite as ApiFavorite } from "./api";
import { storageConfig } from "./storageConfig";
import Logger from '@/utils/Logger';

const logger = Logger.withTag('Storage');

// --- Storage Keys ---
const STORAGE_KEYS = {
  SETTINGS: "mytv_settings",
  PLAYER_SETTINGS: "mytv_player_settings",
  FAVORITES: "mytv_favorites",
  PLAY_RECORDS: "mytv_play_records",
  SEARCH_HISTORY: "mytv_search_history",
  LOGIN_CREDENTIALS: "mytv_login_credentials",
  M3U_CACHE_PREFIX: "mytv_m3u_cache_",
  LIVE_LAST_CHANNEL: "mytv_live_last_channel",
  LIVE_FAV_CHANNELS: "mytv_live_fav_channels",
} as const;

// --- Type Definitions (aligned with api.ts) ---
// Re-exporting for consistency, though they are now primarily API types
export type PlayRecord = ApiPlayRecord & {
  introEndTime?: number;
  outroStartTime?: number;
};
export type Favorite = ApiFavorite;

export interface PlayerSettings {
  introEndTime?: number;
  outroStartTime?: number;
  playbackRate?: number;
}

export interface AppSettings {
  apiBaseUrl: string;
  remoteInputEnabled: boolean;
  videoSource: {
    enabledAll: boolean;
    sources: {
      [key: string]: boolean;
    };
  };
  m3uUrl: string;
}

export interface LoginCredentials {
  username: string;
  password: string;
}

// --- Helper ---
const generateKey = (source: string, id: string) => `${source}+${id}`;

// --- PlayerSettingsManager (Uses AsyncStorage) ---
/** 播放器个性化设置上限（仅用户自定义过片头/片尾/倍速的条目才会写入） */
const MAX_PLAYER_SETTINGS = 200;

export class PlayerSettingsManager {
  static async getAll(): Promise<Record<string, PlayerSettings>> {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEYS.PLAYER_SETTINGS);
      return data ? JSON.parse(data) : {};
    } catch (error) {
      logger.info("Failed to get all player settings:", error);
      return {};
    }
  }

  static async get(source: string, id: string): Promise<PlayerSettings | null> {
    const perfStart = performance.now();
    logger.info(`[PERF] PlayerSettingsManager.get START - source: ${source}, id: ${id}`);
    
    const allSettings = await this.getAll();
    const result = allSettings[generateKey(source, id)] || null;
    
    const perfEnd = performance.now();
    logger.info(`[PERF] PlayerSettingsManager.get END - took ${(perfEnd - perfStart).toFixed(2)}ms, found: ${!!result}`);
    
    return result;
  }

  static async save(source: string, id: string, settings: PlayerSettings): Promise<void> {
    const allSettings = await this.getAll();
    const key = generateKey(source, id);
    // Only save if there are actual values to save
    if (settings.introEndTime !== undefined || settings.outroStartTime !== undefined || settings.playbackRate !== undefined) {
      allSettings[key] = { ...allSettings[key], ...settings };
      // 超限时按插入顺序淘汰最旧条目（字符串 key 保持插入序）
      const keys = Object.keys(allSettings);
      if (keys.length > MAX_PLAYER_SETTINGS) {
        keys.slice(0, keys.length - MAX_PLAYER_SETTINGS).forEach((k) => delete allSettings[k]);
      }
    } else {
      // If all are undefined, remove the key
      delete allSettings[key];
    }
    await AsyncStorage.setItem(STORAGE_KEYS.PLAYER_SETTINGS, JSON.stringify(allSettings));
  }

  static async remove(source: string, id: string): Promise<void> {
    const allSettings = await this.getAll();
    delete allSettings[generateKey(source, id)];
    await AsyncStorage.setItem(STORAGE_KEYS.PLAYER_SETTINGS, JSON.stringify(allSettings));
  }

  static async clearAll(): Promise<void> {
    await AsyncStorage.removeItem(STORAGE_KEYS.PLAYER_SETTINGS);
  }
}

// --- FavoriteManager (Dynamic: API or LocalStorage) ---
export class FavoriteManager {
  private static getStorageType() {
    return storageConfig.getStorageType();
  }

  static async getAll(): Promise<Record<string, Favorite>> {
    if (this.getStorageType() === "localstorage") {
      try {
        const data = await AsyncStorage.getItem(STORAGE_KEYS.FAVORITES);
        return data ? JSON.parse(data) : {};
      } catch (error) {
        logger.info("Failed to get all local favorites:", error);
        return {};
      }
    }
    return (await api.getFavorites()) as Record<string, Favorite>;
  }

  static async save(source: string, id: string, item: Favorite): Promise<void> {
    const key = generateKey(source, id);
    if (this.getStorageType() === "localstorage") {
      const allFavorites = await this.getAll();
      allFavorites[key] = { ...item, save_time: Date.now() };
      await AsyncStorage.setItem(STORAGE_KEYS.FAVORITES, JSON.stringify(allFavorites));
      return;
    }
    await api.addFavorite(key, item);
  }

  static async remove(source: string, id: string): Promise<void> {
    const key = generateKey(source, id);
    if (this.getStorageType() === "localstorage") {
      const allFavorites = await this.getAll();
      delete allFavorites[key];
      await AsyncStorage.setItem(STORAGE_KEYS.FAVORITES, JSON.stringify(allFavorites));
      return;
    }
    await api.deleteFavorite(key);
  }

  static async isFavorited(source: string, id: string): Promise<boolean> {
    const key = generateKey(source, id);
    if (this.getStorageType() === "localstorage") {
      const allFavorites = await this.getAll();
      return !!allFavorites[key];
    }
    const favorite = await api.getFavorites(key);
    return favorite !== null;
  }

  static async toggle(source: string, id: string, item: Favorite): Promise<boolean> {
    const isFav = await this.isFavorited(source, id);
    if (isFav) {
      await this.remove(source, id);
      return false;
    } else {
      await this.save(source, id, item);
      return true;
    }
  }

  static async clearAll(): Promise<void> {
    if (this.getStorageType() === "localstorage") {
      await AsyncStorage.removeItem(STORAGE_KEYS.FAVORITES);
      return;
    }
    await api.deleteFavorite();
  }
}

// --- PlayRecordManager (Dynamic: API or LocalStorage) ---
/** 本地播放记录上限：防止 AsyncStorage 无限增长（Android 单 key 约 6MB 上限） */
const MAX_PLAY_RECORDS = 200;

export class PlayRecordManager {
  private static getStorageType() {
    return storageConfig.getStorageType();
  }

  static async getAll(): Promise<Record<string, PlayRecord>> {
    const perfStart = performance.now();
    const storageType = this.getStorageType();
    logger.info(`[PERF] PlayRecordManager.getAll START - storageType: ${storageType}`);
    
    let apiRecords: Record<string, PlayRecord> = {};
    if (storageType === "localstorage") {
      try {
        const data = await AsyncStorage.getItem(STORAGE_KEYS.PLAY_RECORDS);
        apiRecords = data ? JSON.parse(data) : {};
      } catch (error) {
        logger.info("Failed to get all local play records:", error);
        return {};
      }
    } else {
      const apiStart = performance.now();
      logger.info(`[PERF] API getPlayRecords START`);
      
      apiRecords = await api.getPlayRecords();
      
      const apiEnd = performance.now();
      logger.info(`[PERF] API getPlayRecords END - took ${(apiEnd - apiStart).toFixed(2)}ms, records: ${Object.keys(apiRecords).length}`);
    }

    const localSettings = await PlayerSettingsManager.getAll();
    const mergedRecords: Record<string, PlayRecord> = {};
    for (const key in apiRecords) {
      mergedRecords[key] = {
        ...apiRecords[key],
        ...localSettings[key],
      };
    }
    
    const perfEnd = performance.now();
    logger.info(`[PERF] PlayRecordManager.getAll END - took ${(perfEnd - perfStart).toFixed(2)}ms, total records: ${Object.keys(mergedRecords).length}`);
    
    return mergedRecords;
  }

  static async save(source: string, id: string, record: Omit<PlayRecord, "save_time">): Promise<void> {
    const key = generateKey(source, id);
    const { introEndTime, outroStartTime, ...apiRecord } = record;

    // Player settings are always saved locally
    await PlayerSettingsManager.save(source, id, { introEndTime, outroStartTime });

    if (this.getStorageType() === "localstorage") {
      const allRecords = await this.getAll();
      const fullRecord = { ...apiRecord, save_time: Date.now() };
      allRecords[key] = { ...allRecords[key], ...fullRecord };
      // 超限时按 save_time 淘汰最旧的记录
      const keys = Object.keys(allRecords);
      if (keys.length > MAX_PLAY_RECORDS) {
        keys
          .sort((a, b) => (allRecords[a].save_time || 0) - (allRecords[b].save_time || 0))
          .slice(0, keys.length - MAX_PLAY_RECORDS)
          .forEach((k) => delete allRecords[k]);
      }
      await AsyncStorage.setItem(STORAGE_KEYS.PLAY_RECORDS, JSON.stringify(allRecords));
    } else {
      await api.savePlayRecord(key, apiRecord);
    }
  }

  static async get(source: string, id: string): Promise<PlayRecord | null> {
    const perfStart = performance.now();
    const key = generateKey(source, id);
    const storageType = this.getStorageType();
    logger.info(`[PERF] PlayRecordManager.get START - source: ${source}, id: ${id}, storageType: ${storageType}`);
    
    const records = await this.getAll();
    const result = records[key] || null;
    
    const perfEnd = performance.now();
    logger.info(`[PERF] PlayRecordManager.get END - took ${(perfEnd - perfStart).toFixed(2)}ms, found: ${!!result}`);
    
    return result;
  }

  static async remove(source: string, id: string): Promise<void> {
    const key = generateKey(source, id);
    await PlayerSettingsManager.remove(source, id); // Always remove local settings

    if (this.getStorageType() === "localstorage") {
      const allRecords = await this.getAll();
      delete allRecords[key];
      await AsyncStorage.setItem(STORAGE_KEYS.PLAY_RECORDS, JSON.stringify(allRecords));
    } else {
      await api.deletePlayRecord(key);
    }
  }

  static async clearAll(): Promise<void> {
    await PlayerSettingsManager.clearAll(); // Always clear local settings

    if (this.getStorageType() === "localstorage") {
      await AsyncStorage.removeItem(STORAGE_KEYS.PLAY_RECORDS);
    } else {
      await api.deletePlayRecord();
    }
  }
}

// --- SearchHistoryManager (Dynamic: API or LocalStorage) ---
export class SearchHistoryManager {
  private static getStorageType() {
    return storageConfig.getStorageType();
  }

  static async get(): Promise<string[]> {
    if (this.getStorageType() === "localstorage") {
      try {
        const data = await AsyncStorage.getItem(STORAGE_KEYS.SEARCH_HISTORY);
        return data ? JSON.parse(data) : [];
      } catch (error) {
        logger.info("Failed to get local search history:", error);
        return [];
      }
    }
    return api.getSearchHistory();
  }

  static async add(keyword: string): Promise<void> {
    const trimmed = keyword.trim();
    if (!trimmed) return;

    if (this.getStorageType() === "localstorage") {
      let history = await this.get();
      history = [trimmed, ...history.filter((k) => k !== trimmed)].slice(0, 20); // Keep latest 20
      await AsyncStorage.setItem(STORAGE_KEYS.SEARCH_HISTORY, JSON.stringify(history));
      return;
    }
    await api.addSearchHistory(trimmed);
  }

  static async clear(): Promise<void> {
    if (this.getStorageType() === "localstorage") {
      await AsyncStorage.removeItem(STORAGE_KEYS.SEARCH_HISTORY);
      return;
    }
    await api.deleteSearchHistory();
  }
}

// --- M3U 列表缓存（V1.5：直播页秒进） ---
/** m3u 磁盘缓存有效期（毫秒）：7 天内直接用缓存，后台刷新成功后更新 */
const M3U_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 缓存 JSON 体积上限：超大列表不落盘（AsyncStorage 单 key 6MB 上限的一半，留安全余量） */
const MAX_M3U_CACHE_BYTES = 3 * 1024 * 1024;

export interface M3uCacheEntry {
  ts: number;
  channels: { id: string; name: string; url: string; logo: string; group: string }[];
}

export class M3uCacheManager {
  static async get(m3uUrl: string): Promise<M3uCacheEntry | null> {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEYS.M3U_CACHE_PREFIX + m3uUrl);
      if (!data) return null;
      // 体积预检：JSON 超限视为不可用（读回大字符串也耗时）
      if (data.length > MAX_M3U_CACHE_BYTES) return null;
      const entry = JSON.parse(data) as M3uCacheEntry;
      if (!entry || !Array.isArray(entry.channels)) return null;
      if (Date.now() - entry.ts > M3U_CACHE_TTL_MS) return null; // 过期视为未命中
      return entry;
    } catch (error) {
      logger.info("Failed to get m3u cache:", error);
      return null;
    }
  }

  static async save(m3uUrl: string, channels: M3uCacheEntry["channels"]): Promise<void> {
    try {
      const entry: M3uCacheEntry = { ts: Date.now(), channels };
      const json = JSON.stringify(entry);
      if (json.length > MAX_M3U_CACHE_BYTES) {
        logger.info(`m3u cache skipped (too large): ${json.length} bytes`);
        return;
      }
      await AsyncStorage.setItem(STORAGE_KEYS.M3U_CACHE_PREFIX + m3uUrl, json);
    } catch (error) {
      logger.info("Failed to save m3u cache:", error);
    }
  }

  static async clear(): Promise<void> {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const m3uKeys = keys.filter((k) => k.startsWith(STORAGE_KEYS.M3U_CACHE_PREFIX));
      if (m3uKeys.length > 0) await AsyncStorage.multiRemove(m3uKeys);
    } catch (error) {
      logger.info("Failed to clear m3u cache:", error);
    }
  }
}

// --- 直播频道偏好（V1.5：上次频道 + 频道收藏） ---
export interface LiveLastChannel {
  url: string;
  name: string;
}

export class LiveChannelPrefsManager {
  /** 记住上次观看的直播频道（按 url 恢复，列表刷新后仍能定位） */
  static async getLastChannel(): Promise<LiveLastChannel | null> {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEYS.LIVE_LAST_CHANNEL);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.info("Failed to get last live channel:", error);
      return null;
    }
  }

  static async saveLastChannel(channel: LiveLastChannel): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.LIVE_LAST_CHANNEL, JSON.stringify(channel));
    } catch (error) {
      logger.info("Failed to save last live channel:", error);
    }
  }

  /** 收藏的直播频道（本地存储，不进点播收藏体系；上限 100 防无限增长） */
  static async getFavChannels(): Promise<LiveLastChannel[]> {
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEYS.LIVE_FAV_CHANNELS);
      return data ? JSON.parse(data) : [];
    } catch (error) {
      logger.info("Failed to get favorite live channels:", error);
      return [];
    }
  }

  static async toggleFavChannel(channel: LiveLastChannel): Promise<boolean> {
    const favs = await this.getFavChannels();
    const idx = favs.findIndex((c) => c.url === channel.url);
    if (idx >= 0) {
      favs.splice(idx, 1);
      await AsyncStorage.setItem(STORAGE_KEYS.LIVE_FAV_CHANNELS, JSON.stringify(favs));
      return false; // 已取消收藏
    }
    favs.unshift({ url: channel.url, name: channel.name });
    if (favs.length > 100) favs.length = 100;
    await AsyncStorage.setItem(STORAGE_KEYS.LIVE_FAV_CHANNELS, JSON.stringify(favs));
    return true; // 已收藏
  }

  static isFavChannels(favs: LiveLastChannel[], url: string): boolean {
    return favs.some((c) => c.url === url);
  }
}

// --- SettingsManager (Uses AsyncStorage) ---
export class SettingsManager {
  static async get(): Promise<AppSettings> {
    const defaultSettings: AppSettings = {
      apiBaseUrl: "",
      remoteInputEnabled: true,
      videoSource: {
        enabledAll: true,
        sources: {},
      },
      m3uUrl: "",
    };
    try {
      const data = await AsyncStorage.getItem(STORAGE_KEYS.SETTINGS);
      return data ? { ...defaultSettings, ...JSON.parse(data) } : defaultSettings;
    } catch (error) {
      logger.info("Failed to get settings:", error);
      return defaultSettings;
    }
  }

  static async save(settings: Partial<AppSettings>): Promise<void> {
    const currentSettings = await this.get();
    const updatedSettings = { ...currentSettings, ...settings };
    await AsyncStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(updatedSettings));
  }

  static async reset(): Promise<void> {
    await AsyncStorage.removeItem(STORAGE_KEYS.SETTINGS);
  }
}

// --- LoginCredentialsManager (Uses expo-secure-store) ---
// 安全说明：登录凭据必须存放在系统级安全存储（iOS Keychain / Android Keystore），
// 而不是 AsyncStorage（明文）。SecureStore 在设备锁定时加密，卸载 App 后由系统清理。
export class LoginCredentialsManager {
  static async get(): Promise<LoginCredentials | null> {
    try {
      const data = await SecureStore.getItemAsync(STORAGE_KEYS.LOGIN_CREDENTIALS);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.info("Failed to get login credentials:", error);
      return null;
    }
  }

  static async save(credentials: LoginCredentials): Promise<void> {
    try {
      await SecureStore.setItemAsync(
        STORAGE_KEYS.LOGIN_CREDENTIALS,
        JSON.stringify(credentials)
      );
      // 兼容：清理旧版存在 AsyncStorage 里的明文凭据
      await AsyncStorage.removeItem(STORAGE_KEYS.LOGIN_CREDENTIALS);
    } catch (error) {
      logger.error("Failed to save login credentials:", error);
    }
  }

  static async clear(): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(STORAGE_KEYS.LOGIN_CREDENTIALS);
      // 兼容：同时清理旧版明文残留
      await AsyncStorage.removeItem(STORAGE_KEYS.LOGIN_CREDENTIALS);
    } catch (error) {
      logger.error("Failed to clear login credentials:", error);
    }
  }
}
