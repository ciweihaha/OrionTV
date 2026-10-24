import { createHash } from "crypto";
import updateService from "../updateService";

/**
 * sha256OfFile 标准向量测试：
 * 自写 SHA256 曾因 base64 填充未扣 + 最终块长度字段位置错误而算错
 * （仅空输入碰巧匹配）。这里用 node crypto 作参考实现逐一对比。
 */

const mockFiles = new Map<string, Uint8Array>();

jest.mock("expo-file-system", () => ({
  documentDirectory: "file:///docs/",
  EncodingType: { Base64: "base64", UTF8: "utf8" },
  getInfoAsync: jest.fn(async (uri: string) => {
    const data = mockFiles.get(uri);
    return data ? { exists: true, size: data.length } : { exists: false };
  }),
  readAsStringAsync: jest.fn(async (uri: string, opts: any) => {
    const data = mockFiles.get(uri);
    if (!data) throw new Error(`mock file not found: ${uri}`);
    const start = opts?.position ?? 0;
    const len = opts?.length ?? data.length - start;
    return Buffer.from(data.subarray(start, start + len)).toString("base64");
  }),
  readDirectoryAsync: jest.fn(async () => []),
  deleteAsync: jest.fn(async () => undefined),
  getContentUriAsync: jest.fn(async (uri: string) => uri),
  createDownloadResumable: jest.fn(),
}));

jest.mock("expo-intent-launcher", () => ({
  startActivityAsync: jest.fn(async () => undefined),
}));

jest.mock("react-native-toast-message", () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

jest.mock("react-native", () => ({
  Platform: { OS: "android" },
}));

jest.mock(
  "@/utils/Logger",
  () => ({
    __esModule: true,
    default: {
      withTag: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    },
  }),
  { virtual: true }
);

function patternBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    b[i] = (i * 31 + 7) % 256;
  }
  return b;
}

function pseudoRandomBytes(n: number, seed: number): Uint8Array {
  let s = seed >>> 0;
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    b[i] = s % 256;
  }
  return b;
}

function referenceSha256(data: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(data)).digest("hex");
}

describe("UpdateService.sha256OfFile 标准向量", () => {
  const cases: Array<[string, Uint8Array]> = [
    ["空输入", new Uint8Array(0)],
    ["abc", new TextEncoder().encode("abc")],
    ["55 字节（单块填充边界内）", patternBytes(55)],
    ["56 字节（填充溢出成两块）", patternBytes(56)],
    ["64 字节（整块）", patternBytes(64)],
    ["1MB（分块读取整边界）", pseudoRandomBytes(1024 * 1024, 42)],
    ["2MB+55（多块 + 尾块 55）", pseudoRandomBytes(2 * 1024 * 1024 + 55, 1337)],
  ];

  it.each(cases)("%s：与参考实现一致", async (_name, data) => {
    const uri = `file:///docs/vector-${data.length}-${_name.length}.bin`;
    mockFiles.set(uri, data);
    const actual = await (updateService as any).sha256OfFile(uri);
    expect(actual).toBe(referenceSha256(data));
    mockFiles.delete(uri);
  });

  it("已知答案：abc 的 SHA256 等于公开标准值", async () => {
    const uri = "file:///docs/vector-abc.bin";
    mockFiles.set(uri, new TextEncoder().encode("abc"));
    const actual = await (updateService as any).sha256OfFile(uri);
    expect(actual).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    mockFiles.delete(uri);
  });

  it("已知答案：空输入的 SHA256 等于公开标准值", async () => {
    const uri = "file:///docs/vector-empty.bin";
    mockFiles.set(uri, new Uint8Array(0));
    const actual = await (updateService as any).sha256OfFile(uri);
    expect(actual).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    mockFiles.delete(uri);
  });
});
