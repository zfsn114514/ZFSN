/* ══════════════════════════════════════════════════════════════
   媒体层：文件校验 + KV 读写（大文件分片）+ Range 流式返回
   对应旧后端 data/media 目录与那段手写的 multipart 解析。
   ══════════════════════════════════════════════════════════════ */

import { humanSize } from "./lib.js";

/* ── 上传限额 ──────────────────────────────────────────────────
 *  图片 12MB 与旧后端一致。
 *  视频从 100MB 降到 50MB：Worker 内存上限 128MB，而
 *  request.formData() 会把整个文件读进内存再分片写入，
 *  100MB 的视频再叠上 multipart 开销很容易 OOM。
 *  现有那个 38MB 的视频在范围内（分成 5 片），更大的建议先压一压。
 *  另外 KV 免费版每天只给 1000 次写，50MB 视频 = 7 片 + 1 清单 = 8 次，
 *  正常用量远远打不到上限。
 *  ──────────────────────────────────────────────────────────── */
export const UPLOAD_LIMITS = {
  image: 12 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  file: 50 * 1024 * 1024
};

export const MAX_FILES = { image: 20, video: 1, file: 5 };

export const VIDEO_EXTS = [".mp4", ".webm", ".mov", ".m4v", ".ogv", ".mkv"];

export const FILE_EXTS = [
  ".zip", ".rar", ".7z", ".tar", ".gz",
  ".pdf", ".txt", ".md", ".csv", ".json",
  ".psd", ".ai", ".blend", ".stl", ".obj", ".fbx",
  ".mp3", ".wav", ".m4a", ".ogg", ".flac",
  ".apk", ".exe", ".msi", ".dmg",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"
];

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".ogv": "video/ogg",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8"
};

export function mimeOf(name) {
  const m = /\.[a-z0-9]{1,8}$/i.exec(String(name || ""));
  return (m && MIME[m[0].toLowerCase()]) || "application/octet-stream";
}

/**
 * 录音专用 MIME。
 * 通用表里 .webm 对应 video/webm —— 那是给作品视频用的。
 * 留言录音是纯音频的 WebM 容器，标成 audio/webm 才能让 <audio> 正确识别，
 * 否则部分浏览器会因 video/* 而拒绝在音频控件里播放。
 */
export function audioMimeOf(ext) {
  if (ext === ".webm") return "audio/webm";
  if (ext === ".ogg") return "audio/ogg";
  return mimeOf("a" + (ext || ".webm"));
}

/* ── 魔数校验 ──────────────────────────────────────────────────
 *  不能只信客户端给的 Content-Type / 扩展名 —— 那是可伪造的。
 *  以文件头为准决定扩展名，既防错也防恶意上传。
 *  ──────────────────────────────────────────────────────────── */

