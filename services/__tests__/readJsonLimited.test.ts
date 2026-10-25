import { API } from "../api";

jest.mock("@react-native-async-storage/async-storage", () => ({
  setItem: jest.fn(async () => undefined),
  getItem: jest.fn(async () => null),
}));

const BASE = "https://example.test";
const LIMIT = 2 * 1024 * 1024;

function noReaderResponse(text: string, contentLength: string | null = null) {
  return {
    headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? contentLength : null) },
    body: undefined,
    text: jest.fn(async () => text),
  } as unknown as Response;
}

function readerResponse(chunks: Uint8Array[], contentLength: string | null = null) {
  let index = 0;
  const cancel = jest.fn(async () => undefined);
  const releaseLock = jest.fn(() => undefined);
  const read = jest.fn(async () => {
    if (index >= chunks.length) return { done: true as const, value: undefined };
    return { done: false as const, value: chunks[index++] };
  });
  return {
    response: {
      headers: { get: (name: string) => (name.toLowerCase() === "content-length" ? contentLength : null) },
      body: { getReader: () => ({ read, cancel, releaseLock }) },
      text: jest.fn(async () => {
        throw new Error("text() should not be called on reader path");
      }),
    } as unknown as Response,
    cancel,
    read,
  };
}

function hangingReaderResponse() {
  const cancel = jest.fn(async () => undefined);
  const releaseLock = jest.fn(() => undefined);
  return {
    response: {
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: () => new Promise(() => {}),
          cancel,
          releaseLock,
        }),
      },
      text: jest.fn(async () => {
        throw new Error("text() should not be called on reader path");
      }),
    } as unknown as Response,
    cancel,
  };
}

