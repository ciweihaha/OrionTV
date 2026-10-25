/**
 * UTF-8 字节长度：不依赖 TextEncoder（各运行环境可用性不一），按码点逐个
 * 累加，与 TextEncoder 编码长度一致（孤立代理按 U+FFFD 计 3 字节）。
 * 原为 services/api.ts 的私有静态方法（OTV-3）：抽为共享工具，供 api.ts 的
 * readJsonLimited 与 services/m3u.ts 的 readTextWithLimit 复用，避免两处
 * 体积判断口径不一致（text.length 是 UTF-16 码元数，对多字节文本会低估）。
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