function ascii(u8, start, len) {
  let s = "";
  for (let i = start; i < start + len && i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}

export function sniffImage(u8) {
  if (!u8 || u8.length < 12) return null;
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return ".jpg";
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return ".png";
  if (ascii(u8, 0, 4) === "RIFF" && ascii(u8, 8, 4) === "WEBP") return ".webp";
  if (ascii(u8, 0, 3) === "GIF") return ".gif";
  if (ascii(u8, 4, 8).indexOf("ftypavif") === 0) return ".avif";
  return null;
}

export function sniffAudio(u8) {
  if (!u8 || u8.length < 12) return null;
  // Matroska / WebM
  if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return ".webm";
  if (ascii(u8, 0, 4) === "OggS") return ".ogg";
  if (ascii(u8, 0, 4) === "RIFF" && ascii(u8, 8, 4) === "WAVE") return ".wav";
  if (ascii(u8, 0, 3) === "ID3") return ".mp3";
  if (ascii(u8, 4, 8).indexOf("ftyp") === 0) return ".m4a";
  if (u8[0] === 0xff && (u8[1] === 0xfb || u8[1] === 0xf3)) return ".mp3";
  return null;
}

/** 视频：认得出就认，认不出返回 "?" 放行（后台自己上传，误拒更烦人） */
export function sniffVideo(u8) {
  if (!u8 || u8.length < 16) return null;
  if (ascii(u8, 4, 8).indexOf("ftyp") === 0) {
    const brand = ascii(u8, 8, 4);
    if (brand.indexOf("qt") === 0) return ".mov";
    if (brand.indexOf("M4V") === 0) return ".m4v";
    return ".mp4";
  }
  if (u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) return ".webm";
  if (ascii(u8, 0, 4) === "OggS") return ".ogv";
  return "?";
}

/** 文件：不看魔数，只查扩展名白名单 */
export function extForFile(filename) {
  const m = /(\.[a-z0-9]{1,8})$/i.exec(String(filename || ""));
  const ext = m ? m[1].toLowerCase() : "";
  return FILE_EXTS.indexOf(ext) >= 0 ? ext : "";
}

export function extForVideo(filename) {
  const m = /(\.[a-z0-9]{1,8})$/i.exec(String(filename || ""));
  const ext = m ? m[1].toLowerCase() : "";
  return VIDEO_EXTS.indexOf(ext) >= 0 ? ext : "";
}

/** 不冲突的文件名：w20261002-221033-a1b2c3d4.mp4 */
export function uploadName(ext, tzOffset) {
  const off = Number(tzOffset === undefined ? 8 : tzOffset);
  const d = new Date(Date.now() + off * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const ts = "" + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    "-" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
  let rnd = "";
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  for (let i = 0; i < b.length; i++) rnd += b[i].toString(16).padStart(2, "0");
  return "w" + ts + "-" + rnd + ext;
}

/* ── data URL 解码 ───────────────────────────────────────────
 *  留言的图片和录音是前端用 canvas / MediaRecorder 录完
 *  直接转 base64 塞进 JSON 的，这里解回字节。
 *  ──────────────────────────────────────────────────────────── */

/**
 * 解码 dataURL。
 * ⚠ 不能简单用 /^data:([^;,]*)(;base64)?,/ —— 浏览器的 MediaRecorder 产出的
 *   MIME 是带参数的 `audio/webm;codecs=opus`，而分号后的参数会让 `[^;,]*`
 *   提前截断，导致整条 dataURL 匹配失败、录音被静默丢弃。
 *   所以这里按第一个逗号切开，再从头部的 MIME 里剥掉 `;codecs=...` 之类的参数。
 *   头部形如：type/subtype(;param=value)*(;base64)?
 */
export function decodeDataUrl(s) {
  const str = String(s === null || s === undefined ? "" : s);
  if (str.slice(0, 5).toLowerCase() !== "data:") return null;
  const comma = str.indexOf(",");
  if (comma < 0) return null;

  let head = str.slice(5, comma);
  const payload = str.slice(comma + 1);

  let isB64 = false;
  if (/;base64$/i.test(head)) {
    isB64 = true;
    head = head.slice(0, -";base64".length);
  }
  // 只保留主类型，丢弃 ;codecs=opus 这类参数
  const semi = head.indexOf(";");
  const type = (semi >= 0 ? head.slice(0, semi) : head).trim();

  if (isB64) {
    try {
      const bin = atob(payload);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return { type, buf: u8 };
    } catch (_) {
      return null;
    }
  }
  try {
    return { type, buf: new TextEncoder().encode(decodeURIComponent(payload)) };
  } catch (_) {
    return null;
  }
}

/* ── KV 读写（自动分片） ───────────────────────────────────────
 *  原计划存 R2，但 R2 开通要绑支付方式，改用**免费版 KV**：
 *    · 免费额度：1 GB 存储 / 10 万次读 / 1 千次写（个人站绰绰有余）
 *    · 单值上限 25 MiB —— 那个 38 MB 的作品视频放不下，所以分片
 *    · ⚠ KV 是最终一致：新写入最多 60 秒才在所有节点可见。
 *      刚上传完立刻刷新可能暂时取不到，等一会儿就好。
 *      （以后若开通了 R2，只需换掉本文件里的这几个函数）
 *
 *  存储布局 —— 一个文件 = 1 个清单 + N 个分片：
 *    <key>          清单 JSON：{"ct":MIME, "size":字节数, "chunk":片大小, "n":片数}
 *    <key>!0 … !n-1 分片的原始字节
 *
 *  小文件也走清单，而不是直接把字节存在 <key> 上：
 *  迁移脚本是用 wrangler CLI 写的，CLI 写不了 metadata，
 *  靠 metadata 区分"清单还是原始字节"会让两条写入路径行为不一致。
 *  统一走清单更省心，代价是每个小文件多一次 KV 读 —— 读配额够，不在乎。
 *  ──────────────────────────────────────────────────────────── */

const CHUNK = 8 * 1024 * 1024; // 8 MiB，离 25 MiB 上限很远，留足余量

const chunkKey = (key, i) => key + "!" + i;

export async function putObject(env, key, data, contentType) {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
  const size = buf.length;
  const n = Math.max(1, Math.ceil(size / CHUNK));
  const manifest = JSON.stringify({
    ct: contentType || mimeOf(key),
    size,
    chunk: CHUNK,
    n
  });

  // 先写分片、后写清单：顺序反了的话，万一清单先落地而分片还在传，
  // 读到的是缺片的坏文件。
  // 串行而不是 Promise.all：38 MB 的文件并行发 6 个 put，
  // 每个都要序列化自己的那片，峰值内存接近两倍，Worker 只有 128 MB。
  for (let i = 0; i < n; i++) {
    await env.MEDIA.put(
      chunkKey(key, i),
      buf.subarray(i * CHUNK, Math.min(size, (i + 1) * CHUNK))
    );
  }
  await env.MEDIA.put(key, manifest);
  return key;
}

/** 单分片（绝大多数图片、录音）：整片取回来再切 */
async function sliceOne(env, key, start, end) {
  const buf = await env.MEDIA.get(chunkKey(key, 0), "arrayBuffer");
  if (buf === null) return new Uint8Array(0);
  const e = Math.min(end, buf.byteLength - 1);
  if (e < start) return new Uint8Array(0);
  return new Uint8Array(buf, start, e - start + 1);
}

/**
 * 多分片（大视频）：按 Range 只取涉及的片，边取边发。
 * 不一次性拼进内存 —— 38 MB 拼一起加上开销容易顶到 128 MB 上限。
 */
function streamChunks(env, key, chunk, n, start, end) {
  let i = Math.floor(start / chunk);
  const last = Math.min(n - 1, Math.floor(end / chunk));
  return new ReadableStream({
    async pull(controller) {
      if (i > last) {
        controller.close();
        return;
      }
      const buf = await env.MEDIA.get(chunkKey(key, i), "arrayBuffer");
      if (buf === null) {
        controller.close();
        return;
      }
      const base = i * chunk;
      const s = Math.max(start, base);
      const e = Math.min(end, base + buf.byteLength - 1);
      controller.enqueue(
        e < s ? new Uint8Array(0) : new Uint8Array(buf, s - base, e - s + 1)
      );
      i++;
    }
  });
}

/**
 * 取对象并返回响应，支持 Range（视频拖动进度条全靠它）。
 * 找不到返回 null，由调用方决定 404 还是回落到静态资源。
 */
export async function serveObject(request, env, key, opts) {
  const opt = opts || {};
  const manifest = await env.MEDIA.get(key, "json");
  if (!manifest || typeof manifest !== "object") return null;

  const size = Number(manifest.size) || 0;
  const n = Math.max(1, Number(manifest.n) || 1);
  const chunk = Number(manifest.chunk) || CHUNK;
  const ct = manifest.ct || mimeOf(key);

  let start = 0;
  let end = Math.max(0, size - 1);
  let status = 200;
  let contentRange = null;

  const rangeHeader = request.headers.get("range");
  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m) {
      if (m[1] === "" && m[2] !== "") {
        // bytes=-500：要最后 500 字节
        const suffix = Math.min(Number(m[2]), size);
        start = Math.max(0, size - suffix);
        end = size - 1;
      } else if (m[1] !== "") {
        start = Number(m[1]);
        end = m[2] !== "" ? Math.min(Number(m[2]), end) : end;
      }
      if (!size || start > end || start >= size) {
        return new Response(null, {
          status: 416,
          headers: { "content-range": "bytes */" + size, "accept-ranges": "bytes" }
        });
      }
      status = 206;
      contentRange = "bytes " + start + "-" + end + "/" + size;
    }
  }

  const headers = {
    "accept-ranges": "bytes",
    "content-type": ct,
    "content-length": String(end - start + 1),
    // 文件名带随机串，内容不会变，可以放心长缓存
    "cache-control": "public, max-age=31536000, immutable"
  };
  if (contentRange) headers["content-range"] = contentRange;
  if (opt.downloadName) {
    // 下载要保留作者上传时的原始文件名，而不是 w2026...-a1b2.zip
    headers["content-disposition"] =
      'attachment; filename="' + encodeURIComponent(opt.downloadName) + '"; ' +
      "filename*=UTF-8''" + encodeURIComponent(opt.downloadName);
  }

  if (request.method === "HEAD") return new Response(null, { status, headers });

  const body =
    n === 1
      ? await sliceOne(env, key, start, end)
      : streamChunks(env, key, chunk, n, start, end);
  return new Response(body, { status, headers });
}

/** 列出某个前缀下的全部键（分片键 <key>!N 也带同样的前缀，会一并列出） */
export async function listMedia(env, prefix) {
  const out = [];
  let cursor = undefined;
  do {
    const r = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    for (const k of r.keys || []) out.push(k.name);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor && out.length < 5000);
  return out;
}

/** 批量删除（清留言附件时用，避免 KV 里留孤儿） */
export async function deleteMedia(env, names) {
  await Promise.all((names || []).map((k) => env.MEDIA.delete(k)));
  return (names || []).length;
}

export { humanSize };
