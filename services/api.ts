import AsyncStorage from "@react-native-async-storage/async-storage";

// region: --- Interface Definitions ---
export interface DoubanItem {
  title: string;
  poster: string;
  rate?: string;
}

export interface DoubanResponse {
  code: number;
  message: string;
  list: DoubanItem[];
}

export interface VideoDetail {
  id: string;
  title: string;
  poster: string;
  source: string;
  source_name: string;
  desc?: string;
  type?: string;
  year?: string;
  area?: string;
  director?: string;
  actor?: string;
  remarks?: string;
}

export interface SearchResult {
  id: number;
  title: string;
  poster: string;
  episodes: string[];
  source: string;
  source_name: string;
  class?: string;
  year: string;
  desc?: string;
  type_name?: string;
}

export interface Favorite {
  cover: string;
  title: string;
  source_name: string;
  total_episodes: number;
  search_title: string;
  year: string;
  save_time?: number;
}

export interface PlayRecord {
  title: string;
  source_name: string;
  cover: string;
  index: number;
  total_episodes: number;
  play_time: number;
  total_time: number;
  save_time: number;
  year: string;
}

export interface ApiSite {
  key: string;
  api: string;
  name: string;
  detail?: string;
}

export interface ServerConfig {
  SiteName: string;
  StorageType: "localstorage" | "redis" | string;
}

export class API {
  public baseURL: string = "";

  // 会话恢复回调（由 authStore 注册），401 时自动重登并重试一次
  private sessionRestorer: (() => Promise<boolean>) | null = null;

  // 默认请求超时（毫秒）
  private static readonly DEFAULT_TIMEOUT = 15000;

  constructor(baseURL?: string) {
    if (baseURL) {
      this.baseURL = baseURL;
    }
  }

  public setBaseUrl(url: string) {
    this.baseURL = url;
  }

  public setSessionRestorer(restorer: (() => Promise<boolean>) | null) {
    this.sessionRestorer = restorer;
  }

