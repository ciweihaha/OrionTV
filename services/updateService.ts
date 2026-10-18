// UpdateService.ts
import * as FileSystem from 'expo-file-system';
import * as IntentLauncher from 'expo-intent-launcher';
// import * as Device from 'expo-device';
import Toast from 'react-native-toast-message';
import { version as currentVersion } from '../package.json';
import { UPDATE_CONFIG } from '../constants/UpdateConfig';
import Logger from '@/utils/Logger';
import { Platform } from 'react-native';

const logger = Logger.withTag('UpdateService');

interface VersionInfo {
  version: string;
  downloadUrl: string;
}

/**
 * 只在 Android 平台使用的常量（iOS 不会走到下载/安装流程）
 */
const ANDROID_MIME_TYPE = 'application/vnd.android.package-archive';

/** 版本检查请求超时（毫秒） */
const VERSION_CHECK_TIMEOUT_MS = 10_000;
/** SHA256 文件获取超时（毫秒） */
const SHA256_FETCH_TIMEOUT_MS = 15_000;

class UpdateService {
  private static instance: UpdateService;
  static getInstance(): UpdateService {
    if (!UpdateService.instance) {
      UpdateService.instance = new UpdateService();
    }
    return UpdateService.instance;
  }

  /** --------------------------------------------------------------
   *  1️⃣ 远程版本检查（保持不变，只是把 fetch 包装成 async/await）
   * --------------------------------------------------------------- */
  async checkVersion(): Promise<VersionInfo> {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS);
        const response = await fetch(UPDATE_CONFIG.GITHUB_RAW_URL, {
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const remotePackage = await response.json();
        const remoteVersion = remotePackage.version as string;
        return {
          version: remoteVersion,
          downloadUrl: UPDATE_CONFIG.getDownloadUrl(remoteVersion),
        };
      } catch (e) {
        logger.warn(`checkVersion attempt ${attempt}/${maxRetries}`, e);
        if (attempt === maxRetries) {
          Toast.show({
            type: 'error',
            text1: '检查更新失败',
            text2: '无法获取版本信息，请检查网络',
          });
          throw e;
        }
        // 指数退避
        await new Promise(r => setTimeout(r, 2_000 * attempt));
      }
    }
    // 这句永远走不到，仅为 TypeScript 报错
    throw new Error('Unexpected');
  }

  /** --------------------------------------------------------------
   *  2️⃣ 清理旧的 APK 文件（使用 expo-file-system 的 API）
   * --------------------------------------------------------------- */
  private async cleanOldApkFiles(): Promise<void> {
    try {
      const dirUri = FileSystem.documentDirectory; // e.g. file:///data/user/0/.../files/
      if (!dirUri) {
        throw new Error('Document directory is not available');
      }
      const listing = await FileSystem.readDirectoryAsync(dirUri);
      const apkFiles = listing.filter(name => name.startsWith('OrionTV_v') && name.endsWith('.apk'));

      if (apkFiles.length <= 2) return;

      const sorted = apkFiles.sort((a, b) => {
        const numA = parseInt(a.replace(/[^0-9]/g, ''), 10);
        const numB = parseInt(b.replace(/[^0-9]/g, ''), 10);
        return numB - numA; // 倒序（最新在前）
      });

      const stale = sorted.slice(2); // 保留最新的两个
      for (const file of stale) {
        const path = `${dirUri}${file}`;
        try {
          await FileSystem.deleteAsync(path, { idempotent: true });
          logger.debug(`Deleted old APK: ${file}`);
        } catch (e) {
          logger.warn(`Failed to delete ${file}`, e);
        }
      }
    } catch (e) {
      logger.warn('cleanOldApkFiles error', e);
    }
  }

  /** --------------------------------------------------------------
   *  3️⃣ 下载 APK（使用 expo-file-system 的下载 API）
   *  安全：下载完成后校验 SHA256（从 <url>.sha256 获取期望值）。
   *  发布流程必须在 GitHub Release 中附带 .sha256 文件。
   * --------------------------------------------------------------- */
  async downloadApk(
    url: string,
    onProgress?: (percent: number) => void,
  ): Promise<string> {
    const maxRetries = 3;
    await this.cleanOldApkFiles();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let fileUri: string | null = null;
      try {
        const timestamp = Date.now();
        const fileName = `OrionTV_v${timestamp}.apk`;
        fileUri = `${FileSystem.documentDirectory}${fileName}`;

        // expo-file-system 把下载进度回调参数统一为 `{totalBytesWritten, totalBytesExpectedToWrite}`
        const downloadResumable = FileSystem.createDownloadResumable(
          url,
          fileUri,
          {
            // Android 需要在 AndroidManifest 中声明 INTERNET、WRITE_EXTERNAL_STORAGE (API 33+ 使用 MANAGE_EXTERNAL_STORAGE)
            // 这里不使用系统下载管理器，因为我们想自己控制进度回调。
          },
          progress => {
            if (onProgress && progress.totalBytesExpectedToWrite) {
              const percent = Math.floor(
                (progress.totalBytesWritten / progress.totalBytesExpectedToWrite) * 100,
              );
              onProgress(percent);
            }
          },
        );

        const result = await downloadResumable.downloadAsync();
        if (!result || !result.uri) {
          throw new Error('Download failed: No URI available');
        }

        // SHA256 完整性校验（P0-3：防 CDN 投毒）
        await this.verifyApkSha256(result.uri, url);

        logger.debug(`APK downloaded and verified: ${result.uri}`);
        return result.uri;
      } catch (e) {
        // 校验失败或下载失败时删除残留文件，避免安装被篡改的包
        if (fileUri) {
          try {
            await FileSystem.deleteAsync(fileUri, { idempotent: true });
          } catch { /* ignore */ }
        }
        logger.warn(`downloadApk attempt ${attempt}/${maxRetries}`, e);
        if (attempt === maxRetries) {
          const isShaError = e instanceof Error && e.message.includes('SHA256');
          Toast.show({
            type: 'error',
            text1: isShaError ? '安全校验失败' : '下载失败',
            text2: isShaError
              ? 'APK 完整性校验未通过，已删除该文件，请勿安装'
              : 'APK 下载出现错误，请检查网络',
          });
          throw e;
        }
        // 指数退避
        await new Promise(r => setTimeout(r, 3_000 * attempt));
      }
    }
    // 同上，理论不会到这里
    throw new Error('Download failed');
  }

  /**
   * 校验下载的 APK 的 SHA256。
   * 期望值从 `${downloadUrl}.sha256` 获取（GitHub Release 附件）。
   * - 能获取到期望值：必须完全一致，否则抛错并删除文件
   * - 获取不到期望值：记录警告并放行（兼容未附带 sha256 的旧版本），
   *   建议发布流程始终附带 .sha256 文件
   */
  private async verifyApkSha256(fileUri: string, downloadUrl: string): Promise<void> {
    let expected = "";
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SHA256_FETCH_TIMEOUT_MS);
      const resp = await fetch(`${downloadUrl}.sha256`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (resp.ok) {
        const text = (await resp.text()).trim();
        // 兼容 "hash  filename" 和纯 hash 两种格式
        expected = text.split(/\s+/)[0].toLowerCase();
      }
    } catch (e) {
      logger.warn('Failed to fetch .sha256, skipping strict verification', e);
    }

    if (!expected || !/^[0-9a-f]{64}$/.test(expected)) {
      logger.warn('No valid SHA256 provided for APK, installing without verification. ' +
        '建议在 GitHub Release 中附带 .sha256 文件。');
      Toast.show({
        type: 'info',
        text1: '安全提示',
        text2: '该版本未提供 SHA256 校验文件，请确认来源可信',
      });
      return;
    }

    // 分块读取文件并计算 SHA256（避免一次性加载大文件进内存）
    const actual = await this.sha256OfFile(fileUri);
    logger.debug(`APK SHA256 expected=${expected} actual=${actual}`);
    if (actual !== expected) {
      throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual}`);
    }
  }

  /**
   * 计算文件的 SHA256（纯 JS 实现，真流式分块读取）。
   * 说明：expo-crypto 的 digestStringAsync 只能对字符串做哈希，
   * 对二进制文件内容做 UTF-8 编码后再哈希会得到错误结果，
   * 因此这里用标准 SHA256 算法直接处理字节数组。
   * 实现为增量式：每次读取 1MB base64 块，解码后送入哈希状态，
   * 峰值内存与文件大小无关。
   */
  private async sha256OfFile(fileUri: string): Promise<string> {
    const CHUNK_SIZE = 1024 * 1024; // 1MB per chunk
    const fileInfo = await FileSystem.getInfoAsync(fileUri);
    if (!fileInfo.exists || fileInfo.size === undefined) {
      throw new Error('Cannot get file info for SHA256');
    }
    const fileSize = fileInfo.size;

    // SHA256 常量与初始值
    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
    const w = new Uint32Array(64);
    const processBlock = (block: Uint8Array) => {
      const view = new DataView(block.buffer, block.byteOffset, 64);
      for (let i = 0; i < 16; i++) {
        w[i] = view.getUint32(i * 4, false);
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    };

    // 增量读取： leftover 保存不足 64 字节的尾部
    let leftover = new Uint8Array(0);
    let processedBytes = 0;
    for (let offset = 0; offset < fileSize; offset += CHUNK_SIZE) {
      const len = Math.min(CHUNK_SIZE, fileSize - offset);
      const base64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
        position: offset,
        length: len,
      });
      const binaryLen = Math.floor((base64.length * 3) / 4);
      const chunk = new Uint8Array(binaryLen);
      const binStr = atob(base64);
      for (let i = 0; i < binaryLen; i++) {
        chunk[i] = binStr.charCodeAt(i);
      }
      // 拼接 leftover + chunk，按 64 字节块处理
      const combined = new Uint8Array(leftover.length + chunk.length);
      combined.set(leftover);
      combined.set(chunk, leftover.length);
      const fullBlocks = Math.floor(combined.length / 64);
      for (let b = 0; b < fullBlocks; b++) {
        processBlock(combined.subarray(b * 64, b * 64 + 64));
      }
      leftover = combined.subarray(fullBlocks * 64);
      processedBytes += chunk.length;
    }

    // SHA256 填充：0x80 + 0* + 64-bit 长度
    const bitLen = fileSize * 8;
    const padding = new Uint8Array(leftover.length + 1 + 8);
    padding.set(leftover);
    padding[leftover.length] = 0x80;
    // 长度写入最后 8 字节（大端）
    const dv = new DataView(padding.buffer);
    dv.setUint32(padding.length - 4, bitLen >>> 0, false);
    dv.setUint32(padding.length - 8, Math.floor(bitLen / 0x100000000), false);
    // 如果 leftover+9 > 64，需要补一个块
    let padOffset = 0;
    if (leftover.length + 9 > 64) {
      const first = new Uint8Array(64);
      first.set(padding.subarray(0, 64));
      processBlock(first);
      padOffset = 64;
    }
    const last = new Uint8Array(64);
    last.set(padding.subarray(padOffset));
    processBlock(last);

    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map(v => v.toString(16).padStart(8, '0'))
      .join('');
  }

  /** --------------------------------------------------------------
   *  4️⃣ 安装 APK（只在 Android 可用，使用 expo-intent-launcher）
   * --------------------------------------------------------------- */
  async installApk(fileUri: string): Promise<void> {
    // ① 先确认文件存在
    const exists = await FileSystem.getInfoAsync(fileUri);
    if (!exists.exists) {
      throw new Error(`APK not found at ${fileUri}`);
    }

    // ② 把 file:// 转成 content://，Expo‑FileSystem 已经实现了 FileProvider
    const contentUri = await FileSystem.getContentUriAsync(fileUri);

    // ③ 只在 Android 里执行
    if (Platform.OS === 'android') {
      try {
        // FLAG_ACTIVITY_NEW_TASK = 0x10000000 (1)
        // FLAG_GRANT_READ_URI_PERMISSION = 0x00000010
        const flags = 1 | 0x00000010;   // 1 | 16

        await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
          data: contentUri,          // 必须是 content://
          type: ANDROID_MIME_TYPE,   // application/vnd.android.package-archive
          flags,
        });
      } catch (e) {
        // 统一错误提示
        const errMsg = e instanceof Error ? e.message : String(e);
        if (errMsg.includes('Activity not found')) {
          Toast.show({
            type: 'error',
            text1: '安装失败',
            text2: '系统没有找到可以打开 APK 的应用，请检查系统设置',
          });
        } else if (errMsg.includes('permission')) {
          Toast.show({
            type: 'error',
            text1: '安装失败',
            text2: '请在设置里允许“未知来源”安装',
          });
        } else {
          Toast.show({
            type: 'error',
            text1: '安装失败',
            text2: '未知错误，请稍后重试',
          });
        }
        throw e;
      }
    } else {
      // iOS 设备不支持直接安装 APK
      Toast.show({
        type: 'error',
        text1: '安装失败',
        text2: 'iOS 设备无法直接安装 APK',
      });
      throw new Error('APK install not supported on iOS');
    }
  }

  /** --------------------------------------------------------------
   *  5️⃣ 版本比对工具（支持 -beta / -rc 等后缀）
   * --------------------------------------------------------------- */
  compareVersions(v1: string, v2: string): number {
    // 剥离后缀（如 1.3.14-beta → 1.3.14），只比较数字部分
    const normalize = (v: string) => v.split('-')[0].split('.').map(s => {
      const n = parseInt(s, 10);
      return isNaN(n) ? 0 : n;
    });
    const p1 = normalize(v1);
    const p2 = normalize(v2);
    for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
      const n1 = p1[i] ?? 0;
      const n2 = p2[i] ?? 0;
      if (n1 > n2) return 1;
      if (n1 < n2) return -1;
    }
    return 0;
  }
  getCurrentVersion(): string {
    return currentVersion;
  }
  isUpdateAvailable(remoteVersion: string): boolean {
    return this.compareVersions(remoteVersion, currentVersion) > 0;
  }
}

/* 单例导出 */
export default UpdateService.getInstance();
