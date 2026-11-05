import AsyncStorage from "@react-native-async-storage/async-storage";
import { M3uCacheManager } from "../storage";
import { utf8ByteLength } from "../../utils/utf8ByteLength";

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  getAllKeys: jest.fn(async () => []),
  multiRemove: jest.fn(async () => undefined),
}));

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

// 与 services/storage.ts 的 MAX_M3U_CACHE_BYTES 一致：3MB
const MAX_M3U_CACHE_BYTES = 3 * 1024 * 1024;

const getItem = AsyncStorage.getItem as jest.Mock;
const setItem = AsyncStorage.setItem as jest.Mock;

const KEY = "mytv_m3u_cache_https://example.test/list.m3u";

/** 中文台名为主的频道：与真实直播列表同形态（中文名/分组 + ASCII 地址） */
function chineseChannels(count: number) {
  const groups = ["央视频道", "卫视频道", "地方频道"];
  return Array.from({ length: count }, (_, i) => ({
    id: `http://example.test/live/${i}.m3u8`,
    url: `http://example.test/live/${i}.m3u8`,
    name: `中央电视台综合频道高清${i}号测试频道`,
    logo: `http://example.test/logo/${i}.png`,
    group: groups[i % groups.length],
  }));
}

describe("M3uCacheManager 体积守卫（深查第 3 轮：OTV-3 同类残余）", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("① save：中文列表 UTF-16 长度未超限、UTF-8 字节已超限，应跳过落盘（旧实现会写入）", async () => {
    const channels = chineseChannels(16_000);
    const json = JSON.stringify({ ts: Date.now(), channels });
    // 前提锁定：同一 JSON 按 UTF-16 码元数未超限、按 UTF-8 字节已超限
    expect(json.length).toBeLessThan(MAX_M3U_CACHE_BYTES);
    expect(utf8ByteLength(json)).toBeGreaterThan(MAX_M3U_CACHE_BYTES);

    await M3uCacheManager.save("https://example.test/list.m3u", channels);

    expect(setItem).not.toHaveBeenCalled();
  });

  it("② save：未超限的小中文列表正常落盘", async () => {
    const channels = chineseChannels(100);
    expect(utf8ByteLength(JSON.stringify({ ts: 0, channels }))).toBeLessThan(
      MAX_M3U_CACHE_BYTES,
    );

    await M3uCacheManager.save("https://example.test/list.m3u", channels);

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem).toHaveBeenCalledWith(KEY, expect.any(String));
    const written = JSON.parse((setItem as jest.Mock).mock.calls[0][1]);
    expect(written.channels).toHaveLength(100);
  });

  it("③ get：已落盘的超限中文缓存（旧版按长度放行写入的）应视为未命中", async () => {
    const channels = chineseChannels(16_000);
    const stored = JSON.stringify({ ts: Date.now(), channels });
    expect(stored.length).toBeLessThan(MAX_M3U_CACHE_BYTES);
    expect(utf8ByteLength(stored)).toBeGreaterThan(MAX_M3U_CACHE_BYTES);
    getItem.mockResolvedValue(stored);

    await expect(
      M3uCacheManager.get("https://example.test/list.m3u"),
    ).resolves.toBeNull();
  });

  it("④ get：未超限的有效缓存正常返回解析后的条目", async () => {
    const channels = chineseChannels(100);
    getItem.mockResolvedValue(JSON.stringify({ ts: Date.now(), channels }));

    const entry = await M3uCacheManager.get("https://example.test/list.m3u");

    expect(entry).not.toBeNull();
    expect(entry!.channels).toHaveLength(100);
    expect(entry!.channels[0].name).toContain("中央电视台");
  });

  it("⑤ 回归：纯 ASCII 文本刚过 3MB 仍拒绝（新旧实现一致）", async () => {
    const ascii = "a".repeat(MAX_M3U_CACHE_BYTES + 1);
    const channels = [{ id: ascii, url: ascii, name: "x", logo: "", group: "g" }];
    const json = JSON.stringify({ ts: Date.now(), channels });
    expect(json.length).toBeGreaterThan(MAX_M3U_CACHE_BYTES);

    await M3uCacheManager.save("https://example.test/list.m3u", channels);

    expect(setItem).not.toHaveBeenCalled();
    expect(utf8ByteLength(json)).toBe(json.length);
  });
});
