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

  // API JSON 响应最大体积：接口返回均为小对象/列表，2MB 已足够（做法参照 services/m3u.ts 的体积限制）
  private static readonly MAX_JSON_BYTES = 2 * 1024 * 1024;

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


  /**
   * 带体积上限的 JSON 读取：流式累加响应体，超限抛错（防超大响应占满内存），
   * 然后 JSON.parse。做法与 services/m3u.ts 的 readTextWithLimit 一致。
   */
  private async readJsonLimited(response: Response): Promise<any> {
    // Early reject via Content-Length when the server provides one. The
    // no-reader fallback (response.text()) cannot stream, so its size is
    // only enforced after the body is read; this header check closes the
    // common case before any bytes are buffered. A missing or lying
    // Content-Length still falls through to the post-read length check.
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > API.MAX_JSON_BYTES) {
      throw new Error(`RESPONSE_TOO_LARGE: body exceeded ${API.MAX_JSON_BYTES} bytes`);
    }
    const reader = response.body?.getReader();
    let text: string;
    if (!reader) {
      text = await response.text();
    } else {
      const decoder = new TextDecoder();
      let totalBytes = 0;
      const chunks: string[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > API.MAX_JSON_BYTES) {
            await reader.cancel();
            throw new Error(`RESPONSE_TOO_LARGE: body exceeded ${API.MAX_JSON_BYTES} bytes`);
          }
          chunks.push(decoder.decode(value, { stream: true }));
        }
        chunks.push(decoder.decode());
        text = chunks.join("");
      } finally {
        reader.releaseLock();
      }
    }
    if (text.length > API.MAX_JSON_BYTES) {
      throw new Error(`RESPONSE_TOO_LARGE: body exceeded ${API.MAX_JSON_BYTES} bytes`);
    }
    return JSON.parse(text);
  }

  private async _fetch(url: string, options: RequestInit = {}, timeoutMs: number = API.DEFAULT_TIMEOUT): Promise<Response> {
    if (!this.baseURL) {
      throw new Error("API_URL_NOT_SET");
    }

    // 调用方 signal 单独持有、独立判断：它只代表"调用方主动取消"，与超时严格区分。
    // 401 等待会话恢复后、发起重试前、以及重试进行中，只要调用方已取消，
    // 一律不再发出（或立即中止）请求；只有超时导致的中止才允许换新信号重试。
    const callerSignal = options.signal;
    const callerAborted = () => !!callerSignal?.aborted;

    // 创建一个组合 controller：超时或调用方取消任一发生都会中止它。
    // 返回的 cleanup 须在退出时调用，负责清定时器与调用方监听，避免泄漏。
    const createLinkedController = () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      const onCallerAbort = () => controller.abort();
      if (callerSignal) {
        if (callerSignal.aborted) {
          controller.abort();
        } else {
          callerSignal.addEventListener("abort", onCallerAbort, { once: true });
        }
      }
      const cleanup = () => {
        clearTimeout(timeoutId);
        if (callerSignal) {
          callerSignal.removeEventListener("abort", onCallerAbort);
        }
      };
      return { signal: controller.signal, cleanup };
    };

    const abortError = () => {
      const err = new Error("The user aborted a request.");
      err.name = "AbortError";
      return err;
    };

    const first = createLinkedController();

    try {
      // 框架默认会携带 cookie，无需手动设置
      const response = await fetch(`${this.baseURL}${url}`, { ...options, signal: first.signal });

      if (response.status === 401) {
        // 会话过期：自动重登后重试一次（登录接口本身除外，避免循环）
        // 只对幂等请求自动重试（GET/DELETE/HEAD）；POST/PUT 等非幂等请求不自动重试，
        // 避免"首次请求成功但响应丢失"时重试导致重复提交（如重复添加收藏）
        const method = (options.method || "GET").toUpperCase();
        const isIdempotent = method === "GET" || method === "DELETE" || method === "HEAD";
        if (this.sessionRestorer && !url.startsWith("/api/login") && isIdempotent) {
          const restored = await this.sessionRestorer();
          if (restored) {
            // 会话恢复等待期间调用方可能已取消：被取消的请求绝不重试
            if (callerAborted()) {
              throw abortError();
            }
            // 首次 signal 已中止且并非调用方取消，只能是超时：换一个新的组合
            // signal 重试（同样受超时与调用方取消联动），避免重试直接失败
            let retrySignal = first.signal;
            let retryCleanup: (() => void) | null = null;
            if (first.signal.aborted) {
              const retry = createLinkedController();
              retrySignal = retry.signal;
              retryCleanup = retry.cleanup;
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
              if (retryCleanup) {
                retryCleanup();
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
      // 中止错误（超时或调用方取消）转为更友好的错误信息
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`REQUEST_TIMEOUT: ${url}`);
      }
      throw error;
    } finally {
      first.cleanup();
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
    const result = await this.readJsonLimited(response);
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
    return this.readJsonLimited(response);
  }

  async getServerConfig(): Promise<ServerConfig> {
    const response = await this._fetch("/api/server-config");
    return this.readJsonLimited(response);
  }

  async getFavorites(key?: string): Promise<Record<string, Favorite> | Favorite | null> {
    const url = key ? `/api/favorites?key=${encodeURIComponent(key)}` : "/api/favorites";
    const response = await this._fetch(url);
    return this.readJsonLimited(response);
  }

  async addFavorite(key: string, favorite: Omit<Favorite, "save_time">): Promise<{ success: boolean }> {
    const response = await this._fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, favorite }),
    });
    return this.readJsonLimited(response);
  }

  async deleteFavorite(key?: string): Promise<{ success: boolean }> {
    const url = key ? `/api/favorites?key=${encodeURIComponent(key)}` : "/api/favorites";
    const response = await this._fetch(url, { method: "DELETE" });
    return this.readJsonLimited(response);
  }

  async getPlayRecords(): Promise<Record<string, PlayRecord>> {
    const response = await this._fetch("/api/playrecords");
    return this.readJsonLimited(response);
  }

  async savePlayRecord(key: string, record: Omit<PlayRecord, "save_time">): Promise<{ success: boolean }> {
    const response = await this._fetch("/api/playrecords", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, record }),
    });
    return this.readJsonLimited(response);
  }

  async deletePlayRecord(key?: string): Promise<{ success: boolean }> {
    const url = key ? `/api/playrecords?key=${encodeURIComponent(key)}` : "/api/playrecords";
    const response = await this._fetch(url, { method: "DELETE" });
    return this.readJsonLimited(response);
  }

  async getSearchHistory(): Promise<string[]> {
    const response = await this._fetch("/api/searchhistory");
    return this.readJsonLimited(response);
  }

  async addSearchHistory(keyword: string): Promise<string[]> {
    const response = await this._fetch("/api/searchhistory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword }),
    });
    return this.readJsonLimited(response);
  }

  async deleteSearchHistory(keyword?: string): Promise<{ success: boolean }> {
    const url = keyword ? `/api/searchhistory?keyword=${encodeURIComponent(keyword)}` : "/api/searchhistory";
    const response = await this._fetch(url, { method: "DELETE" });
    return this.readJsonLimited(response);
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
    return this.readJsonLimited(response);
  }

  async searchVideos(query: string): Promise<{ results: SearchResult[] }> {
    const url = `/api/search?q=${encodeURIComponent(query)}`;
    const response = await this._fetch(url);
    return this.readJsonLimited(response);
  }

  async searchVideo(query: string, resourceId: string, signal?: AbortSignal): Promise<{ results: SearchResult[] }> {
    const url = `/api/search/one?q=${encodeURIComponent(query)}&resourceId=${encodeURIComponent(resourceId)}`;
    const response = await this._fetch(url, { signal });
    const { results } = await this.readJsonLimited(response);
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
    return this.readJsonLimited(response);
  }

  async getVideoDetail(source: string, id: string): Promise<VideoDetail> {
    const url = `/api/detail?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`;
    const response = await this._fetch(url);
    return this.readJsonLimited(response);
  }
}

// 默认实例
export let api = new API();
