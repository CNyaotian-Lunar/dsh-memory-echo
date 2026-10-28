/**
 * dsh-memory-echo —— session log scanner.
 *
 * Reads DSH session logs (`<sessionsRoot>/<workspace>/<sessionId>/session.v<NN>.jsonl.zstd`)
 * and extracts the user's own utterances.
 *
 * Notes that matter:
 *   - Session files are multi-frame zstd. `zstdDecompressSync` only yields the first
 *     frame, so the buffer is split on the frame magic and each frame is decoded
 *     separately. A frame that fails to decode is recorded and skipped; the scan
 *     continues.
 *   - Only `type === "user/message"` with `data.source.kind === "user"` is kept.
 *     Assistant replies, tool output, injected instructions and runtime context are
 *     therefore excluded by construction.
 *   - Subagent sessions carry `origin === "subagent"` on the leading `session` event.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import type { ScanOptions, ScanResult, Utterance } from './types.js'

const FRAME_MAGIC = Buffer.from('28b52ffd', 'hex')
const SESSION_FILE = /^session\.v\d+\.jsonl\.zstd$/
const FORCE_PREFIX = /^!force\s+/
/**
 * 任务书开头的形态。
 *
 * 真实语料里漏检最多的三种，都是**标记符把关键词切开了**：
 *   「你是**架构诊断员**」        → 加粗
 *   「你是某某（带括号的角色名）子线程」 → 括号
 *   「先读 `<盘符>:\…`」        → 反引号
 * 所以判定前先把这些标记剥掉（见 normalizeForBrief）。
 */
/**
 * 判定前先剥掉标记符。
 *
 * 真实语料里漏检最多的是「标记把关键词切开了」：
 *   你是**架构诊断员**      → 加粗
 *   你是某某（带括号的角色名）子线程 → 括号
 *   先读 `<盘符>:\…`      → 反引号
 * 直接拿原文正则匹配，这三种全都漏。
 */
