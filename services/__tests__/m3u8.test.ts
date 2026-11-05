import { getResolutionFromM3U8 } from "../m3u8";
import { utf8ByteLength } from "../../utils/utf8ByteLength";

jest.mock("@/utils/Logger", () => ({
  __esModule: true,
  default: {
    withTag: () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  },
}));

// 与 services/m3u8.ts 的 MAX_PLAYLIST_BYTES 一致：1MB
const MAX_PLAYLIST_BYTES = 1024 * 1024;

const HEADER =
  "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080\nhttp://example.test/1080p.m3u8\n";

function noReaderResponse(text: string, contentLength: string | null = null) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-length" ? contentLength : null,
    },
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
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-length" ? contentLength : null,
      },
      body: { getReader: () => ({ read, cancel, releaseLock }) },
      text: jest.fn(async () => {
        throw new Error("text() should not be called on reader path");
      }),
    } as unknown as Response,
    cancel,
    read,
  };
}

describe("getResolutionFromM3U8 / readTextWithLimit（深查第 2 轮：OTV-3 补漏）", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("① 无流分支：中文播放列表 UTF-8 超 1MB 但 UTF-16 长度未超限，应拒绝（旧实现放行并返回 1080p）", async () => {
    const playlist = HEADER + "中".repeat(400_000);
    // 前提锁定：同一文本按 UTF-16 码元数未超限、按 UTF-8 字节已超限
    expect(playlist.length).toBeLessThan(MAX_PLAYLIST_BYTES);
    expect(utf8ByteLength(playlist)).toBeGreaterThan(MAX_PLAYLIST_BYTES);
    fetchMock.mockResolvedValue(noReaderResponse(playlist));

    const result = await getResolutionFromM3U8("https://example.test/cjk-over.m3u8");

    expect(result).toBeNull();
  });

  it("② 对照：未超限的小中文播放列表正常返回分辨率", async () => {
    const playlist = HEADER + "中".repeat(1_000);
    expect(utf8ByteLength(playlist)).toBeLessThan(MAX_PLAYLIST_BYTES);
    fetchMock.mockResolvedValue(noReaderResponse(playlist));

    const result = await getResolutionFromM3U8("https://example.test/cjk-small.m3u8");

    expect(result).toBe("1080p");
  });

  it("③ Content-Length 预检：声明 2MB 时直接拒绝，不读体", async () => {
    const playlist = HEADER + "中".repeat(1_000);
    const response = noReaderResponse(playlist, String(2 * 1024 * 1024));
    fetchMock.mockResolvedValue(response);

    const result = await getResolutionFromM3U8("https://example.test/declared-big.m3u8");

    expect(result).toBeNull();
    expect(response.text).not.toHaveBeenCalled();
  });

  it("④ 回归：ASCII 文本刚过 1MB 仍拒绝", async () => {
    const playlist = HEADER + "a".repeat(MAX_PLAYLIST_BYTES);
    expect(playlist.length).toBeGreaterThan(MAX_PLAYLIST_BYTES);
    fetchMock.mockResolvedValue(noReaderResponse(playlist));

    const result = await getResolutionFromM3U8("https://example.test/ascii-over.m3u8");

    expect(result).toBeNull();
  });

  it("⑤ 回归：流分支按字节累计超限仍拒绝并取消读取", async () => {
    const encoder = new TextEncoder();
    const { response, cancel } = readerResponse([
      encoder.encode(HEADER + "a".repeat(600_000)),
      encoder.encode("a".repeat(600_000)),
    ]);
    fetchMock.mockResolvedValue(response);

    const result = await getResolutionFromM3U8("https://example.test/stream-over.m3u8");

    expect(result).toBeNull();
    expect(cancel).toHaveBeenCalled();
  });
});