describe("API.readJsonLimited 体积与超时保护", () => {
  let api: API;

  beforeEach(() => {
    api = new API(BASE);
  });

  it("① 缺失 Content-Length 的超大体被拦", async () => {
    const big = JSON.stringify({ v: "a".repeat(LIMIT + 1000) });
    await expect((api as any).readJsonLimited(noReaderResponse(big))).rejects.toThrow(/^RESPONSE_TOO_LARGE/);
  });

  it("② 伪造偏小 Content-Length 的超大体被拦", async () => {
    const big = JSON.stringify({ v: "a".repeat(LIMIT + 1000) });
    await expect((api as any).readJsonLimited(noReaderResponse(big, "100"))).rejects.toThrow(
      /^RESPONSE_TOO_LARGE/,
    );
  });

  it("③ 诚实偏大 Content-Length 直接 early reject，且不读体", async () => {
    const resp = noReaderResponse("{}", String(LIMIT + 1));
    await expect((api as any).readJsonLimited(resp)).rejects.toThrow(/^RESPONSE_TOO_LARGE/);
    expect((resp as any).text).not.toHaveBeenCalled();
  });

  it("④ 多字节超限按字节拦：码元未超限，字节超限（150 万中文 ≈ 450 万字节）", async () => {
    const body = JSON.stringify({ v: "中".repeat(1500000) });
    expect(body.length).toBeLessThan(LIMIT); // 旧的 text.length 检验会放行
    await expect((api as any).readJsonLimited(noReaderResponse(body))).rejects.toThrow(
      /^RESPONSE_TOO_LARGE/,
    );
  });

  it("⑤ 多字节未超限正常通过（10 万中文 ≈ 30 万字节）", async () => {
    const body = JSON.stringify({ v: "中".repeat(100000) });
    const result = await (api as any).readJsonLimited(noReaderResponse(body));
    expect(result.v.length).toBe(100000);
  });

  it("⑥ 无 reader 分支正常体通过", async () => {
    const result = await (api as any).readJsonLimited(noReaderResponse(JSON.stringify({ ok: true })));
    expect(result).toEqual({ ok: true });
  });

  it("⑦ 流式分支正常体通过，超大体触发 cancel 被调", async () => {
    const asciiBytes = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
    const ok = readerResponse([asciiBytes(JSON.stringify({ ok: true }))]);
    await expect((api as any).readJsonLimited(ok.response)).resolves.toEqual({ ok: true });

    const bigChunks: Uint8Array[] = [];
    let remaining = LIMIT + 1000;
    while (remaining > 0) {
      const n = Math.min(65536, remaining);
      bigChunks.push(new Uint8Array(n).fill(97));
      remaining -= n;
    }
    const big = readerResponse(bigChunks);
    await expect((api as any).readJsonLimited(big.response)).rejects.toThrow(/^RESPONSE_TOO_LARGE/);
    expect(big.cancel).toHaveBeenCalled();
  });

  it("⑧ 无流挂起体在体读取超时内拒绝，不无限挂起", async () => {
    const resp = {
      headers: { get: () => null },
      body: undefined,
      text: () => new Promise(() => {}),
    } as unknown as Response;
    const start = Date.now();
    await expect((api as any).readJsonLimited(resp, 50)).rejects.toThrow(/^RESPONSE_TIMEOUT/);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("⑨ 流式挂起 read 在体读取超时内拒绝且 cancel 被调", async () => {
    const { response, cancel } = hangingReaderResponse();
    const start = Date.now();
    await expect((api as any).readJsonLimited(response, 50)).rejects.toThrow(/^RESPONSE_TIMEOUT/);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(cancel).toHaveBeenCalled();
  });

  it("⑩ OTV-2 流式分支取消：abort 后以 AbortError 拒绝且 cancel 被调，不是 RESPONSE_TIMEOUT", async () => {
    const { response, cancel } = hangingReaderResponse();
    const controller = new AbortController();
    const promise = (api as any).readJsonLimited(response, 5000, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(promise).rejects.toThrow("The user aborted a request.");
    expect(cancel).toHaveBeenCalled();
  });

  it("⑪ OTV-2 无流分支取消不中断读取：abort 后仍以 RESPONSE_TIMEOUT 在体超时内结算（文档化限制）", async () => {
    // 平台限制：无流分支（RN 真机主路径）无法取消 response.text()，
    // abort 后读取仍继续，直到 text() 结算或体超时；本用例断言它以体超时结算。
    const resp = {
      headers: { get: () => null },
      body: undefined,
      text: () => new Promise(() => {}),
    } as unknown as Response;
    const controller = new AbortController();
    const promise = (api as any).readJsonLimited(resp, 50, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const start = Date.now();
    await expect(promise).rejects.toThrow(/^RESPONSE_TIMEOUT/);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("⑫ OTV-2 无流分支取消后仍可正常返回（文档化限制：取消不中断 text() 读取）", async () => {
    const resp = {
      headers: { get: () => null },
      body: undefined,
      text: () =>
        new Promise<string>((resolve) =>
          setTimeout(() => resolve(JSON.stringify({ ok: true })), 10),
        ),
    } as unknown as Response;
    const controller = new AbortController();
    const promise = (api as any).readJsonLimited(resp, 5000, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it("⑬ OTV-1 熔断：同一 breakerKey 连续 3 次体超时后，第 4 次立即以 BODY_TIMEOUT_BREAKER_OPEN 拒绝", async () => {
    const key = "test-breaker";
    for (let i = 0; i < 3; i++) {
      const { response } = hangingReaderResponse();
      await expect((api as any).readJsonLimited(response, 50, undefined, key)).rejects.toThrow(
        /^RESPONSE_TIMEOUT/,
      );
    }
    const { response } = hangingReaderResponse();
    const start = Date.now();
    await expect((api as any).readJsonLimited(response, 50, undefined, key)).rejects.toThrow(
      /^BODY_TIMEOUT_BREAKER_OPEN/,
    );
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("⑭ OTV-1 成功清零：2 次超时 → 1 次成功 → 再 2 次超时后，下一次仍走体超时而非立即熔断", async () => {
    const key = "test-breaker-reset";
    const asciiBytes = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
    for (let i = 0; i < 2; i++) {
      const { response } = hangingReaderResponse();
      await expect((api as any).readJsonLimited(response, 50, undefined, key)).rejects.toThrow(
        /^RESPONSE_TIMEOUT/,
      );
    }
    const ok = readerResponse([asciiBytes(JSON.stringify({ ok: true }))]);
    await expect((api as any).readJsonLimited(ok.response, 50, undefined, key)).resolves.toEqual({
      ok: true,
    });
    for (let i = 0; i < 2; i++) {
      const { response } = hangingReaderResponse();
      await expect((api as any).readJsonLimited(response, 50, undefined, key)).rejects.toThrow(
        /^RESPONSE_TIMEOUT/,
      );
    }
    const { response } = hangingReaderResponse();
    await expect((api as any).readJsonLimited(response, 50, undefined, key)).rejects.toThrow(
      /^RESPONSE_TIMEOUT/,
    );
  });
});
