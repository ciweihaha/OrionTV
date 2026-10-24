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

  it("④ 多字节超限按字节拦：码元未超限、字节超限（150 万中文 ≈ 450 万字节）", async () => {
    const body = JSON.stringify({ v: "中".repeat(1500000) });
    expect(body.length).toBeLessThan(LIMIT); // 旧码的 text.length 检查会放行
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

  it("⑦ 流式分支正常体通过，超大体被拦且 cancel 被调", async () => {
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
});