  private async _fetch(url: string, options: RequestInit = {}, timeoutMs: number = API.DEFAULT_TIMEOUT): Promise<Response> {
    if (!this.baseURL) {
      throw new Error("API_URL_NOT_SET");
    }

    // 超时控制：调用方传入的 signal 优先，否则创建带超时的 controller
    let signal = options.signal;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (!signal) {
      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      signal = controller.signal;
    }

    try {
      // 框架默认会携带 cookie，无需手动设置
      const response = await fetch(`${this.baseURL}${url}`, { ...options, signal });

      if (response.status === 401) {
        // 会话过期：自动重登后重试一次（登录接口本身除外，避免循环）
        // 只对幂等请求自动重试（GET/DELETE/HEAD）；POST/PUT 等非幂等请求不自动重试，
        // 避免"首次请求成功但响应丢失"时重试导致重复提交（如重复添加收藏）
        const method = (options.method || "GET").toUpperCase();
        const isIdempotent = method === "GET" || method === "DELETE" || method === "HEAD";
        if (this.sessionRestorer && !url.startsWith("/api/login") && isIdempotent) {
          const restored = await this.sessionRestorer();
          if (restored) {
            // 重试时若原 signal 已中止（如超时），用新的超时 signal，避免重试直接失败
            let retrySignal = signal;
            let retryTimeoutId: ReturnType<typeof setTimeout> | undefined;
            if (signal.aborted) {
              const retryController = new AbortController();
              retryTimeoutId = setTimeout(() => retryController.abort(), timeoutMs);
              retrySignal = retryController.signal;
            }
            try {
              const retryResponse = await fetch(`${this.baseURL}${url}`, { ...options, signal: retrySignal });
              if (retryResponse.status === 401) {
                throw new Error("UNAUTHORIZED");
              }
              if (!retryResponse.ok) {
                throw new Error(`HTTP error! status: ${retryResponse.status}`);
              }
              return retryResponse;
            } finally {
              if (retryTimeoutId) {
                clearTimeout(retryTimeoutId);
              }
            }
          }
        }
        throw new Error("UNAUTHORIZED");
      }

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return response;
    } catch (error) {
      // 超时错误转为更友好的错误信息
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`REQUEST_TIMEOUT: ${url}`);
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  async login(username?: string | undefined, password?: string): Promise<{ ok: boolean }> {
    const response = await this._fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    // 注意：Set-Cookie 是 forbidden response header，RN 的 fetch 无法通过
    // headers.get() 读取（永远返回 null）。但原生网络层（OkHttp/NSURLSession）
    // 会自动管理 cookie jar，后续请求会自动携带 cookie。
    // 这里只存一个登录标记位，供 authStore.checkLoginStatus 判断用。
    const result = await response.json();
    if (result && result.ok) {
      await AsyncStorage.setItem("authCookies", "1");
    }

    return result;
  }

  async logout(): Promise<{ ok: boolean }> {
    const response = await this._fetch("/api/logout", {
      method: "POST",
    });
    await AsyncStorage.setItem("authCookies", '');
    return response.json();
  }

  async getServerConfig(): Promise<ServerConfig> {
    const response = await this._fetch("/api/server-config");
    return response.json();
  }

  async getFavorites(key?: string): Promise<Record<string, Favorite> | Favorite | null> {
    const url = key ? `/api/favorites?key=${encodeURIComponent(key)}` : "/api/favorites";
    const response = await this._fetch(url);
    return response.json();
  }

  async addFavorite(key: string, favorite: Omit<Favorite, "save_time">): Promise<{ success: boolean }> {
    const response = await this._fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, favorite }),
    });
    return response.json();
  }

  async deleteFavorite(key?: string): Promise<{ success: boolean }> {
    const url = key ? `/api/favorites?key=${encodeURIComponent(key)}` : "/api/favorites";
    const response = await this._fetch(url, { method: "DELETE" });
    return response.json();
  }

  async getPlayRecords(): Promise<Record<string, PlayRecord>> {
    const response = await this._fetch("/api/playrecords");
    return response.json();
  }

  async savePlayRecord(key: string, record: Omit<PlayRecord, "save_time">): Promise<{ success: boolean }> {
    const response = await this._fetch("/api/playrecords", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, record }),
    });
    return response.json();
  }

  async deletePlayRecord(key?: string): Promise<{ success: boolean }> {
    const url = key ? `/api/playrecords?key=${encodeURIComponent(key)}` : "/api/playrecords";
    const response = await this._fetch(url, { method: "DELETE" });
    return response.json();
  }

  async getSearchHistory(): Promise<string[]> {
    const response = await this._fetch("/api/searchhistory");
    return response.json();
  }

  async addSearchHistory(keyword: string): Promise<string[]> {
    const response = await this._fetch("/api/searchhistory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword }),
    });
    return response.json();
  }

  async deleteSearchHistory(keyword?: string): Promise<{ success: boolean }> {
    const url = keyword ? `/api/searchhistory?keyword=${keyword}` : "/api/searchhistory";
    const response = await this._fetch(url, { method: "DELETE" });
    return response.json();
  }

  getImageProxyUrl(imageUrl: string): string {
    if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.trim()) {
      return "";
    }
    return `${this.baseURL}/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;
  }

  async getDoubanData(
    type: "movie" | "tv",
    tag: string,
    pageSize: number = 16,
    pageStart: number = 0
  ): Promise<DoubanResponse> {
    const url = `/api/douban?type=${type}&tag=${encodeURIComponent(tag)}&pageSize=${pageSize}&pageStart=${pageStart}`;
    const response = await this._fetch(url);
    return response.json();
  }

  async searchVideos(query: string): Promise<{ results: SearchResult[] }> {
    const url = `/api/search?q=${encodeURIComponent(query)}`;
    const response = await this._fetch(url);
    return response.json();
  }

  async searchVideo(query: string, resourceId: string, signal?: AbortSignal): Promise<{ results: SearchResult[] }> {
    const url = `/api/search/one?q=${encodeURIComponent(query)}&resourceId=${encodeURIComponent(resourceId)}`;
    const response = await this._fetch(url, { signal });
    const { results } = await response.json();
    // 模糊匹配：归一化后比较（去空格、转小写），避免标题多一个符号就丢结果
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, "");
    const normalizedQuery = normalize(query);
    return {
      results: (results as SearchResult[]).filter((item: SearchResult) =>
        item.title && normalize(item.title).includes(normalizedQuery)
      ),
    };
  }

  async getResources(signal?: AbortSignal): Promise<ApiSite[]> {
    const url = `/api/search/resources`;
    const response = await this._fetch(url, { signal });
    return response.json();
  }

  async getVideoDetail(source: string, id: string): Promise<VideoDetail> {
    const url = `/api/detail?source=${source}&id=${id}`;
    const response = await this._fetch(url);
    return response.json();
  }
}

// 默认实例
export let api = new API();
