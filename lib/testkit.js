// src/scan.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
var FRAME_MAGIC = Buffer.from("28b52ffd", "hex");
var SESSION_FILE = /^session\.v\d+\.jsonl\.zstd$/;
var FORCE_PREFIX = /^!force\s+/;
function normalizeForBrief(text) {
  return text.replace(/[*_~`]/g, "").replace(/[（(【\[]/g, " ").replace(/[）)】\]]/g, " ").replace(/\s+/g, " ").trimStart();
}
var TASK_BRIEF_HEAD = /^(?:先读\s*[A-Za-z]:|你是(?:独立|一个?\s*[^\n]{0,16}(?:助手|子线程|子代理|审查|分析|研究|诊断|审计|架构|工程)))/;
function defaultSessionsRoot() {
  const home = process.env.DSH_HOME ?? (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) ?? "";
  return join(home, "sessions");
}
function findSessionFiles(root, errors) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      errors.push(`${dir}: ${err.message}`);
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (SESSION_FILE.test(entry.name)) {
        found.push(full);
      }
    }
  };
  walk(root, 0);
  return found;
}
function decodeFrames(file, buf, errors) {
  const offsets = [];
  let cursor = buf.indexOf(FRAME_MAGIC, 0);
  while (cursor >= 0) {
    offsets.push(cursor);
    cursor = buf.indexOf(FRAME_MAGIC, cursor + FRAME_MAGIC.length);
  }
  if (offsets.length === 0) {
    errors.push(`${file}: no zstd frame found`);
    return [];
  }
  const decoded = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    try {
      decoded.push({ frame: i, text: zstdDecompressSync(buf.subarray(start, end)).toString("utf8") });
    } catch (err) {
      errors.push(`${file}: frame ${i} failed to decode: ${err.message}`);
    }
  }
  return decoded;
}
function* iterEvents(frames) {
  for (const decoded of frames) {
    for (const line of decoded.text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        yield { frame: decoded.frame, event: JSON.parse(line) };
      } catch {
      }
    }
  }
}
function readPresence(frames) {
  const presence = { sessionId: null, origin: null };
  for (const { event } of iterEvents(frames)) {
    if (event.type !== "session") continue;
    if (typeof event.id === "string" && event.id !== "") presence.sessionId = event.id;
    if (typeof event.origin === "string" && event.origin !== "") presence.origin = event.origin;
    break;
  }
  return presence;
}
function normaliseText(raw) {
  const text = raw.replace(FORCE_PREFIX, "").trim();
  if (text === "") return null;
  if (text.length > 200 && TASK_BRIEF_HEAD.test(normalizeForBrief(text))) return null;
  return text;
}
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return "";
  const parts = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}
var REDACT_PATTERNS = [
  // 带 sk- 前缀的密钥
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "<\u5DF2\u8131\u654F:key>"],
  // JWT（三段点分）
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<\u5DF2\u8131\u654F:jwt>"],
  // 常见会话 cookie 的键值对：按名字逐条列，覆盖 B 站 / Cloudflare / 通用 session。
  // 不用动态拼接的正则 —— 那个写法既难读，也容易在转义上出错。
  [/\bSESSDATA\s*=\s*[^\s;&"']{8,}/gi, "SESSDATA=<\u5DF2\u8131\u654F>"],
  [/\b__security_mc_1_s_sdk_cert_key\s*=\s*[^\s;&"']{8,}/gi, "__security_mc_1_s_sdk_cert_key=<\u5DF2\u8131\u654F>"],
  [/\b(__cf_bm|__cflb|cf_clearance|csrftoken|sessionid|bili_jct|DedeUserID|JSESSIONID|PHPSESSID)\s*=\s*[^\s;&"']{8,}/gi, "$1=<\u5DF2\u8131\u654F>"],
  // 请求头：半角与【全角】冒号都要吃（中文输入法很常见）
  [/\b(authorization|cookie)\s*[:：]\s*[^\r\n]{8,}/gi, "$1: <\u5DF2\u8131\u654F>"],
  // 裸 Bearer token（没有 header 前缀时也要抓）
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer <\u5DF2\u8131\u654F>"],
  // 查询串里的签名 / token / 云存储签名
  [/([?&](?:sig|signature|token|access_token|api_key|key|auth|X-Amz-Signature|X-Amz-Credential)=)[^\s&#"']{8,}/gi, "$1<\u5DF2\u8131\u654F>"],
  // password= / passwd= / pwd=
  [/\b(pass(?:word|wd)?|pwd)\s*=\s*[^\s;&"']{6,}/gi, "$1=<\u5DF2\u8131\u654F>"],
  // 制表符分隔的 cookie 表（DevTools 里直接复制出来的那种，没有等号）
  [/\b(SESSDATA|__cf_bm|__security_mc_1_s_sdk_cert_key|csrftoken|sessionid)\t[^\t\r\n]{8,}/gi, "$1	<\u5DF2\u8131\u654F>"],
  // 裸长串：≥32 位 hex（会话 id / 密钥常见）、≥40 位 base64（token 常见）
  [/\b[0-9a-f]{32,}\b/gi, "<\u5DF2\u8131\u654F:hex>"],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, "<\u5DF2\u8131\u654F:b64>"]
];
function redact(text) {
  let out = text;
  for (const [pattern, replacement] of REDACT_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
function shortSessionId(sessionId) {
  return sessionId.replace(/^session-/, "").slice(0, 8);
}
function scanSessions(opts = {}) {
  const errors = [];
  const utterances = [];
  const usedIds = /* @__PURE__ */ new Set();
  const root = opts.sessionsRoot ?? defaultSessionsRoot();
  const skipSubagent = opts.skipSubagent ?? true;
  const retentionDays = opts.retentionDays ?? 30;
  const sinceDays = opts.sinceDays ?? null;
  const cutoff = sinceDays === null ? null : Date.now() - sinceDays * 864e5;
  let filesScanned = 0;
  let filesSkipped = 0;
  let framesScanned = 0;
  if (root === "") {
    errors.push("sessions root could not be resolved; pass scan({ sessionsRoot }) explicitly");
    return { utterances, filesScanned, filesSkipped, framesScanned, errors };
  }
  const files = findSessionFiles(root, errors);
  for (const file of files) {
    try {
      const info = statSync(file);
      if (cutoff !== null && info.mtimeMs < cutoff) {
        filesSkipped += 1;
        continue;
      }
    } catch (err) {
      errors.push(`${file}: ${err.message}`);
      filesSkipped += 1;
      continue;
    }
    let buf;
    try {
      buf = readFileSync(file);
    } catch (err) {
      errors.push(`${file}: ${err.message}`);
      filesSkipped += 1;
      continue;
    }
    const frames = decodeFrames(file, buf, errors);
    framesScanned += frames.length;
    const presence = readPresence(frames);
    if (skipSubagent && presence.origin === "subagent") {
      filesSkipped += 1;
      continue;
    }
    const sessionId = presence.sessionId ?? file.replace(/[\\/]session\.v\d+\.jsonl\.zstd$/, "").split(/[\\/]/).pop() ?? "unknown";
    const sidShort = shortSessionId(sessionId);
    filesScanned += 1;
    for (const { frame, event } of iterEvents(frames)) {
      if (event.type !== "user/message") continue;
      if (event.data?.source?.kind !== "user") continue;
      const saidAt = typeof event.time === "number" ? event.time : NaN;
      if (!Number.isFinite(saidAt)) {
        errors.push(`${file}: user message without a numeric time at frame ${frame}`);
        continue;
      }
      const text = normaliseText(blocksToText(event.data.content));
      if (text === null) continue;
      let id = `${sidShort}-${saidAt}`;
      if (usedIds.has(id) && typeof event.seq === "number") {
        id = `${id}-${event.seq}`;
      }
      if (usedIds.has(id)) {
        errors.push(`${file}: duplicate utterance id ${id} at frame ${frame}`);
        continue;
      }
      usedIds.add(id);
      utterances.push({
        id,
        // 写入前脱敏：存下来就是风险，不能只靠读时过滤。
        text: redact(text),
        saidAt,
        sessionId,
        frameSeq: frame,
        // 按保留期算淡出时刻：过了这个点，默认查询就看不到它了，
        // 但数据还在（includeExpired 仍可取回）。null = 永不过期。
        validUntil: retentionDays > 0 ? saidAt + retentionDays * 864e5 : null
      });
    }
  }
  return { utterances, filesScanned, filesSkipped, framesScanned, errors };
}

// src/db.ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
var MIN_COVERAGE = 0.5;
var DEFAULT_LIMIT = 10;
var MAX_LIMIT = 50;
var NOTE_UNAVAILABLE = "\u8BB0\u5FC6\u5E93\u5F53\u524D\u4E0D\u53EF\u7528\uFF0C\u5DF2\u6709\u8BB0\u5F55\u6682\u65F6\u65E0\u6CD5\u8BFB\u53D6\u3002";
var NOTE_EMPTY_DB = "\u8BB0\u5FC6\u5E93\u4E3A\u7A7A\uFF0C\u5C1A\u672A\u626B\u63CF\u4EFB\u4F55\u4F1A\u8BDD\u3002";
var NOTE_NOT_FOUND = "\u6CA1\u6709\u627E\u5230\u5339\u914D\u7684\u5386\u53F2\u539F\u8BDD\u3002";
var SCHEMA = `
CREATE TABLE IF NOT EXISTS utterance (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  said_at    INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  frame_seq  INTEGER,
  valid_until INTEGER
);
CREATE INDEX IF NOT EXISTS idx_utterance_said_at ON utterance(said_at);
CREATE INDEX IF NOT EXISTS idx_utterance_session ON utterance(session_id);
`;
var MIGRATE_VALID_UNTIL = `
  SELECT COUNT(*) AS n FROM pragma_table_info('utterance') WHERE name = 'valid_until'
`;
function tokenize(text) {
  const counts = /* @__PURE__ */ new Map();
  const normalized = text.toLowerCase();
  for (const match of normalized.matchAll(/[a-z0-9_]+/g)) {
    const key = `w:${match[0]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const key = run.slice(i, i + 2);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}
function bucketize(rows, windowMs) {
  const buckets = [];
  const now = Date.now();
  let index = 0;
  for (let step = 0; index < rows.length; step += 1) {
    const to = now - step * windowMs;
    const from = to - windowMs;
    const within = [];
    while (index < rows.length && rows[index].said_at >= from) {
      within.push(rows[index]);
      index += 1;
    }
    if (within.length > 0) {
      buckets.push({ from, to, count: within.length, samples: within.slice(0, 3).map(toUtterance) });
    }
  }
  return buckets;
}
function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const v of a.values()) normA += v * v;
  for (const v of b.values()) normB += v * v;
  if (normA === 0 || normB === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, v] of small) {
    const w = large.get(k);
    if (w !== void 0) dot += v * w;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
var SqliteEchoStore = class {
  db = null;
  constructor(dbPath) {
    try {
      if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      db.prepare("PRAGMA journal_mode = WAL").get();
      db.prepare("PRAGMA synchronous = NORMAL").get();
      db.prepare("PRAGMA busy_timeout = 200").get();
      db.exec(SCHEMA);
      const hasColumn = db.prepare(MIGRATE_VALID_UNTIL).get();
      if (hasColumn.n === 0) db.exec("ALTER TABLE utterance ADD COLUMN valid_until INTEGER");
      this.db = db;
    } catch {
      this.db = null;
    }
  }
  upsert(items) {
    if (this.db === null || items.length === 0) return 0;
    try {
      const stmt = this.db.prepare(
        `INSERT INTO utterance (id, text, said_at, session_id, frame_seq, valid_until)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           text = excluded.text,
           said_at = excluded.said_at,
           session_id = excluded.session_id,
           frame_seq = excluded.frame_seq,
           valid_until = excluded.valid_until`
      );
      let written = 0;
      this.db.exec("BEGIN");
      try {
        for (const item of items) {
          stmt.run(item.id, item.text, item.saidAt, item.sessionId, item.frameSeq, item.validUntil);
          written += 1;
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return written;
    } catch {
      return 0;
    }
  }
  query(q) {
    if (this.db === null) return this.miss("unavailable", NOTE_UNAVAILABLE);
    try {
      if (this.countRows() === 0) return this.miss("empty-db", NOTE_EMPTY_DB);
      const where = [];
      const params = [];
      if (q.from !== void 0) {
        where.push("said_at >= ?");
        params.push(q.from);
      }
      if (q.to !== void 0) {
        where.push("said_at <= ?");
        params.push(q.to);
      }
      if (q.days !== void 0 && q.days > 0 && q.mode !== "bucket") {
        where.push("said_at >= ?");
        params.push(Date.now() - q.days * 864e5);
      }
      if (!q.includeExpired) {
        where.push("(valid_until IS NULL OR valid_until > ?)");
        params.push(Date.now());
      }
      const sql = `SELECT id, text, said_at, session_id, frame_seq, valid_until FROM utterance${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY said_at DESC`;
      const rows = this.db.prepare(sql).all(...params);
      const limit = clampLimit(q.limit);
      if (q.mode === "bucket") {
        const windowMs = (q.days ?? 1) * 864e5;
        const buckets = bucketize(rows, windowMs);
        if (buckets.length === 0) return this.miss("not-found", NOTE_NOT_FOUND);
        const total = buckets.reduce((sum, item) => sum + item.count, 0);
        return {
          hits: [],
          total,
          buckets,
          miss: null,
          note: `\u5171 ${total} \u6761\u539F\u8BDD\uFF0C\u5206\u5E03\u5728 ${buckets.length} \u6BB5\u91CC\uFF08\u6BCF\u6BB5 ${q.days ?? 1} \u5929\uFF0C\u4ECE\u5F53\u524D\u65F6\u523B\u5F80\u56DE\u6570\uFF09\u3002`
        };
      }
      const keyword = q.query?.trim() ?? "";
      if (keyword === "") {
        if (rows.length === 0) {
          const expired = this.countExpired();
          if (!q.includeExpired && expired > 0) {
            return this.miss(
              "expired",
              `\u6709 ${expired} \u6761\u5DF2\u7ECF\u6DE1\u5FD8\u4E86\uFF1B\u9ED8\u8BA4\u4E0D\u518D\u8FD4\u56DE\u3002\u8981\u7FFB\u66F4\u65E9\u7684\uFF0C\u5E26 includeExpired: true\u3002`
            );
          }
          return this.miss("not-found", NOTE_NOT_FOUND);
        }
        return {
          hits: rows.slice(0, limit).map(toUtterance),
          total: rows.length,
          miss: null,
          note: `\u5171 ${rows.length} \u6761\u539F\u8BDD\uFF0C\u8FD4\u56DE\u6700\u8FD1 ${Math.min(rows.length, limit)} \u6761\u3002`
        };
      }
      const queryVector = tokenize(keyword);
      if (queryVector.size === 0) return this.miss("not-found", NOTE_NOT_FOUND);
      const matched = [];
      for (const row of rows) {
        const documentVector = tokenize(row.text);
        let hit = 0;
        for (const key of queryVector.keys()) {
          if (documentVector.has(key)) hit += 1;
        }
        if (hit === 0) continue;
        const coverage = hit / queryVector.size;
        const similarity = cosine(queryVector, documentVector);
        const passed = queryVector.size >= 2 ? coverage >= MIN_COVERAGE : row.text.toLowerCase().includes(keyword.toLowerCase());
        if (passed) matched.push({ row, score: 0.6 * coverage + 0.4 * similarity });
      }
      if (matched.length === 0) {
        if (!q.includeExpired) {
          const expired = this.countExpired();
          if (expired > 0) {
            return this.miss(
              "expired",
              `\u6709 ${expired} \u6761\u5DF2\u7ECF\u6DE1\u5FD8\u4E86\uFF1B\u9ED8\u8BA4\u4E0D\u518D\u8FD4\u56DE\u3002\u8981\u7FFB\u66F4\u65E9\u7684\uFF0C\u5E26 includeExpired: true\u3002`
            );
          }
        }
        return this.miss("not-found", NOTE_NOT_FOUND);
      }
      const hits = matched.slice().sort((a, b) => b.row.said_at - a.row.said_at).slice(0, limit).map((m) => toUtterance(m.row));
      return {
        hits,
        total: matched.length,
        miss: null,
        note: `\u5728 ${rows.length} \u6761\u5019\u9009\u539F\u8BDD\u4E2D\u5339\u914D\u5230 ${matched.length} \u6761\uFF0C\u8FD4\u56DE\u6700\u8FD1 ${hits.length} \u6761\u3002`
      };
    } catch {
      return this.miss("unavailable", NOTE_UNAVAILABLE);
    }
  }
  count() {
    if (this.db === null) return 0;
    try {
      return this.countRows();
    } catch {
      return 0;
    }
  }
  close() {
    if (this.db === null) return;
    try {
      this.db.close();
    } catch {
    } finally {
      this.db = null;
    }
  }
  /**
   * 有多少条已经淡忘（`valid_until` 已过）。
   *
   * 不带关键词：它回答的是「库里有没有被淡忘的东西」，
   * 而不是「你要找的那条是不是被淡忘了」—— 后者做不到，
   * 而前者已经足够让回答从「没有」变成「有，但已经淡忘」。
   */
  countExpired() {
    if (this.db === null) return 0;
    try {
      const row = this.db.prepare("SELECT COUNT(*) AS n FROM utterance WHERE valid_until IS NOT NULL AND valid_until <= ?").get(Date.now());
      return row.n;
    } catch {
      return 0;
    }
  }
  countRows() {
    if (this.db === null) return 0;
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM utterance").get();
    return row?.n ?? 0;
  }
  miss(reason, note) {
    return { hits: [], total: 0, miss: reason, note };
  }
};
function clampLimit(limit) {
  if (limit === void 0 || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const value = Math.trunc(limit);
  if (value < 1) return 1;
  if (value > MAX_LIMIT) return MAX_LIMIT;
  return value;
}
function toUtterance(row) {
  return {
    id: row.id,
    text: row.text,
    saidAt: row.said_at,
    sessionId: row.session_id,
    frameSeq: row.frame_seq,
    validUntil: row.valid_until
  };
}
function openStore(dbPath) {
  return new SqliteEchoStore(dbPath);
}

// src/tool.ts
var DESCRIPTION = [
  "\u67E5\u8BE2\u7528\u6237\u8FC7\u53BB\u8BF4\u8FC7\u7684\u539F\u8BDD\uFF08\u9010\u5B57\u6587\u672C\uFF09\uFF0C\u7528\u4E8E\u56DE\u7B54\u300C\u6211\u4E0A\u6B21\u8BF4\u8FC7\u4EC0\u4E48\u300D\u300C\u8FD9\u53E5\u8BDD\u4EE5\u524D\u63D0\u8FC7\u5417\u300D\u8FD9\u7C7B\u95EE\u9898\u3002",
  "\u8FD9\u662F\u68C0\u7D22\uFF0C\u4E0D\u662F\u603B\u7ED3\uFF1A\u8FD4\u56DE\u7684\u662F\u7528\u6237\u5F53\u65F6\u8BF4\u7684\u53E5\u5B50\u672C\u8EAB\uFF0C\u4E0D\u662F\u63D0\u70BC\u540E\u7684\u7ED3\u8BBA\u3002",
  "\u6CA1\u6709\u547D\u4E2D\u65F6\u4F1A\u8BF4\u660E\u539F\u56E0\uFF08\u771F\u7684\u6CA1\u6709 / \u6682\u65F6\u4E0D\u53EF\u7528 / \u5E93\u4E3A\u7A7A\uFF09\uFF0C\u4E09\u79CD\u60C5\u51B5\u542B\u4E49\u4E0D\u540C\uFF0C\u4E0D\u8981\u4E00\u5F8B\u56DE\u7B54\u6210\u300C\u6CA1\u6709\u300D\u3002",
  "\u{1FA78} query \u5FC5\u987B\u662F 2~4 \u4E2A\u5B57\u7684\u5B9E\u4F53\u8BCD\uFF08\u300C\u786C\u76D8\u300D\u300C\u62A5\u9519\u300D\u300C\u6DF1\u8272\u300D\uFF09\uFF0C\u4E0D\u80FD\u76F4\u63A5\u4F20\u6574\u53E5\uFF1A\u6574\u53E5\u4F1A\u88AB\u5207\u6210\u591A\u4E2A\u7247\u6BB5\u3001\u8981\u6C42\u6BCF\u4E2A\u90FD\u547D\u4E2D\uFF0C\u53CD\u800C\u4E00\u6761\u90FD\u67E5\u4E0D\u5230\u3002\u60F3\u628A\u300C\u6211\u4E0A\u6B21\u8BF4\u7684\u90A3\u4E2A\u65B9\u6848\u300D\u53D8\u6210\u67E5\u8BE2\uFF0C\u5C31\u4F20\u300C\u65B9\u6848\u300D\u3002"
].join("");
var PARAM_DESCRIPTION = {
  query: "\u67E5\u4EC0\u4E48\uFF1A\u4E00\u4E2A 2~4 \u4E2A\u5B57\u7684\u5B9E\u4F53\u8BCD\uFF08\u5982\u300C\u786C\u76D8\u300D\u300C\u62A5\u9519\u300D\u300C\u6DF1\u8272\u300D\uFF09\u3002\u26A0\uFE0F \u4E0D\u8981\u4F20\u6574\u53E5 \u2014\u2014 \u591A\u8BCD\u67E5\u8BE2\u8981\u6C42\u6BCF\u4E2A\u7247\u6BB5\u90FD\u547D\u4E2D\uFF0C\u6574\u53E5\u51E0\u4E4E\u5FC5\u7136\u67E5\u4E0D\u5230\u3002\u7559\u7A7A\u8868\u793A\u4E0D\u6309\u5185\u5BB9\u8FC7\u6EE4\u3001\u53EA\u6309\u65F6\u95F4\u8303\u56F4\u53D6\u6700\u8FD1\u7684\u539F\u8BDD\u3002",
  days: "\u53EA\u67E5\u6700\u8FD1\u591A\u5C11\u5929\uFF0C\u4F8B\u5982 7 \u8868\u793A\u6700\u8FD1\u4E00\u5468\u3002\u4E0D\u4F20\u8868\u793A\u4E0D\u9650\u65F6\u95F4\u3002",
  limit: "\u6700\u591A\u8FD4\u56DE\u51E0\u6761\uFF0C\u9ED8\u8BA4 10\uFF0C\u4E0A\u9650 50\u3002",
  mode: "list\uFF08\u9ED8\u8BA4\uFF09\u9010\u6761\u8FD4\u56DE\u539F\u8BDD\uFF1Bbucket \u6309\u65F6\u95F4\u6BB5\u805A\u5408\uFF0C\u53EA\u7ED9\u300C\u54EA\u4E00\u6BB5\u6709\u51E0\u6761\u300D\u52A0\u51E0\u6761\u6837\u4F8B \u2014\u2014 \u95EE\u300C\u6628\u5929\u804A\u4E86\u5565\u300D\u8FD9\u79CD\u8303\u56F4\u95EE\u9898\u65F6\u7528\u5B83\uFF0C\u522B\u4E00\u6B21\u6027\u62C9\u51E0\u767E\u6761\u3002",
  includeExpired: "\u662F\u5426\u8FDE\u5DF2\u7ECF\u6DE1\u5FD8\u7684\u539F\u8BDD\u4E00\u8D77\u67E5\u3002\u9ED8\u8BA4 false\uFF0C\u53EA\u60F3\u770B\u66F4\u65E9\u7684\u5185\u5BB9\u65F6\u624D\u6253\u5F00\u3002"
};
function formatTime(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function toOutput(result) {
  return {
    note: result.note,
    total: result.total,
    miss: result.miss,
    hits: result.hits.map((hit) => ({
      id: hit.id,
      text: hit.text,
      saidAt: hit.saidAt,
      sessionId: hit.sessionId,
      frameSeq: hit.frameSeq
    })),
    ...result.buckets === void 0 ? {} : {
      buckets: result.buckets.map((bucket) => ({
        from: bucket.from,
        to: bucket.to,
        count: bucket.count,
        samples: bucket.samples.map((item) => item.text)
      }))
    }
  };
}
function buildEchoTool(store) {
  return {
    name: "memory_echo",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: PARAM_DESCRIPTION.query },
        days: { type: "integer", description: PARAM_DESCRIPTION.days },
        limit: { type: "integer", description: PARAM_DESCRIPTION.limit },
        mode: {
          type: "string",
          enum: ["list", "bucket"],
          default: "list",
          description: PARAM_DESCRIPTION.mode
        },
        includeExpired: { type: "boolean", default: false, description: PARAM_DESCRIPTION.includeExpired }
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["note", "hits", "total", "miss"],
        properties: {
          note: {
            type: "string",
            description: "\u53EF\u76F4\u63A5\u56DE\u7ED9\u7528\u6237\u7684\u4E00\u53E5\u8BDD\u8BF4\u660E\u3002"
          },
          total: {
            type: "integer",
            description: "\u547D\u4E2D\u7684\u603B\u6761\u6570\uFF0C\u53EF\u80FD\u5927\u4E8E\u8FD4\u56DE\u7684 hits \u6761\u6570\u3002"
          },
          // 宿主子集不支持 type 数组（JsonSchemaError），且 oneOf 旁边不许出现 description。
          miss: {
            oneOf: [
              { type: "string", enum: ["not-found", "unavailable", "empty-db", "expired"] },
              { type: "null" }
            ]
          },
          hits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "text", "saidAt", "sessionId"],
              properties: {
                id: { type: "string", description: "\u8BB0\u5F55\u6807\u8BC6\u3002" },
                text: { type: "string", description: "\u7528\u6237\u5F53\u65F6\u8BF4\u7684\u539F\u8BDD\uFF0C\u9010\u5B57\u3002" },
                saidAt: { type: "integer", description: "\u8BF4\u8BDD\u65F6\u523B\uFF0C\u6BEB\u79D2\u65F6\u95F4\u6233\u3002" },
                sessionId: { type: "string", description: "\u6765\u81EA\u54EA\u4E2A\u4F1A\u8BDD\u3002" },
                frameSeq: {
                  oneOf: [{ type: "integer" }, { type: "null" }]
                }
              }
            }
          },
          buckets: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["from", "to", "count", "samples"],
              properties: {
                from: { type: "integer" },
                to: { type: "integer" },
                count: { type: "integer" },
                samples: { type: "array", items: { type: "string" } }
              }
            }
          }
        }
      },
      render: (_args, value) => {
        const v = value;
        const note = typeof v?.note === "string" ? v.note : "";
        const hits = Array.isArray(v?.hits) ? v.hits : [];
        const buckets = Array.isArray(v?.buckets) ? v.buckets : [];
        const lines = [];
        if (note !== "") lines.push(note);
        for (const raw of buckets) {
          if (raw === null || typeof raw !== "object") continue;
          const bucket = raw;
          const from = typeof bucket.from === "number" ? bucket.from : 0;
          const to = typeof bucket.to === "number" ? bucket.to : 0;
          const count = typeof bucket.count === "number" ? bucket.count : 0;
          lines.push(`- ${formatTime(from)} ~ ${formatTime(to)}\uFF1A${count} \u6761`);
          for (const sample of Array.isArray(bucket.samples) ? bucket.samples : []) {
            if (typeof sample !== "string") continue;
            lines.push(`    \xB7 ${sample}`);
          }
        }
        for (const raw of hits) {
          if (raw === null || typeof raw !== "object") continue;
          const hit = raw;
          const text = typeof hit.text === "string" ? hit.text : "";
          const saidAt = typeof hit.saidAt === "number" ? hit.saidAt : 0;
          lines.push(`- [${formatTime(saidAt)}] ${text}`);
        }
        return [{ type: "text", text: lines.join("\n") }];
      }
    },
    async execute(args) {
      const input = args ?? {};
      const query = {
        query: typeof input.query === "string" ? input.query : void 0,
        days: typeof input.days === "number" ? input.days : void 0,
        limit: typeof input.limit === "number" ? input.limit : void 0,
        mode: input.mode === "bucket" ? "bucket" : "list",
        includeExpired: input.includeExpired === true
      };
      return toOutput(store.query(query));
    }
  };
}
export {
  buildEchoTool,
  openStore,
  scanSessions
};
