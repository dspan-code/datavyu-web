/* 注意：本文件用 IIFE 包住。
 * 原因：index.html 用的是 classic <script>，所有脚本共享同一个全局词法作用域，
 * 两个文件里都写 `const api = ...` 会直接抛出 SyntaxError「Identifier 'api' has already been declared」，
 * 而且整个脚本会被静默丢弃（页面看起来只是「没反应」）。这个坑已经踩过一次，记在这里。
 * Node 端的 CommonJS 分支（module.exports）行为不变。
 */
(function () {
"use strict";

/* opf.js —— .opf 工程文件（ZIP）读写 + 任意入口的自动识别
 *
 * .opf 结构（SaveC.saveProject，逆向报告 §4.2）：
 *   project        YAML：version, name, origpath, dbFile, viewerSettings, trackSettings
 *   db             "#4" 文本（datavyu_notes 的核心载体）
 *   <settingsId>   每个 ViewerSetting 一份二进制播放器设置
 *
 * 读取时文件名以 .opf 结尾走 ZIP，否则走「saveDatabase/openProject」的 legacy 分支，
 * 注意原版 BugzID:1941 —— 旧 .opf 会把条目嵌在一层目录里（<zip名>/project、/db）。
 */

const Z = (() => {
  if (typeof require === "function" && typeof module !== "undefined") return require("./zip.js");
  return globalThis.DVY.zip;
})();
const U = (() => {
  if (typeof require === "function" && typeof module !== "undefined") return require("./util.js");
  return globalThis.DVY.util;
})();
const D4 = (() => {
  if (typeof require === "function" && typeof module !== "undefined") return require("./db4.js");
  return globalThis.DVY.db4;
})();
const M = (() => {
  if (typeof require === "function" && typeof module !== "undefined") return require("./model.js");
  return globalThis.DVY.model;
})();

const DEFAULT_PROJECT = {
  version: 4,
  name: "untitled",
  origpath: "",
  dbFile: "db",
  viewerSettings: [],
  trackSettings: {},
};

/* ------------------------------------------------------- 极简 YAML 读写 */

function yamlScalar(v) {
  if (v === null || v === undefined) return "''";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  if (s === "") return "''";
  if (/^[A-Za-z0-9_./\-+:%]+$/.test(s) && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return s;
  return JSON.stringify(s); // 双引号形式是合法 YAML，且能安全表示任何内容
}

/**
 * 写 project 条目。
 * 只处理 Datavyu 实际用到的扁平结构 + 一层 map/list，
 * 遇到不认识的嵌套结构（比如 viewerSettings 里塞了复杂对象）就退化为 JSON 字符串，
 * 保证不会崩，也不会丢信息（读回时能看到原文）。
 */
function writeProjectYaml(project) {
  const p = { ...DEFAULT_PROJECT, ...(project || {}) };
  const lines = [];
  for (const key of ["version", "name", "origpath", "dbFile"]) {
    lines.push(`${key}: ${yamlScalar(p[key])}`);
  }
  const list = (key, arr) => {
    if (!Array.isArray(arr) || !arr.length) {
      lines.push(`${key}: []`);
      return;
    }
    lines.push(`${key}:`);
    for (const item of arr) {
      if (item && typeof item === "object") {
        const ks = Object.keys(item);
        if (!ks.length) lines.push("  - {}");
        else {
          ks.forEach((k, i) => lines.push(`  ${i === 0 ? "- " : "  "}${k}: ${yamlScalar(item[k])}`));
        }
      } else {
        lines.push(`  - ${yamlScalar(item)}`);
      }
    }
  };
  list("viewerSettings", p.viewerSettings);
  const ts = p.trackSettings;
  if (!ts || typeof ts !== "object" || !Object.keys(ts).length) {
    lines.push("trackSettings: {}");
  } else {
    lines.push("trackSettings:");
    for (const [k, v] of Object.entries(ts)) {
      if (v && typeof v === "object") {
        lines.push(`  ${yamlScalar(k)}:`);
        for (const [k2, v2] of Object.entries(v)) lines.push(`    ${k2}: ${yamlScalar(v2)}`);
      } else {
        lines.push(`  ${yamlScalar(k)}: ${yamlScalar(v)}`);
      }
    }
  }
  for (const [k, v] of Object.entries(p)) {
    if (["version", "name", "origpath", "dbFile", "viewerSettings", "trackSettings"].includes(k)) continue;
    if (v && typeof v === "object") lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${yamlScalar(v)}`);
  }
  return lines.join("\n") + "\n";
}

function parseYamlScalar(raw) {
  const s = raw.trim();
  if (s === "" || s === "''" || s === '""' || s === "~" || s === "null") return "";
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s);
    } catch (_) {
      /* 落到下面 */
    }
  }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/**
 * 读 project 条目：够用的行式解析，只认 <key>: 的形式，不认识的整行保留。
 * 目的不是通用 YAML，而是「Datavyu 写的这份 YAML」。
 */
function parseProjectYaml(text) {
  const out = { project: {}, raw: text || "" };
  const lines = String(text || "").split("\n");
  let curKey = null;
  let curList = null;
  let curObj = null;
  for (let raw of lines) {
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^\s*/)[0].length;
    const body = raw.trim();
    if (indent === 0) {
      const ci = body.indexOf(":");
      if (ci < 0) continue;
      const key = body.slice(0, ci).trim();
      const val = body.slice(ci + 1).trim();
      if (val === "" ) {
        curKey = key;
        curList = null;
        curObj = null;
        out.project[key] = [];
      } else if (val === "[]") {
        out.project[key] = [];
        curKey = null;
      } else if (val === "{}") {
        out.project[key] = {};
        curKey = null;
      } else {
        out.project[key] = parseYamlScalar(val);
        curKey = null;
      }
      continue;
    }
    if (!curKey) continue;
    if (body.startsWith("- ")) {
      if (!curList) {
        curList = [];
        out.project[curKey] = curList;
      }
      const item = body.slice(2).trim();
      const ci = item.indexOf(":");
      if (ci >= 0) {
        const o = {};
        o[item.slice(0, ci).trim()] = parseYamlScalar(item.slice(ci + 1));
        curList.push(o);
        curObj = o;
      } else {
        curList.push(parseYamlScalar(item));
        curObj = null;
      }
      continue;
    }
    const ci = body.indexOf(":");
    if (ci < 0) continue;
    const key = body.slice(0, ci).trim();
    const val = body.slice(ci + 1).trim();
    if (curObj && indent >= 4) {
      curObj[key] = parseYamlScalar(val);
    } else {
      const target = out.project[curKey];
      const asObj = target && !Array.isArray(target) && typeof target === "object" ? target : {};
      if (Array.isArray(target)) out.project[curKey] = asObj;
      asObj[key] = val === "" ? {} : parseYamlScalar(val);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 读 .opf */

const OPF_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function looksLikeZip(u8) {
  if (u8.length < 4) return false;
  for (let i = 0; i < 4; i++) if (u8[i] !== OPF_MAGIC[i]) return false;
  return true;
}

/** db 条目文本解码：#4 是逐字节格式，UTF-8 优先，失败回退 latin1 保真 */
function decodeDbText(data) {
  if (typeof TextDecoder !== "undefined") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch (_) {
      /* 非 UTF-8，下面回退 */
    }
  }
  return Z.latin1Decode(data);
}

function readOpf(buffer, filename = "") {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (!looksLikeZip(u8)) throw new Error("不是 ZIP 容器，可能不是 .opf 文件");
  const entries = Z.unzip(u8);
  const byName = new Map(entries.map((e) => [e.name, e]));

  // BugzID:1941：旧文件条目在 <zip名>/project、<zip名>/db
  let projectName = byName.has("project") ? "project" : null;
  let dbName = byName.has("db") ? "db" : null;
  if (!projectName) {
    for (const e of entries) {
      if (e.name.endsWith("/project")) {
        projectName = e.name;
        dbName = e.name.replace(/\/project$/, "/db");
        break;
      }
    }
  }

  const projectEntry = projectName ? byName.get(projectName) : null;
  const dbEntry = dbName ? byName.get(dbName) : null;
  const projectText = projectEntry ? projectEntry.text() : "";
  const isLegacy = !!(projectName && projectName.includes("/"));

  const db = dbEntry ? D4.parseDb4(decodeDbText(dbEntry.data)) : new M.Database("untitled");

  // 元数据不放在模型里，交给调用方；额外条目原样带回，保存时写回
  const extras = entries
    .filter((e) => e.name !== projectName && e.name !== dbName && !e.name.endsWith("/"))
    .map((e) => ({ name: isLegacy ? e.name.split("/").pop() : e.name, data: e.data }));

  return {
    db,
    projectText,
    project: parseProjectYaml(projectText).project,
    extraEntries: extras,
    entryNames: entries.map((e) => e.name),
    legacy: isLegacy,
  };
}

/* ---------------------------------------------------------------- 写 .opf */

/**
 * 写 .opf。project 条目优先沿用读进来的原文（未知键不丢），
 * 只把 name / version 这类我们确实改过的字段刷一遍。
 */
function writeOpf(db, meta = {}) {
  const project = {
    ...DEFAULT_PROJECT,
    ...(meta.project || {}),
    name: meta.name ?? (meta.project && meta.project.name) ?? db.name,
    origpath: meta.origpath ?? (meta.project && meta.project.origpath) ?? db.origpath ?? "",
  };
  const files = [
    { name: "project", data: writeProjectYaml(project) },
    { name: "db", data: D4.writeDb4(db) },
  ];
  for (const e of meta.extraEntries || db.extraEntries || []) {
    files.push({ name: e.name, data: e.data });
  }
  return Z.zip(files);
}

/* ------------------------------------------------------------ 自动识别入口 */

/**
 * 按内容自动识别 Datavyu 的四种产物，返回统一结构：
 *   { kind: 'opf'|'db4'|'cells-csv'|'frame-csv'|'json', db, project?, extraEntries? }
 */
function readAny(buffer, filename = "") {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const ext = (filename.split(".").pop() || "").toLowerCase();

  if (looksLikeZip(u8)) {
    const r = readOpf(u8, filename);
    return { kind: "opf", db: r.db, project: r.project, projectText: r.projectText, extraEntries: r.extraEntries, legacy: r.legacy };
  }

  const text = ext === "csv" || ext === "txt" || ext === "db" || ext === "odb"
    ? decodeDbText(u8)
    : decodeDbText(u8);
  const head = text.replace(/^\uFEFF/, "").trimStart();

  if (head.startsWith("#4")) {
    return { kind: "db4", db: D4.parseDb4(text) };
  }
  if (head.startsWith("{")) {
    try {
      const obj = JSON.parse(text);
      if (obj && obj.columns) return { kind: "json", db: M.Database.fromJSON(obj) };
    } catch (_) {
      /* 继续往下试 */
    }
  }
  // 第一行含 framenum 且第二列叫 time -> 逐帧 CSV
  const firstLine = head.split("\n")[0] || "";
  if (/^framenum\s*,\s*time\s*,/.test(firstLine)) {
    throw new Error("逐帧 CSV 是「只读产物」，没有唯一的还原方式。请用 .opf / .csv(#4) 作为可编辑格式。");
  }
  if (/\.ordinal\s*,/.test(firstLine)) {
    return { kind: "cells-csv", db: D4.parseCellsCsv(text) };
  }
  if (looksLikeCsv(text)) {
    return { kind: "cells-csv", db: D4.parseCellsCsv(text) };
  }
  throw new Error("无法识别的文件格式（支持 .opf / #4 / cell CSV / 本程序 .json）");
}

function looksLikeCsv(text) {
  const l = (text.split("\n")[0] || "").trim();
  return l.includes(",") && /\.(ordinal|onset|value|offset)\b/.test(l);
}

const api = {
  DEFAULT_PROJECT,
  readOpf,
  writeOpf,
  readAny,
  writeProjectYaml,
  parseProjectYaml,
  looksLikeZip,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") {
  globalThis.DVY = globalThis.DVY || {};
  globalThis.DVY.opf = api;
}
})();
