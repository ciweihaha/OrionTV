import TCPHttpServer from "../tcpHttpServer";
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

const mockCreateServer = jest.fn();
const mockListen = jest.fn((_options: unknown, cb: () => void) => cb());

jest.mock(
  "react-native-tcp-socket",
  () => ({
    __esModule: true,
    default: {
      createServer: (...args: unknown[]) => mockCreateServer(...args),
    },
  }),
  { virtual: true },
);

jest.mock(
  "@react-native-community/netinfo",
  () => ({
    __esModule: true,
    default: {
      fetch: jest.fn(async () => ({
        type: "wifi",
        details: { ipAddress: "192.168.1.10" },
      })),
    },
  }),
  { virtual: true },
);

// 与 services/tcpHttpServer.ts 的 MAX_REQUEST_BYTES 一致：1MB
const MAX_REQUEST_BYTES = 1024 * 1024;

type SocketStub = {
  handlers: Record<string, Array<(data: unknown) => void>>;
  on: jest.Mock;
  write: jest.Mock;
  end: jest.Mock;
  emitData: (chunk: string | Buffer) => void;
};

function makeSocket(): SocketStub {
  const handlers: Record<string, Array<(data: unknown) => void>> = {};
  const socket: SocketStub = {
    handlers,
    on: jest.fn((event: string, fn: (data: unknown) => void) => {
      (handlers[event] ??= []).push(fn);
    }),
    write: jest.fn(),
    end: jest.fn(),
    emitData: (chunk: string | Buffer) => {
      (handlers.data ?? []).forEach((fn) => fn(chunk));
    },
  };
  return socket;
}

function makeServer() {
  mockCreateServer.mockImplementation((connectionListener: (socket: unknown) => void) => ({
    listen: mockListen,
    on: jest.fn(),
    __connectionListener: connectionListener,
  }));
  return mockCreateServer;
}

