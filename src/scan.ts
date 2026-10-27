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
const TASK_BRIEF_HEAD = /^(?:先读\s*[A-Za-z]:|你是独立|你是[^\n]{0,12}(?:审查员|分析员|研究员))/

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
  if (text.length > 200 && TASK_BRIEF_HEAD.test(text)) return null
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
  // 常见会话 cookie 的键值对
  [/\b(__cf_bm|__cflb|cf_clearance|csrftoken|sessionid)\s*=\s*[^\s;&"']{8,}/gi, '$1=<已脱敏>'],
  // 请求头
  [/\b(authorization|cookie)\s*:\s*[^\r\n]{8,}/gi, '$1: <已脱敏>'],
  // 查询串里的签名 / token
  [/([?&](?:sig|signature|token|access_token|api_key|key|auth)=)[^\s&#"']{8,}/gi, '$1<已脱敏>'],
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
        // 扫描进来的原话默认不过期；"淡忘"由上层按需写入 validUntil 表达。
        validUntil: null,
      })
    }
  }

  return { utterances, filesScanned, filesSkipped, framesScanned, errors }
}

export default scanSessions
