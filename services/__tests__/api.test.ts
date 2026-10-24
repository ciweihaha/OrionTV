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
    await expect(promise).rejects.toThrow(/^REQUEST_TIMEOUT/);
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

    await expect(promise).rejects.toThrow(/^REQUEST_TIMEOUT/);
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
    await expect(promise).rejects.toThrow(/^REQUEST_TIMEOUT/);
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
    await expect(promise).rejects.toThrow(/^REQUEST_TIMEOUT/);
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
