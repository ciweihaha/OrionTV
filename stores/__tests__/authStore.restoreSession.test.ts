import useAuthStore from "../authStore";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { api } from "@/services/api";
import { LoginCredentialsManager } from "@/services/storage";

jest.mock("@/services/api", () => ({
  api: {
    logout: jest.fn(),
    login: jest.fn(),
    setSessionRestorer: jest.fn(),
  },
}));

jest.mock("@/services/storage", () => ({
  LoginCredentialsManager: {
    get: jest.fn(async () => null),
    clear: jest.fn(async () => undefined),
  },
}));

jest.mock("../settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      serverConfig: null,
      isLoadingServerConfig: false,
      fetchServerConfig: jest.fn(async () => undefined),
    }),
  },
  getServerConfigPromise: jest.fn(() => null),
}));

jest.mock("react-native-toast-message", () => ({
  __esModule: true,
  default: { show: jest.fn() },
}), { virtual: true });

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
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

const apiLoginMock = api.login as jest.Mock;
const credsGetMock = LoginCredentialsManager.get as jest.Mock;
const asyncRemoveMock = AsyncStorage.removeItem as jest.Mock;

describe("authStore.restoreSession（401 自动恢复的登录端）", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({ isLoggedIn: false, isLoginModalVisible: false });
  });

  it("无保存凭据：不调登录接口，直接弹登录框", async () => {
    credsGetMock.mockResolvedValue(null);

    await useAuthStore.getState().restoreSession();

    expect(apiLoginMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(true);
  });

  it("有凭据且自动登录成功：用保存的用户名/密码登录，状态为已登录且不弹框", async () => {
    credsGetMock.mockResolvedValue({ username: "u", password: "p" });
    apiLoginMock.mockResolvedValue({ ok: true });

    await useAuthStore.getState().restoreSession();

    expect(apiLoginMock).toHaveBeenCalledWith("u", "p");
    expect(apiLoginMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(false);
  });

  it("自动登录返回非 ok：视为失败，清除会话标记并弹登录框", async () => {
    credsGetMock.mockResolvedValue({ username: "u", password: "p" });
    apiLoginMock.mockResolvedValue({ ok: false });

    await useAuthStore.getState().restoreSession();

    expect(asyncRemoveMock).toHaveBeenCalledWith("authCookies");
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(true);
  });

  it("自动登录抛错：不向外抛，清除会话标记并弹登录框（401 链路不因恢复失败而二次炸开）", async () => {
    credsGetMock.mockResolvedValue({ username: "u", password: "p" });
    apiLoginMock.mockRejectedValue(new Error("Network request failed"));

    await expect(useAuthStore.getState().restoreSession()).resolves.toBeUndefined();

    expect(asyncRemoveMock).toHaveBeenCalledWith("authCookies");
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(true);
  });

  it("并发去重：两次同时触发只登录一次（多个 401 并发时不重复重登）", async () => {
    credsGetMock.mockResolvedValue({ username: "u", password: "p" });
    let release!: () => void;
    apiLoginMock.mockImplementation(
      () =>
        new Promise((res) => {
          release = () => res({ ok: true });
        })
    );

    const p1 = useAuthStore.getState().restoreSession();
    const p2 = useAuthStore.getState().restoreSession();
    // restoreSession 先 await 取凭据，登录是异步触发的：必须先放空任务队列，
    // 等登录 mock 真被调用（release 已赋值）再放行，否则 release 还是 undefined
    //（此前 CI 失败就是在这里直接调 release 抛 TypeError）。
    for (let i = 0; i < 50 && apiLoginMock.mock.calls.length === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(apiLoginMock).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([p1, p2]);

    expect(apiLoginMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isLoggedIn).toBe(true);
  });
});
