import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LoginCredentialsManager } from "../storage";

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

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

const getItemAsync = SecureStore.getItemAsync as jest.Mock;
const setItemAsync = SecureStore.setItemAsync as jest.Mock;
const deleteItemAsync = SecureStore.deleteItemAsync as jest.Mock;
const removeItem = AsyncStorage.removeItem as jest.Mock;
const setItem = AsyncStorage.setItem as jest.Mock;

const KEY = "mytv_login_credentials";

describe("LoginCredentialsManager（SecureStore 凭据层）", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("get：SecureStore 有值时返回解析后的凭据", async () => {
    getItemAsync.mockResolvedValue(JSON.stringify({ username: "u", password: "p" }));
    await expect(LoginCredentialsManager.get()).resolves.toEqual({ username: "u", password: "p" });
    expect(getItemAsync).toHaveBeenCalledWith(KEY);
  });

  it("get：SecureStore 为空时返回 null，不抛错", async () => {
    getItemAsync.mockResolvedValue(null);
    await expect(LoginCredentialsManager.get()).resolves.toBeNull();
  });

  it("get：SecureStore 抛错时吞错返回 null（调用方按无凭据处理）", async () => {
    getItemAsync.mockRejectedValue(new Error("SecureStore unavailable"));
    await expect(LoginCredentialsManager.get()).resolves.toBeNull();
  });

  it("save：写 SecureStore 并清理 AsyncStorage 里的旧版明文残留", async () => {
    await LoginCredentialsManager.save({ username: "u", password: "p" });
    expect(setItemAsync).toHaveBeenCalledWith(KEY, JSON.stringify({ username: "u", password: "p" }));
    expect(removeItem).toHaveBeenCalledWith(KEY);
    expect(setItem).not.toHaveBeenCalled();
  });

  it("clear：删 SecureStore 并删 AsyncStorage 明文残留（退出后不自动重登的关键）", async () => {
    await LoginCredentialsManager.clear();
    expect(deleteItemAsync).toHaveBeenCalledWith(KEY);
    expect(removeItem).toHaveBeenCalledWith(KEY);
  });

  it("clear：SecureStore 抛错时不向外抛（logout 的本地退出不被凭据清除失败阻断）", async () => {
    deleteItemAsync.mockRejectedValue(new Error("SecureStore unavailable"));
    await expect(LoginCredentialsManager.clear()).resolves.toBeUndefined();
  });
});