function normalizeForBrief(text: string): string {
  return text
    .replace(/[*_~`]/g, '')
    .replace(/[（(【\[]/g, ' ')
    .replace(/[）)】\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trimStart()
}

/** 任务书开头的形态（在归一化文本上匹配）。 */
const TASK_BRIEF_HEAD =
  /^(?:先读\s*[A-Za-z]:|你是(?:独立|一个?\s*[^\n]{0,16}(?:助手|子线程|子代理|审查|分析|研究|诊断|审计|架构|工程)))/

interface RawContentBlock {
  type?: string
  text?: string
}

interface RawEvent {
  type?: string
  time?: number
  seq?: number
  id?: string
  origin?: string
  data?: {
    content?: RawContentBlock[]
    source?: { kind?: string }
    role?: string
  }
}

interface DecodedFrame {
  frame: number
  text: string
}

interface Presence {
  sessionId: string | null
  origin: string | null
}

/** Resolve `$DSH_HOME/sessions` without importing `node:os`. */
function defaultSessionsRoot(): string {
  const home =
    process.env.DSH_HOME ??
    (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) ??
    ''
  return join(home, 'sessions')
}

/** Depth-first search for session log files. Missing roots yield an empty list. */
function findSessionFiles(root: string, errors: string[]): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      errors.push(`${dir}: ${(err as Error).message}`)
      return
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (SESSION_FILE.test(entry.name)) {
        found.push(full)
      }
    }
  }
  walk(root, 0)
  return found
}

/** Split a multi-frame zstd buffer and decode every frame independently. */
function decodeFrames(file: string, buf: Buffer, errors: string[]): DecodedFrame[] {
  const offsets: number[] = []
  let cursor = buf.indexOf(FRAME_MAGIC, 0)
  while (cursor >= 0) {
    offsets.push(cursor)
    cursor = buf.indexOf(FRAME_MAGIC, cursor + FRAME_MAGIC.length)
  }
  if (offsets.length === 0) {
    errors.push(`${file}: no zstd frame found`)
    return []
  }
  const decoded: DecodedFrame[] = []
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i] as number
    const end = i + 1 < offsets.length ? (offsets[i + 1] as number) : buf.length
    try {
      decoded.push({ frame: i, text: zstdDecompressSync(buf.subarray(start, end)).toString('utf8') })
    } catch (err) {
      errors.push(`${file}: frame ${i} failed to decode: ${(err as Error).message}`)
    }
  }
  return decoded
}

function* iterEvents(frames: DecodedFrame[]): Generator<{ frame: number; event: RawEvent }> {
  for (const decoded of frames) {
    for (const line of decoded.text.split('\n')) {
      if (line.trim() === '') continue
      try {
        yield { frame: decoded.frame, event: JSON.parse(line) as RawEvent }
      } catch {
        // A non-JSON line inside an otherwise valid frame is not fatal.
      }
    }
  }
}

function readPresence(frames: DecodedFrame[]): Presence {
  const presence: Presence = { sessionId: null, origin: null }
  for (const { event } of iterEvents(frames)) {
    if (event.type !== 'session') continue
    if (typeof event.id === 'string' && event.id !== '') presence.sessionId = event.id
    if (typeof event.origin === 'string' && event.origin !== '') presence.origin = event.origin
    break
  }
  return presence
}

/**
 * Normalise one user utterance.
 *
 * Returns `null` for empty text and for task briefs. The `!force` prefix is stripped
 * rather than used as an exclusion marker: those messages are ordinary utterances with
 * a routing prefix, and dropping them removes whole sessions from the archive.
 */
function normaliseText(raw: string): string | null {
  const text = raw.replace(FORCE_PREFIX, '').trim()
  if (text === '') return null
  // Task briefs are long and start with a recognisable directive; a length floor keeps
  // short conversational text such as "你是独立的吗" from being mistaken for one.
  if (text.length > 200 && TASK_BRIEF_HEAD.test(normalizeForBrief(text))) return null
  return text
}

function blocksToText(blocks: RawContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * 写入前脱敏。
 *
 * 判据是「这段文本里有没有能被直接拿去用的值」—— 有就替换成占位符，但保留周围结构
 * （这样「我当时在调一个接口」这类上下文还在，记忆不至于变成一句空话）。
 *
 * ⚠️ 口径与「发布前扫描」**相反**：发布扫描宁可误杀（漏报是事故），这里宁可精确
 * （误杀会毁掉记忆内容）。所以只认高置信的模式，不做「见到 token 这个词就报警」的宽匹配。
 */
const REDACT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // 带 sk- 前缀的密钥
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '<已脱敏:key>'],
  // JWT（三段点分）
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<已脱敏:jwt>'],
  // 常见会话 cookie 的键值对：按名字逐条列，覆盖 B 站 / Cloudflare / 通用 session。
  // 不用动态拼接的正则 —— 那个写法既难读，也容易在转义上出错。
  [/\bSESSDATA\s*=\s*[^\s;&"']{8,}/gi, 'SESSDATA=<已脱敏>'],
  [/\b__security_mc_1_s_sdk_cert_key\s*=\s*[^\s;&"']{8,}/gi, '__security_mc_1_s_sdk_cert_key=<已脱敏>'],
  [/\b(__cf_bm|__cflb|cf_clearance|csrftoken|sessionid|bili_jct|DedeUserID|JSESSIONID|PHPSESSID)\s*=\s*[^\s;&"']{8,}/gi, '$1=<已脱敏>'],
  // 请求头：半角与【全角】冒号都要吃（中文输入法很常见）
  [/\b(authorization|cookie)\s*[:：]\s*[^\r\n]{8,}/gi, '$1: <已脱敏>'],
  // 裸 Bearer token（没有 header 前缀时也要抓）
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer <已脱敏>'],
  // 查询串里的签名 / token / 云存储签名
  [/([?&](?:sig|signature|token|access_token|api_key|key|auth|X-Amz-Signature|X-Amz-Credential)=)[^\s&#"']{8,}/gi, '$1<已脱敏>'],
  // password= / passwd= / pwd=
  [/\b(pass(?:word|wd)?|pwd)\s*=\s*[^\s;&"']{6,}/gi, '$1=<已脱敏>'],
  // 制表符分隔的 cookie 表（DevTools 里直接复制出来的那种，没有等号）
  [/\b(SESSDATA|__cf_bm|__security_mc_1_s_sdk_cert_key|csrftoken|sessionid)\t[^\t\r\n]{8,}/gi, '$1\t<已脱敏>'],
  // 🩸 裸长串只洗「确实像密钥」的，**宁可漏也不误杀** —— 这层存的是用户原话，
  // 误杀会毁掉记忆内容（2026-10-28 独立复核实测：原来的宽口径把 709 条 session id / 59 条
  // git SHA 都当秘密洗了，占真实原话的 7.14%，与本节自己写的「宁可精确」相反）。
  //   · hex 只洗 64 位（SHA-256 级密钥）；32 位（MD5）/40 位（git SHA）多是标识符，放过
  //   · base64 要求**同时含大小写和数字** —— 真 token 如此，普通长标识符通常不是
  [/\b[0-9a-f]{64}\b/gi, '<已脱敏:hex>'],
  [/\b(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[0-9])[A-Za-z0-9+/_-]{40,}={0,2}\b/g, '<已脱敏:b64>'],
]

function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of REDACT_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

function shortSessionId(sessionId: string): string {
  return sessionId.replace(/^session-/, '').slice(0, 8)
}

export function scanSessions(opts: ScanOptions = {}): ScanResult {
  const errors: string[] = []
  const utterances: Utterance[] = []
  const usedIds = new Set<string>()

  const root = opts.sessionsRoot ?? defaultSessionsRoot()
  const skipSubagent = opts.skipSubagent ?? true
  const retentionDays = opts.retentionDays ?? 30
  const sinceDays = opts.sinceDays ?? null
  const cutoff = sinceDays === null ? null : Date.now() - sinceDays * 86_400_000

  let filesScanned = 0
  let filesSkipped = 0
  let framesScanned = 0

  if (root === '') {
    errors.push('sessions root could not be resolved; pass scan({ sessionsRoot }) explicitly')
    return { utterances, filesScanned, filesSkipped, framesScanned, errors }
  }

  const files = findSessionFiles(root, errors)

  for (const file of files) {
    try {
      const info = statSync(file)
      if (cutoff !== null && info.mtimeMs < cutoff) {
        filesSkipped += 1
        continue
      }
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`)
      filesSkipped += 1
      continue
    }

    let buf: Buffer
    try {
      buf = readFileSync(file)
    } catch (err) {
      errors.push(`${file}: ${(err as Error).message}`)
      filesSkipped += 1
      continue
    }

    const frames = decodeFrames(file, buf, errors)
    framesScanned += frames.length

    const presence = readPresence(frames)
    if (skipSubagent && presence.origin === 'subagent') {
      filesSkipped += 1
      continue
    }

    const sessionId = presence.sessionId ?? file.replace(/[\\/]session\.v\d+\.jsonl\.zstd$/, '').split(/[\\/]/).pop() ?? 'unknown'
    const sidShort = shortSessionId(sessionId)
    filesScanned += 1

    for (const { frame, event } of iterEvents(frames)) {
      if (event.type !== 'user/message') continue
      if (event.data?.source?.kind !== 'user') continue

      const saidAt = typeof event.time === 'number' ? event.time : NaN
      if (!Number.isFinite(saidAt)) {
        errors.push(`${file}: user message without a numeric time at frame ${frame}`)
        continue
      }

      const text = normaliseText(blocksToText(event.data.content))
      if (text === null) continue

      let id = `${sidShort}-${saidAt}`
      if (usedIds.has(id) && typeof event.seq === 'number') {
        id = `${id}-${event.seq}`
      }
      if (usedIds.has(id)) {
        errors.push(`${file}: duplicate utterance id ${id} at frame ${frame}`)
        continue
      }
      usedIds.add(id)

      utterances.push({
        id,
        // 写入前脱敏：存下来就是风险，不能只靠读时过滤。
        text: redact(text),
        saidAt,
        sessionId,
        frameSeq: frame,
        // 按保留期算淡出时刻：过了这个点，默认查询就看不到它了，
        // 但数据还在（includeExpired 仍可取回）。null = 永不过期。
        validUntil: retentionDays > 0 ? saidAt + retentionDays * 86_400_000 : null,
      })
    }
  }

  return { utterances, filesScanned, filesSkipped, framesScanned, errors }
}


