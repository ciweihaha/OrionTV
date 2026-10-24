import useAuthStore from "../authStore";
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

const apiLogoutMock = api.logout as jest.Mock;
const clearMock = LoginCredentialsManager.clear as jest.Mock;

function abortError() {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

describe("authStore.logout 本地退出与远程登出解耦", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearMock.mockResolvedValue(undefined);
    // 每个用例都从"已登录、登录框关闭"状态出发
    useAuthStore.setState({ isLoggedIn: true, isLoginModalVisible: false });
  });

  it("远程成功：远程调用一次，凭据清除，状态更新为未登录并弹登录框", async () => {
    apiLogoutMock.mockResolvedValue({ ok: true });

    await useAuthStore.getState().logout();

    expect(apiLogoutMock).toHaveBeenCalledTimes(1);
    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(true);
  });

  it("远程网络断开：logout 不向外抛，凭据仍清除，状态仍更新", async () => {
    apiLogoutMock.mockRejectedValue(new Error("Network request failed"));

    await expect(useAuthStore.getState().logout()).resolves.toBeUndefined();

    expect(apiLogoutMock).toHaveBeenCalledTimes(1);
    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(true);
  });

  it("远程超时（AbortError）：凭据仍清除，状态仍更新", async () => {
    apiLogoutMock.mockRejectedValue(abortError());

    await expect(useAuthStore.getState().logout()).resolves.toBeUndefined();

    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(true);
  });

  it("凭据清除本身抛错：状态仍更新，logout 不向外抛", async () => {
    apiLogoutMock.mockResolvedValue({ ok: true });
    clearMock.mockRejectedValue(new Error("SecureStore unavailable"));

    await expect(useAuthStore.getState().logout()).resolves.toBeUndefined();

    expect(clearMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isLoggedIn).toBe(false);
    expect(useAuthStore.getState().isLoginModalVisible).toBe(true);
  });
});
