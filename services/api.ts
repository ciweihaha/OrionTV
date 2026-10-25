import AsyncStorage from "@react-native-async-storage/async-storage";
import { utf8ByteLength } from "../utils/utf8ByteLength";

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

  // OTV-1 体超时熔断：同一类请求（breakerKey）连续 3 次体超时后，60 秒内不再发起同类请求。
  // 常量与窗口同时写在代码注释与 PR 描述中。熔断只统计体读取超时（RESPONSE_TIMEOUT），
  // 不统计取消、超大体与其它错误；一次成功读取即清零连续计数。bodyTimeoutMs 本次不调小。
  private static readonly BODY_TIMEOUT_BREAKER_THRESHOLD = 3;
  private static readonly BODY_TIMEOUT_BREAKER_WINDOW_MS = 60_000;
  private bodyTimeoutBreaker = new Map<string, { consecutive: number; blockedUntil: number }>();

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

  private isBodyTimeoutBreakerOpen(key: string): boolean {
    const state = this.bodyTimeoutBreaker.get(key);
    return !!state && Date.now() < state.blockedUntil;
  }

  private recordBodyTimeout(key: string): void {
    const now = Date.now();
    const prev = this.bodyTimeoutBreaker.get(key);
    let consecutive = prev?.consecutive ?? 0;
    if (prev && prev.blockedUntil !== 0 && now >= prev.blockedUntil) {
      consecutive = 0;
    }
    consecutive += 1;
    if (consecutive >= API.BODY_TIMEOUT_BREAKER_THRESHOLD) {
      this.bodyTimeoutBreaker.set(key, {
        consecutive: 0,
        blockedUntil: now + API.BODY_TIMEOUT_BREAKER_WINDOW_MS,
      });
    } else {
      this.bodyTimeoutBreaker.set(key, { consecutive, blockedUntil: prev?.blockedUntil ?? 0 });
    }
  }

  private resetBodyTimeout(key: string): void {
    this.bodyTimeoutBreaker.delete(key);
  }

  /**
   * 带体积上限的 JSON 读取：流式累加响应体，超限抛错（防超大响应占满内存），
   * 然后 JSON.parse。做法与 services/m3u.ts 的 readTextWithLimit 一致。
   * 体积一律按 UTF-8 字节算（text.length 是 UTF-16 码元数，对多字节文本
   * 会低估，中文约 3 倍）；体读取另设独立超时（默认 15s，与 _fetch 默认
   * 超时一致），因为 _fetch 的定时器在拿到响应头后即清掉，体读取阶段
   * 原本无超时保护。RN 真机上响应通常没有 body.getReader，无流分支
   * 是主路径：该分支的 text() 无法中途取消，超时时调用方立即拿到
   * 超时错误（底层 text() 继续跑完，不再无限挂起调用方）。
   *
   * OTV-1 已知限制（退守方案，本次不做 XHR 适配）：
   * (a) 无流分支（RN 真机主路径）超时后，调用方虽立即拿到 RESPONSE_TIMEOUT，
   *     但底层 text() 读取并未停止，仍在后台继续缓冲；超大体先完整缓冲再判超限。
   * (b) XHR 适配方案 deferred：没有 RN 真机可验证 XHR 适配层，擅自替换无流分支的
   *     response.text() 有破坏搜索的风险，需真机验证后另行实施；真机复现
   *     （Mock 服务端滴流大体＋超时＋取消三场景）标为待真机验收。
   * (c) 本次只做退守：保留 Content-Length early reject 与 utf8ByteLength 事后字节校验
   *     不动；不只把 bodyTimeoutMs 调小（调用方体验变差，悬空读取问题仍在）；
   *     并在调用方加连续超时熔断：同一类请求连续 3 次体超时后，60 秒内不再发起
   *     同类请求（见 BODY_TIMEOUT_BREAKER_THRESHOLD / BODY_TIMEOUT_BREAKER_WINDOW_MS）。
   *
   * OTV-2 signal：可选 signal 参数。流式分支监听 abort → reader.cancel()，取消后
   * 抛 AbortError 语义错误，与体超时（RESPONSE_TIMEOUT）严格区分。无流分支在 RN 下
   * 仍无法取消：调用方取消不会中断正在进行的 text()，该调用要么等 text() 结算，
   * 要么在体超时（默认 15 秒）内以 RESPONSE_TIMEOUT 结算——这是平台限制，不是本函数的
   * bug；已开始前就已取消的 signal 会立即抛 AbortError，不再发起读取。
   */
  private async readJsonLimited(
    response: Response,
    bodyTimeoutMs: number = API.DEFAULT_TIMEOUT,
    signal?: AbortSignal,
    breakerKey?: string,
  ): Promise<any> {
    if (breakerKey && this.isBodyTimeoutBreakerOpen(breakerKey)) {
      throw new Error(
        `BODY_TIMEOUT_BREAKER_OPEN: ${breakerKey} blocked for ${API.BODY_TIMEOUT_BREAKER_WINDOW_MS}ms after ${API.BODY_TIMEOUT_BREAKER_THRESHOLD} consecutive body timeouts`,
      );
    }
    if (signal?.aborted) {
      const err = new Error("The user aborted a request.");
      err.name = "AbortError";
      throw err;
    }
    // Early reject via Content-Length when the server provides one. The
    // no-reader fallback (response.text()) cannot stream, so its size is
    // only enforced after the body is read; this header check closes the
    // common case before any bytes are buffered. A missing or lying
    // Content-Length still falls through to the post-read byte-length check.
    // Note: this early reject only helps against honest servers.
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > API.MAX_JSON_BYTES) {
      throw new Error(`RESPONSE_TOO_LARGE: body exceeded ${API.MAX_JSON_BYTES} bytes`);
    }
    let activeReader: { cancel: () => Promise<void> } | null = null;
    const readBody = async (): Promise<string> => {
      const reader = response.body?.getReader();
      if (!reader) {
        return response.text();
      }
      activeReader = reader;
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
        return chunks.join("");
      } finally {
        reader.releaseLock();
      }
    };
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    let text: string;
    try {
      text = await Promise.race([
        readBody(),
        new Promise<string>((_, reject) => {
          timeoutId = setTimeout(() => {
            if (activeReader) {
              try {
                const p = activeReader.cancel();
                if (p && typeof (p as unknown as { catch?: unknown }).catch === "function") {
                  (p as unknown as { catch: (fn: () => void) => void }).catch(() => {});
                }
              } catch {
                // reader 已释放等，忽略
              }
            }
            const err = new Error(`RESPONSE_TIMEOUT: body read exceeded ${bodyTimeoutMs}ms`);
            err.name = "TimeoutError";
            reject(err);
          }, bodyTimeoutMs);
        }),
        ...(signal
          ? [
              new Promise<string>((_, reject) => {
                const onAbort = () => {
                  // 流式分支：取消 reader 并以 AbortError 结算。无流分支 activeReader
                  // 为 null，取消无法中断 text()，此处不拒绝，等待体读取完成或体超时结算。
                  if (activeReader) {
                    try {
                      const p = activeReader.cancel();
                      if (p && typeof (p as unknown as { catch?: unknown }).catch === "function") {
                        (p as unknown as { catch: (fn: () => void) => void }).catch(() => {});
                      }
                    } catch {
                      // reader 已释放等，忽略
                    }
                    const err = new Error("The user aborted a request.");
                    err.name = "AbortError";
                    reject(err);
                  }
                };
                removeAbortListener = () => signal.removeEventListener("abort", onAbort);
                signal.addEventListener("abort", onAbort, { once: true });
              }),
            ]
          : []),
      ]);
    } catch (error) {
      if (
        breakerKey &&
        error instanceof Error &&
        (error.message.startsWith("RESPONSE_TIMEOUT") || error.name === "TimeoutError")
      ) {
        this.recordBodyTimeout(breakerKey);
      }
      throw error;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (removeAbortListener) removeAbortListener();
    }
    if (breakerKey) this.resetBodyTimeout(breakerKey);
    if (utf8ByteLength(text) > API.MAX_JSON_BYTES) {
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
      // OTV-4：区分错误来源。调用方已取消（callerSignal?.aborted）时抛 AbortError
      // 语义错误（或直接透传），绝不伪装成超时；仅超时导致的中止才转为 REQUEST_TIMEOUT。
      // 改动前已 grep：生产代码中 REQUEST_TIMEOUT 的字符串消费点只有本文件；
      // stores/detailStore.ts 已按 error.name === "AbortError" 静默取消，OTV-4 后该判断
      // 才能真正生效（此前取消被伪装成普通 Error，无法被静默）；其余调用方按通用错误处理，
      // 无需另改。测试中依赖“取消也走超时分支”的断言已同步改为 AbortError（见 api.test.ts）。
      if (error instanceof Error && error.name === "AbortError") {
        if (callerAborted()) {
          throw abortError();
        }
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
    const result = await this.readJsonLimited(response, API.DEFAULT_TIMEOUT, undefined, "login");
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
    return this.readJsonLimited(response, API.DEFAULT_TIMEOUT, undefined, "logout");
  }

  async getServerConfig(): Promise<ServerConfig> {
    const response = await this._fetch("/api/server-config");
    return this.readJsonLimited(response, API.DEFAULT_TIMEOUT, undefined, "server-config");
  }

  async getFavorites(key?: string): Promise<Record<string, Favorite> | Favorite | null> {
    const url = key ? `/api/favorites?key=${encodeURIComponent(key)}` : "/api/favorites";
    const response = await this._fetch(url);
    return this.readJsonLimited(response, API.DEFAULT_TIMEOUT, undefined, "favorites");
  }

  async addFavorite(key: string, favorite: Omit<Favorite, "save_time">): Promise<{ success: boolean }> {
    const response = await this._fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, favorite }),
    });
    return this.readJsonLimited(response, API.DEFAULT_TIMEOUT, undefined, "favorites");
  }

  async deleteFavorite(key?: string): Promise<{ success: boolean }> {
    const url = key ? `/api/favorites?key=${encodeURIComponent(key)}` : "/api/favorites";
    const response = await this._fetch(url, { method: "DELETE" });
    return this.readJsonLimited(response, API.DEFAULT_TIMEOUT, undefined, "favorites");
  }

  async getPlayRecords(): Promise<Record<string, PlayRecord>> {
    const response = await this._fetch("/api/playrecords");
    return this.readJsonLimited(response, API.DEFAULT_TIMEOUT, undefined, "playrecords");
  }

  async savePlayRecord(key: string, record: Omit<PlayRecord, "save_time">): Promise<{ success: boolean }> {
    const response = await this._fetch("/api/playrecords", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, record }),
    });
    return this.readJsonLimited(response, API.DEFAULT_TIMEOUT, undefined, "playrecords");
  }

  async deletePlayRecord(key?: string): Promise<{ success: boolean }> {
    const url = key ? `/api/playrecords?key=${encodeURIComponent(key)}` : "/api/playrecords";
    const response = await this._fetch(url, { method: "DELETE" });
    return this.readJsonLimited(response, API.DEFAULT_TIMEOUT, undefined, "playrecords");
  }

  async getSearchHistory(): Promise<string[]> {
    const response = await this._fetch("/api/searchhistory");
    return this.readJsonLimited(response, API.DEFAULT_TIMEOUT, undefined, "searchhistory");
  }

  async addSearchHistory(keyword: string): Promise<string[]> {
    const response = await this._fetch("/api/searchhistory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword }),
    });
    return this.readJsonLimited(response, API.DEFAULT_TIMEOUT, undefined, "searchhistory");
  }

  async deleteSearchHistory(keyword?: string): Promise<{ success: boolean }> {
    const url = keyword ? `/api/searchhistory?keyword=${encodeURIComponent(keyword)}` : "/api/searchhistory";
    const response = await this._fetch(url, { method: "DELETE" });
    return this.readJsonLimited(response, API.DEFAULT_TIMEOUT, undefined, "searchhistory");
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
    return this.readJsonLimited(response, API.DEFAULT_TIMEOUT, undefined, "douban");
  }

  async searchVideos(query: string): Promise<{ results: SearchResult[] }> {
    const url = `/api/search?q=${encodeURIComponent(query)}`;
    const response = await this._fetch(url);
    return this.readJsonLimited(response, API.DEFAULT_TIMEOUT, undefined, "search");
  }

  async searchVideo(query: string, resourceId: string, signal?: AbortSignal): Promise<{ results: SearchResult[] }> {
    const url = `/api/search/one?q=${encodeURIComponent(query)}&resourceId=${encodeURIComponent(resourceId)}`;
    const response = await this._fetch(url, { signal });
    const { results } = await this.readJsonLimited(response, API.DEFAULT_TIMEOUT, signal, "search");
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
    return this.readJsonLimited(response, API.DEFAULT_TIMEOUT, signal, "resources");
  }

  async getVideoDetail(source: string, id: string): Promise<VideoDetail> {
    const url = `/api/detail?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`;
    const response = await this._fetch(url);
    return this.readJsonLimited(response, API.DEFAULT_TIMEOUT, undefined, "detail");
  }
}

// 默认实例
export let api = new API();