/** 把一个连接回调取出来，接上 fake socket，返回 socket 桩 */
function connect(listener: (socket: unknown) => void): SocketStub {
  const socket = makeSocket();
  listener(socket);
  return socket;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function postMessageRequest(body: string): string {
  return (
    "POST /message HTTP/1.1\r\n" +
    "Host: 192.168.1.10\r\n" +
    "Content-Type: application/json\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "\r\n" +
    body
  );
}

describe("TCPHttpServer 请求体 1MB 上限（深查第 5 轮：UTF-16 码元数对照字节上限）", () => {
  let handlerMock: jest.Mock;
  let connectionListener: (socket: unknown) => void;

  beforeEach(async () => {
    jest.clearAllMocks();
    makeServer();
    handlerMock = jest.fn(async () => ({
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ok" }),
    }));
    const server = new TCPHttpServer();
    server.setRequestHandler(handlerMock);
    await server.start();
    connectionListener = mockCreateServer.mock.calls[0][0] as (
      socket: unknown,
    ) => void;
  });

  it("① 中文请求体 UTF-8 超 1MB 但 UTF-16 长度未超限，应断开且不调 handler（旧实现放行）", async () => {
    const body = JSON.stringify({ message: "中".repeat(400_000) });
    const raw = postMessageRequest(body);
    // 前提锁定：同一请求按 UTF-16 码元数未超限、按 UTF-8 字节已超限
    expect(raw.length).toBeLessThan(MAX_REQUEST_BYTES);
    expect(utf8ByteLength(raw)).toBeGreaterThan(MAX_REQUEST_BYTES);

    const socket = connect(connectionListener);
    socket.emitData(Buffer.from(raw, "utf8"));
    await flush();
    await flush();

    expect(socket.end).toHaveBeenCalled();
    expect(handlerMock).not.toHaveBeenCalled();
  });

  it("② 回归：ASCII 请求体刚过 1MB 仍拒绝", async () => {
    const body = "a".repeat(MAX_REQUEST_BYTES);
    const raw = postMessageRequest(body);
    expect(raw.length).toBeGreaterThan(MAX_REQUEST_BYTES);

    const socket = connect(connectionListener);
    socket.emitData(Buffer.from(raw, "utf8"));
    await flush();
    await flush();

    expect(socket.end).toHaveBeenCalled();
    expect(handlerMock).not.toHaveBeenCalled();
  });

  it("③ 回归：未超限的小中文请求正常进 handler，解析出的 body 正确", async () => {
    const body = JSON.stringify({ message: "你好" });
    const raw = postMessageRequest(body);
    expect(utf8ByteLength(raw)).toBeLessThan(MAX_REQUEST_BYTES);

    const socket = connect(connectionListener);
    socket.emitData(Buffer.from(raw, "utf8"));
    await flush();
    await flush();

    expect(handlerMock).toHaveBeenCalledTimes(1);
    const request = handlerMock.mock.calls[0][0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/message");
    expect(JSON.parse(request.body).message).toBe("你好");
    expect(socket.write).toHaveBeenCalledTimes(1);
    expect(socket.write.mock.calls[0][0]).toContain("200 OK");
  });

  it("④ 多 chunk 累计：中文请求头分 100 批到达、未出现空行分隔符，累计超 1MB 字节即断开", async () => {
    // 刻意只发请求头（无 \r\n\r\n 终结空行）：旧实现按码元数累计，1.1MB 字节
    // 的中文头只有约 0.37M 码元，永远到不了上限、连接一直挂着；新实现按字节
    // 累计，半途即断开。此用例同时证明守卫是逐 chunk 累计而非单 chunk 判断。
    const pad = "中".repeat(370_000);
    const raw = "POST /message HTTP/1.1\r\nX-Pad: " + pad + "\r\n";
    const rawBuffer = Buffer.from(raw, "utf8");
    expect(raw.length).toBeLessThan(MAX_REQUEST_BYTES);
    expect(utf8ByteLength(raw)).toBeGreaterThan(MAX_REQUEST_BYTES);

    const socket = connect(connectionListener);
    const chunkSize = Math.ceil(rawBuffer.length / 100);
    for (let i = 0; i < rawBuffer.length; i += chunkSize) {
      socket.emitData(rawBuffer.subarray(i, i + chunkSize));
      await flush();
    }
    await flush();

    expect(socket.end).toHaveBeenCalled();
    expect(handlerMock).not.toHaveBeenCalled();
  });

  it("⑤ 字符串 chunk 同样按字节计：中文体以 string 形态到达，超限仍拒绝", async () => {
    const body = JSON.stringify({ message: "中".repeat(400_000) });
    const raw = postMessageRequest(body);
    expect(raw.length).toBeLessThan(MAX_REQUEST_BYTES);
    expect(utf8ByteLength(raw)).toBeGreaterThan(MAX_REQUEST_BYTES);

    const socket = connect(connectionListener);
    socket.emitData(raw);
    await flush();
    await flush();

    expect(socket.end).toHaveBeenCalled();
    expect(handlerMock).not.toHaveBeenCalled();
  });

  it("⑥ 边界：整请求恰好 1MB 字节放行，再多 1 字节拒绝（守卫是 > 而非 >=）", async () => {
    const header =
      "POST /message HTTP/1.1\r\nHost: 192.168.1.10\r\nContent-Type: application/json\r\n\r\n";
    const headerBytes = Buffer.byteLength(header);
    const bodyBytes = MAX_REQUEST_BYTES - headerBytes;
    const exactBody = "中".repeat(Math.floor(bodyBytes / 3)) + "a".repeat(bodyBytes % 3);
    const exactRaw = header + exactBody;
    expect(Buffer.byteLength(exactRaw)).toBe(MAX_REQUEST_BYTES);
    expect(utf8ByteLength(exactRaw)).toBe(MAX_REQUEST_BYTES);

    const socketA = connect(connectionListener);
    socketA.emitData(Buffer.from(exactRaw, "utf8"));
    await flush();
    await flush();
    expect(handlerMock).toHaveBeenCalledTimes(1);

    const socketB = connect(connectionListener);
    socketB.emitData(Buffer.from(exactRaw + "a", "utf8"));
    await flush();
    await flush();
    expect(socketB.end).toHaveBeenCalled();
    expect(handlerMock).toHaveBeenCalledTimes(1);
  });
});
