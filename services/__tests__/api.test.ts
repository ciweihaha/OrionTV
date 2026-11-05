import { API } from "../api";

jest.mock("@react-native-async-storage/async-storage", () => ({
  setItem: jest.fn(async () => undefined),
  getItem: jest.fn(async () => null),
}));

const BASE = "https://example.test";

function makeResponse(status: number, body: any = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    body: undefined,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function abortError() {
  const err = new Error("The user aborted a request.");
  err.name = "AbortError";
  return err;
}

/** fetch 替身：挂起不返回，直到传入的 signal 中止才以 AbortError 拒绝（模拟真实 fetch 的取消行为） */
function pendingUntilAbort(_url: any, opts: any) {
  return new Promise((_resolve, reject) => {
    const signal: AbortSignal | undefined = opts?.signal;
    if (!signal) return; // 无 signal 时永不返回
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(2);
  }
}

describe("API._fetch 取消与 401 重试语义", () => {
  let fetchMock: jest.Mock;
  let api: API;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    api = new API(BASE);
  });

  afterEach(() => {
    api.setSessionRestorer(null);
    jest.clearAllMocks();
  });

  it("① 首次请求阶段取消：请求以中止语义结束，且绝不重试", async () => {
    const restorer = jest.fn(async () => true);
    api.setSessionRestorer(restorer);
    fetchMock.mockImplementation(pendingUntilAbort);

    const caller = new AbortController();
    const promise = (api as any)._fetch("/api/search?q=x", { signal: caller.signal }, 5000);
    await waitFor(() => fetchMock.mock.calls.length === 1);

    caller.abort();
    await expect(promise).rejects.toThrow("The user aborted a request.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(restorer).not.toHaveBeenCalled();
  });

  it("② 会话恢复等待期间取消：恢复成功也不再发起重试", async () => {
    let resolveRestorer: ((v: boolean) => void) | undefined;
    const restorer = jest.fn(
      () =>
        new Promise<boolean>((res) => {
          resolveRestorer = res;
        })
    );
    api.setSessionRestorer(restorer);
    fetchMock.mockResolvedValue(makeResponse(401));

    const caller = new AbortController();
    const promise = (api as any)._fetch("/api/search?q=x", { signal: caller.signal }, 5000);
    await waitFor(() => restorer.mock.calls.length === 1);

    // 恢复尚在等待时用户取消，随后恢复返回成功
    caller.abort();
    resolveRestorer!(true);

    await expect(promise).rejects.toThrow("The user aborted a request.");
    // 关键断言：取消后绝无第二次 fetch 发出
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("③ 重试阶段取消（复用首次 signal）：在途重试被立即中止，且无第三次请求", async () => {
    api.setSessionRestorer(jest.fn(async () => true));
    fetchMock.mockResolvedValueOnce(makeResponse(401)).mockImplementationOnce(pendingUntilAbort);

    const caller = new AbortController();
    const promise = (api as any)._fetch("/api/search?q=x", { signal: caller.signal }, 5000);
    await waitFor(() => fetchMock.mock.calls.length === 2);

    caller.abort();
    await expect(promise).rejects.toThrow("The user aborted a request.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retrySignal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    expect(retrySignal.aborted).toBe(true);
  });

  it("③b 重试阶段取消（超时后换新 signal）：新信号同样受调用方取消联动", async () => {
    // 恢复等待 60ms > 超时 30ms，重试必然走"换新组合 signal"分支
    api.setSessionRestorer(
      jest.fn(async () => {
        await sleep(60);
        return true;
      })
    );
    fetchMock.mockResolvedValueOnce(makeResponse(401)).mockImplementationOnce(pendingUntilAbort);

    const caller = new AbortController();
    const promise = (api as any)._fetch("/api/search?q=x", { signal: caller.signal }, 30);
    await waitFor(() => fetchMock.mock.calls.length === 2);

    const firstSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    const retrySignal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    expect(retrySignal).not.toBe(firstSignal);
    expect(firstSignal.aborted).toBe(true); // 因超时中止
    expect(retrySignal.aborted).toBe(false);

    caller.abort();
    await expect(promise).rejects.toThrow("The user aborted a request.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retrySignal.aborted).toBe(true); // 调用方取消联动到了新信号
  });

  it("④ 超时（非取消）后 401 恢复重试仍可成功，防把正常重试修死", async () => {
    // 恢复等待 60ms > 超时 30ms：首次 signal 被超时中止，但调用方从未取消
    api.setSessionRestorer(
      jest.fn(async () => {
        await sleep(60);
        return true;
      })
    );
    fetchMock
      .mockResolvedValueOnce(makeResponse(401))
      .mockResolvedValueOnce(makeResponse(200, { ok: true }));

    const caller = new AbortController();
    const response = await (api as any)._fetch("/api/search?q=x", { signal: caller.signal }, 30);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    const retrySignal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true); // 超时导致
    expect(retrySignal).not.toBe(firstSignal); // 重试换了新信号
    expect(retrySignal.aborted).toBe(false);
    expect(caller.signal.aborted).toBe(false);
  });

  it("④b 401 且恢复失败：抛 UNAUTHORIZED，不重试", async () => {
    api.setSessionRestorer(jest.fn(async () => false));
    fetchMock.mockResolvedValue(makeResponse(401));

    await expect((api as any)._fetch("/api/search?q=x", {}, 5000)).rejects.toThrow("UNAUTHORIZED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("④c OTV-4 超时（无调用方取消）仍走 REQUEST_TIMEOUT", async () => {
    // pendingUntilAbort 监听 _fetch 组合的超时信号：超时中止后 fetch 以 AbortError
    // 拒绝，调用方未取消时 _fetch 将其转为 REQUEST_TIMEOUT，与调用方取消区分。
    fetchMock.mockImplementation(pendingUntilAbort);
    const promise = (api as any)._fetch("/api/search?q=x", {}, 30);
    await expect(promise).rejects.toThrow(/^REQUEST_TIMEOUT/);
  });
});

describe("API URL 参数编码", () => {
  let fetchMock: jest.Mock;
  let api: API;

  beforeEach(() => {
    fetchMock = jest.fn(async () => makeResponse(200, { success: true }));
    (global as any).fetch = fetchMock;
    api = new API(BASE);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("⑤ deleteSearchHistory 对含 &、#、空格、中文的 keyword 正确编码", async () => {
    const keyword = "a&b#c 中文 x";
    await api.deleteSearchHistory(keyword);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE}/api/searchhistory?keyword=${encodeURIComponent(keyword)}`
    );
    // 裸拼会把 & 变成第二个参数、# 变成片段，这里确保两者都已被转义
    expect(fetchMock.mock.calls[0][0]).toContain("keyword=a%26b%23c%20");
  });

  it("⑤ getVideoDetail 对含 &、#、空格、中文的 source/id 正确编码", async () => {
    const source = "src&1";
    const id = "id #2 中文";
    await api.getVideoDetail(source, id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE}/api/detail?source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}`
    );
    expect(fetchMock.mock.calls[0][0]).toContain("source=src%261");
    expect(fetchMock.mock.calls[0][0]).toContain("id=id%20%232%20");
  });
});

describe("点播提速第 2 轮：搜索/资源缓存与 agg 总预算", () => {
  let fetchMock: jest.Mock;
  let api: API;

  const searchBody = {
    results: [
      { id: 1, title: "测试影片", poster: "", episodes: ["https://example.test/1.m3u8"], source: "s1", source_name: "源一", year: "2024" },
    ],
  };
  const resourcesBody = [
    { key: "s1", api: "https://a.test", name: "源一" },
    { key: "s2", api: "https://b.test", name: "源二" },
  ];

  beforeEach(() => {
    fetchMock = jest.fn(async () => makeResponse(200, searchBody));
    (global as any).fetch = fetchMock;
    api = new API(BASE);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("⑥ searchVideos：同一片名 2 分钟内只发 1 次请求（大小写/空白归一化）", async () => {
    const first = await api.searchVideos("测试影片");
    const second = await api.searchVideos("  测试影片 ");
    expect(first.results).toEqual(searchBody.results);
    expect(second.results).toEqual(searchBody.results);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("⑦ searchVideos：并发同 key 去重为同一在途请求", async () => {
    fetchMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(makeResponse(200, searchBody)), 50)),
    );
    const [a, b] = await Promise.all([api.searchVideos("测试影片"), api.searchVideos("测试影片")]);
    expect(a.results).toEqual(searchBody.results);
    expect(b.results).toEqual(searchBody.results);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("⑧ searchVideos：失败不缓存，下一次重新请求", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    await expect(api.searchVideos("测试影片")).rejects.toThrow("boom");
    const retry = await api.searchVideos("测试影片");
    expect(retry.results).toEqual(searchBody.results);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("⑨ searchVideo：同源同片名只发 1 次，不同源各发 1 次", async () => {
    fetchMock.mockImplementation(async () => makeResponse(200, searchBody));
    await api.searchVideo("测试影片", "s1");
    await api.searchVideo("测试影片", "s1");
    await api.searchVideo("测试影片", "s2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("resourceId=s2");
  });

  it("⑩ getResources：10 分钟内只发 1 次请求", async () => {
    fetchMock.mockImplementation(async () => makeResponse(200, resourcesBody));
    const first = await api.getResources();
    const second = await api.getResources();
    expect(first).toEqual(resourcesBody);
    expect(second).toEqual(resourcesBody);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // 兼容 jest 27（advanceTimersByTimeAsync 自 jest 28 才有）：手动步进假时钟，
  // 每步交出微任务，让 promise 链（abort → catch → 退避 setTimeout）推进。
  async function pumpTimers(totalMs: number, stepMs = 100): Promise<void> {
    for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
      jest.advanceTimersByTime(stepMs);
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  it("⑪ getAggCategory：每次尝试都挂起超时，总预算 30s 内只开 2 次尝试即停", async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(pendingUntilAbort);
    const { EMPTY_AGG_FILTERS } = require("../api");
    const promise = api.getAggCategory(1, 1, EMPTY_AGG_FILTERS);
    const settled = promise.then(
      () => "resolved",
      (e: any) => e,
    );
    await pumpTimers(40000);
    jest.useRealTimers();
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    // 第 1 次 15s 超时 + 1s 退避 + 第 2 次 14s 超时 = 30s 预算耗尽，不再开第 3 次
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("⑫ getAggCategory：立即失败仍可重试满 3 次", async () => {
    jest.useFakeTimers();
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    const { EMPTY_AGG_FILTERS } = require("../api");
    const promise = api.getAggCategory(1, 1, EMPTY_AGG_FILTERS);
    const settled = promise.then(
      () => "resolved",
      (e: any) => e,
    );
    await pumpTimers(5000);
    jest.useRealTimers();
    const err = await settled;
    expect(err).toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
