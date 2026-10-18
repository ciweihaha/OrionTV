import { getCommonResponsiveStyles } from "../ResponsiveStyles";
import { ResponsiveConfig } from "@/hooks/useResponsiveLayout";
import { DeviceUtils } from "../DeviceUtils";

jest.mock("@/hooks/useResponsiveLayout", () => ({
  useResponsiveLayout: jest.fn(),
}));

jest.mock("@/utils/DeviceUtils", () => ({
  DeviceUtils: {
    getMinTouchTargetSize: jest.fn(),
    getOptimalFontSize: jest.fn(),
  },
}));

const mockedDeviceUtils = DeviceUtils as jest.Mocked<typeof DeviceUtils>;

describe("ResponsiveStyles", () => {
  const mockConfig: ResponsiveConfig = {
    deviceType: "mobile",
    spacing: 16,
    safeAreaInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    windowWidth: 375,
    windowHeight: 812,
    isLandscape: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockedDeviceUtils.getMinTouchTargetSize.mockReturnValue(44);
    mockedDeviceUtils.getOptimalFontSize.mockImplementation((size) => size);
  });

  describe("getCommonResponsiveStyles", () => {
    beforeEach(() => {
      mockedDeviceUtils.getOptimalFontSize.mockImplementation((size) => {
        const deviceType = "mobile";
        const scaleFactor = {
          mobile: 1.0,
          tablet: 1.1,
          tv: 1.25,
        }[deviceType];
        return Math.round(size * scaleFactor);
      });
    });

    it("应该为 mobile 设备返回正确的样式", () => {
      const mobileConfig: ResponsiveConfig = {
        ...mockConfig,
        deviceType: "mobile",
        spacing: 16,
      };

      mockedDeviceUtils.getMinTouchTargetSize.mockReturnValue(44);

      const styles = getCommonResponsiveStyles(mobileConfig);

      expect(styles.container).toEqual({
        flex: 1,
        paddingHorizontal: 16,
      });

      expect(styles.safeContainer).toEqual({
        flex: 1,
        paddingHorizontal: 16,
        paddingTop: 20,
      });

      expect(styles.primaryButton).toEqual({
        minHeight: 44,
        paddingHorizontal: 24,
        paddingVertical: 16,
        borderRadius: 8,
        justifyContent: "center",
        alignItems: "center",
      });
    });

    it("应该为 tablet 设备返回正确的样式", () => {
      const tabletConfig: ResponsiveConfig = {
        ...mockConfig,
        deviceType: "tablet",
        spacing: 20,
      };

      mockedDeviceUtils.getMinTouchTargetSize.mockReturnValue(48);

      const styles = getCommonResponsiveStyles(tabletConfig);

      expect(styles.safeContainer.paddingTop).toBe(30);
      expect(styles.primaryButton.borderRadius).toBe(10);
      expect(styles.primaryButton.minHeight).toBe(48);
    });

    it("应该为 tv 设备返回正确的样式", () => {
      const tvConfig: ResponsiveConfig = {
        ...mockConfig,
        deviceType: "tv",
        spacing: 24,
      };

      mockedDeviceUtils.getMinTouchTargetSize.mockReturnValue(60);

      const styles = getCommonResponsiveStyles(tvConfig);

      expect(styles.safeContainer.paddingTop).toBe(40);
      expect(styles.primaryButton.borderRadius).toBe(12);
      expect(styles.primaryButton.minHeight).toBe(60);
    });

    it("应该为 tv 设备不包含阴影样式", () => {
      const tvConfig: ResponsiveConfig = {
        ...mockConfig,
        deviceType: "tv",
        spacing: 24,
      };

      const styles = getCommonResponsiveStyles(tvConfig);

      expect(styles.shadow).toEqual({});
    });

    it("应该为非 tv 设备包含阴影样式", () => {
      const mobileConfig: ResponsiveConfig = {
        ...mockConfig,
        deviceType: "mobile",
        spacing: 16,
      };

      const styles = getCommonResponsiveStyles(mobileConfig);

      expect(styles.shadow).toEqual({
        shadowColor: "#000",
        shadowOffset: {
          width: 0,
          height: 2,
        },
        shadowOpacity: 0.25,
        shadowRadius: 3.84,
        elevation: 5,
      });
    });
  });
});