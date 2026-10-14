/* 注意：本文件用 IIFE 包住。
 * 原因：index.html 用的是 classic <script>，所有脚本共享同一个全局词法作用域，
 * 两个文件里都写 `const api = ...` 会直接抛出 SyntaxError「Identifier 'api' has already been declared」，
 * 而且整个脚本会被静默丢弃（页面看起来只是「没反应」）。这个坑已经踩过一次，记在这里。
 * Node 端的 CommonJS 分支（module.exports）行为不变。
 */
(function () {
"use strict";

/* zip.js —— 零依赖 ZIP 编解码（Datavyu .opf 是 ZIP 容器，必须能读能写）
 *
 * 为什么不用现成库：项目硬约束是「零依赖 / 无构建 / 双击就能跑」。
 * 浏览器里能读 ZIP 的库都要打包，而写 ZIP 的几乎没有；所以我们自己实现最小可用子集。
 *
 * 覆盖范围（够用且够稳）：
 *   读：stored(0) + deflate(8)，含 stored/fixed-Huffman/dynamic-Huffman 三种块
 *   写：stored(0) + deflate(8)（只发 fixed-Huffman 块，短数据零匹配，体积略大但完全合规）
 *   其它：CRC32（查表）、中央目录、ZIP64 尺寸字段透传、UTF-8 与 latin1 双解码
 *
 * 本文件同时可以在浏览器（window.DVY.zip）和 Node（import）里用。
 */

/* ------------------------------------------------------------------ CRC32 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------------------------------------------------------- inflate */

class BitReader {
  constructor(bytes, bytePos = 0) {
    this.bytes = bytes;
    this.pos = bytePos; // 下一个要读的字节
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  // DEFLATE 的数字都是「低位在前」
  bits(n) {
    while (this.bitCnt < n) {
      if (this.pos >= this.bytes.length) throw new Error("inflate: 输入提前结束");
      this.bitBuf |= this.bytes[this.pos++] << this.bitCnt;
      this.bitCnt += 8;
    }
    const v = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCnt -= n;
    return v;
  }
  alignByte() {
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
}

// 由码长构造规范 Huffman 解码表（按 DEFLATE 的规范：短码在前，同长度按符号升序）
function buildHuffman(lengths) {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  if (maxLen === 0) return { codes: [], maxLen: 0 };
  const blCount = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Array(maxLen + 1);
  for (let i = 0; i <= maxLen; i++) codes[i] = new Map();
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym];
    if (len > 0) codes[len].set(nextCode[len]++, sym);
  }
  return { codes, maxLen };
}

function huffDecode(br, huff) {
  let code = 0;
  for (let len = 1; len <= huff.maxLen; len++) {
    code = (code << 1) | br.bits(1);
    const m = huff.codes[len];
    if (m && m.size) {
      const sym = m.get(code);
      if (sym !== undefined) return sym;
    }
  }
  throw new Error("inflate: 非法 Huffman 码");
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

let FIXED_LIT = null;
let FIXED_DIST = null;
function fixedTables() {
  if (FIXED_LIT) return { lit: FIXED_LIT, dist: FIXED_DIST };
  const l = new Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  FIXED_LIT = buildHuffman(l);
  FIXED_DIST = buildHuffman(new Array(30).fill(5));
  return { lit: FIXED_LIT, dist: FIXED_DIST };
}

const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function inflateRaw(input) {
  const out = [];
  let br = new BitReader(input, 0);
  for (;;) {
    const final = br.bits(1);
    const type = br.bits(2);
    if (type === 0) {
      br.alignByte();
      const p = br.pos;
      const len = input[p] | (input[p + 1] << 8);
      br.pos = p + 4 + len;
      for (let i = 0; i < len; i++) out.push(input[p + 4 + i]);
    } else if (type === 1 || type === 2) {
      let lit, dist;
      if (type === 1) {
        ({ lit, dist } = fixedTables());
      } else {
        const hlit = br.bits(5) + 257;
        const hdist = br.bits(5) + 1;
        const hclen = br.bits(4) + 4;
        const clLens = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) clLens[CLEN_ORDER[i]] = br.bits(3);
        const clHuff = buildHuffman(clLens);
        const lens = [];
        while (lens.length < hlit + hdist) {
          const sym = huffDecode(br, clHuff);
          if (sym < 16) lens.push(sym);
          else if (sym === 16) {
            const prev = lens[lens.length - 1];
            const rep = 3 + br.bits(2);
            for (let i = 0; i < rep; i++) lens.push(prev);
          } else if (sym === 17) {
            const rep = 3 + br.bits(3);
            for (let i = 0; i < rep; i++) lens.push(0);
          } else {
            const rep = 11 + br.bits(7);
            for (let i = 0; i < rep; i++) lens.push(0);
          }
        }
        lit = buildHuffman(lens.slice(0, hlit));
        dist = buildHuffman(lens.slice(hlit, hlit + hdist));
      }
      for (;;) {
        const sym = huffDecode(br, lit);
        if (sym === 256) break;
        if (sym < 256) {
          out.push(sym);
        } else {
          const li = sym - 257;
          if (li >= LEN_BASE.length) throw new Error("inflate: 长度码越界 " + sym);
          const length = LEN_BASE[li] + br.bits(LEN_EXTRA[li]);
          const dsym = huffDecode(br, dist);
          const d = DIST_BASE[dsym] + br.bits(DIST_EXTRA[dsym]);
          const start = out.length - d;
          if (start < 0) throw new Error("inflate: 距离越界");
          for (let i = 0; i < length; i++) out.push(out[start + i]);
        }
      }
    } else {
      throw new Error("inflate: 非法块类型 3");
    }
    if (final) break;
  }
  return Uint8Array.from(out);
}

/* ------------------------------------------------------------------ deflate */

class BitWriter {
  constructor() {
    this.bytes = [];
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  bits(value, n) {
    for (let i = 0; i < n; i++) {
      this.bitBuf |= ((value >>> i) & 1) << this.bitCnt;
      if (++this.bitCnt === 8) {
        this.bytes.push(this.bitBuf & 0xff);
        this.bitBuf = 0;
        this.bitCnt = 0;
      }
    }
  }
  alignByte() {
    if (this.bitCnt > 0) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
  }
}

// 固定 Huffman 表的「码字」预表（MSB 优先构造，按位反转后写出，符合规范）
let FIXED_ENC = null;
function fixedEncoder() {
  if (FIXED_ENC) return FIXED_ENC;
  const litLens = new Array(288);
  for (let i = 0; i < 144; i++) litLens[i] = 8;
  for (let i = 144; i < 256; i++) litLens[i] = 9;
  for (let i = 256; i < 280; i++) litLens[i] = 7;
  for (let i = 280; i < 288; i++) litLens[i] = 8;

  const build = (lens) => {
    let maxLen = 0;
    for (const l of lens) if (l > maxLen) maxLen = l;
    const blCount = new Array(maxLen + 1).fill(0);
    for (const l of lens) if (l > 0) blCount[l]++;
    const nextCode = new Array(maxLen + 1).fill(0);
    let code = 0;
    for (let bits = 1; bits <= maxLen; bits++) {
      code = (code + blCount[bits - 1]) << 1;
      nextCode[bits] = code;
    }
    const rev = (v, n) => {
      let r = 0;
      for (let i = 0; i < n; i++) if ((v >>> i) & 1) r |= 1 << (n - 1 - i);
      return r;
    };
    return lens.map((len) => (len === 0 ? null : { code: rev(nextCode[len]++, len), len }));
  };
  FIXED_ENC = { lit: build(litLens), dist: build(new Array(30).fill(5)) };
  return FIXED_ENC;
}

// 只发「一个 final + 固定 Huffman」块：短数据不压缩也不吃亏，合规性最好
function deflateRaw(input) {
  const bw = new BitWriter();
  const { lit, dist } = fixedEncoder();
  bw.bits(1, 1); // BFINAL
  bw.bits(1, 2); // BTYPE = fixed
  for (let i = 0; i < input.length; i++) {
    const e = lit[input[i]];
    bw.bits(e.code, e.len);
  }
  const end = lit[256];
  bw.bits(end.code, end.len);
  void dist;
  bw.alignByte();
  return Uint8Array.from(bw.bytes);
}

function deflateStored(input) {
  const bw = new BitWriter();
  let off = 0;
  const MAX = 65535;
  do {
    const n = Math.min(MAX, input.length - off);
    const last = off + n >= input.length ? 1 : 0;
    bw.bits(last, 1);
    bw.bits(0, 2);
    bw.alignByte();
    bw.bytes.push(n & 0xff, (n >>> 8) & 0xff, ~n & 0xff, (~n >>> 8) & 0xff);
    for (let i = 0; i < n; i++) bw.bytes.push(input[off + i]);
    off += n;
  } while (off < input.length);
  return Uint8Array.from(bw.bytes);
}

function inflateStored(input) {
  return inflateRaw(input);
}

/* -------------------------------------------------------------------- ZIP */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function latin1Bytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function utf8Encode(str) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
  return latin1Bytes(unescape(encodeURIComponent(str)));
}

// 优先按 UTF-8 解；失败则回退 latin1（Datavyu 的 #4 是逐字节处理，latin1 才保真）
function utf8Decode(bytes) {
  let strict = "";
  try {
    strict = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return strict;
  } catch (_) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
}

function latin1Decode(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return s;
}

/**
 * 读 ZIP。返回 [{ name, data:Uint8Array, text(), textLatin1(), method, crc, size }]
 * 从中央目录读（比顺序扫 local header 更可靠，能跳过 data descriptor）。
 */
function unzip(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  // 从尾部找 EOCD（注释最长 65535）
  let eocd = -1;
  const minStart = Math.max(0, u8.length - 65557);
  for (let i = u8.length - 22; i >= minStart; i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: 找不到 EOCD，不是合法 ZIP");

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== SIG_CENTRAL) throw new Error("zip: 中央目录签名错误 @" + p);
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const rawSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const nameBytes = u8.subarray(p + 46, p + 46 + nameLen);
    // 有 UTF-8 标志位就用 UTF-8，否则按 latin1 读名字（Datavyu 的条目名都是 ASCII）
    const name = flags & 0x800 ? utf8Decode(nameBytes) : latin1Decode(nameBytes);

    // 从 local header 拿真实数据起点
    if (dv.getUint32(localOff, true) !== SIG_LOCAL) throw new Error("zip: local header 签名错误");
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = u8.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = comp.slice();
    else if (method === 8) data = inflateRaw(comp);
    else throw new Error("zip: 不支持的压缩方法 " + method);
    if (data.length !== rawSize) {
      throw new Error(`zip: 解压长度不符 ${name} 期望${rawSize} 实际${data.length}`);
    }

    entries.push({
      name,
      method,
      crc,
      compSize,
      size: rawSize,
      data,
      text: () => utf8Decode(data),
      textLatin1: () => latin1Decode(data),
    });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}

/**
 * 写 ZIP。files = [{ name, data:Uint8Array|string, method?:0|8 }]
 * method 默认 8（固定 Huffman deflate）；只有对 deflate 结果更大时才回退 stored。
 */
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const push = (arr) => {
    chunks.push(arr);
    offset += arr.length;
  };

  for (const f of files) {
    const nameBytes = utf8Encode(f.name);
    let raw = typeof f.data === "string" ? utf8Encode(f.data) : f.data;
    if (!(raw instanceof Uint8Array)) raw = new Uint8Array(raw);

    let method = f.method === undefined ? 8 : f.method;
    let payload;
    if (method === 8) {
      const def = deflateRaw(raw);
      if (def.length < raw.length) payload = def;
      else {
        method = 0;
        payload = raw;
      }
    } else {
      method = 0;
      payload = raw;
    }

    const crc = crc32(raw);
    const local = new Uint8Array(30);
    const ldv = new DataView(local.buffer);
    ldv.setUint32(0, SIG_LOCAL, true);
    ldv.setUint16(4, 20, true); // version needed
    ldv.setUint16(6, 0x0800, true); // UTF-8 名字标志
    ldv.setUint16(8, method, true);
    ldv.setUint16(10, 0, true); // time
    ldv.setUint16(12, 0x21 << 9, true); // date: 2016-01-01（固定，便于内容可比对）
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, payload.length, true);
    ldv.setUint32(22, raw.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    const localOff = offset;
    push(local);
    push(nameBytes);
    push(payload);

    const cd = new Uint8Array(46);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, SIG_CENTRAL, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, method, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0x21 << 9, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, payload.length, true);
    cdv.setUint32(24, raw.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, localOff, true);
    central.push({ cd, nameBytes });
  }

  const cdStart = offset;
  for (const c of central) {
    push(c.cd);
    push(c.nameBytes);
  }
  const cdSize = offset - cdStart;

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, SIG_EOCD, true);
  edv.setUint16(8, central.length, true);
  edv.setUint16(10, central.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, cdStart, true);
  push(eocd);

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const api = {
  crc32,
  inflateRaw,
  deflateRaw,
  deflateStored,
  inflateStored,
  unzip,
  zip,
  utf8Encode,
  utf8Decode,
  latin1Decode,
  latin1Bytes,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") {
  globalThis.DVY = globalThis.DVY || {};
  globalThis.DVY.zip = api;
}
})();
