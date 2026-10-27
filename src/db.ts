/**
 * dsh-memory-echo —— 存储层。
 *
 * 只做一件事：把「用户逐字说过的话」存下来，按时间与关键词取回。
 * 不提炼、不摘要、不生成 —— 任何有损压缩都会丢掉动词与否定词，
 * 把「别点这个按钮」压成「处理这个按钮」。
 *
 * 设计约束：
 *   1. 零外部依赖，只用 Node 内置的 node:sqlite（Node 22.13+ 提供 DatabaseSync）。
 *   2. 打不开库时不得抛错穿透到调用方，而是让查询报 unavailable，
 *      这样上层能区分「没有记录」与「取不到记录」。
 *   3. 重复扫描是幂等的：同 id 走覆盖，不产生重复行。
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { EchoBucket, EchoQuery, EchoResult, EchoStore, Utterance } from './types.js'

/** 多 token 查询要求的最小覆盖率（命中的 token 数 / 查询 token 数）。 */
const MIN_COVERAGE = 0.5

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

const NOTE_UNAVAILABLE = '记忆库当前不可用，已有记录暂时无法读取。'
const NOTE_EMPTY_DB = '记忆库为空，尚未扫描任何会话。'
const NOTE_NOT_FOUND = '没有找到匹配的历史原话。'

const SCHEMA = `
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
`

/**
 * 老库补列。
 *
 * 这张表是「只加列、不改语义」演进的 —— 早期版本没有 valid_until。
 * 用 PRAGMA table_info 判一下再 ALTER，比 `ALTER TABLE ... IF NOT EXISTS` 更通用
 * （SQLite 不支持后者）。
 */
const MIGRATE_VALID_UNTIL = `
  SELECT COUNT(*) AS n FROM pragma_table_info('utterance') WHERE name = 'valid_until'
`

interface Row {
  id: string
  text: string
  said_at: number
  session_id: string
  frame_seq: number | null
  valid_until: number | null
}

/** 把一段文本切成可比较的 token 计数：中日韩用相邻双字，拉丁用单词。 */
function tokenize(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  const normalized = text.toLowerCase()

  for (const match of normalized.matchAll(/[a-z0-9_]+/g)) {
    const key = `w:${match[0]}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const key = run.slice(i, i + 2)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  return counts
}

/**
 * 把按时间倒序的原话切成**滚动窗口**桶。
 *
 * ⚠️ 滚动，不按日历日：从「现在」往回数，每 windowMs 一个桶。
 * 使用者经常跨午夜连续工作 —— 按日历日 0 点切会把一整夜劈成两天，
 * 那正好是「昨天聊啥」最容易问错的地方。
 */
function bucketize(rows: Row[], windowMs: number): EchoBucket[] {
  const buckets: EchoBucket[] = []
  const now = Date.now()
  let index = 0
  for (let step = 0; index < rows.length; step += 1) {
    const to = now - step * windowMs
    const from = to - windowMs
    const within: Row[] = []
    while (index < rows.length && (rows[index] as Row).said_at >= from) {
      within.push(rows[index] as Row)
      index += 1
    }
    if (within.length > 0) {
      buckets.push({ from, to, count: within.length, samples: within.slice(0, 3).map(toUtterance) })
    }
  }
  return buckets
}

/** 余弦相似度；任一向量为空时返回 0。 */
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let normA = 0
  let normB = 0

  for (const v of a.values()) normA += v * v
  for (const v of b.values()) normB += v * v
  if (normA === 0 || normB === 0) return 0

  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const [k, v] of small) {
    const w = large.get(k)
    if (w !== undefined) dot += v * w
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

class SqliteEchoStore implements EchoStore {
  private db: DatabaseSync | null = null

  constructor(dbPath: string) {
    try {
      if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
      const db = new DatabaseSync(dbPath)
      // 写入次数少、读取频繁；WAL + NORMAL 兼顾并发读与落盘成本。
      db.prepare('PRAGMA journal_mode = WAL').get()
      db.prepare('PRAGMA synchronous = NORMAL').get()
      // 遇到锁竞争宁可放弃本次写入，也不长时间阻塞事件循环。
      db.prepare('PRAGMA busy_timeout = 200').get()
      db.exec(SCHEMA)
      // 老库补列：早期版本没有 valid_until。
      const hasColumn = db.prepare(MIGRATE_VALID_UNTIL).get() as unknown as { n: number }
      if (hasColumn.n === 0) db.exec('ALTER TABLE utterance ADD COLUMN valid_until INTEGER')
      this.db = db
    } catch {
      // 库打不开时保持 null，由查询返回 unavailable，不向调用方抛错。
      this.db = null
    }
  }

  upsert(items: Utterance[]): number {
    if (this.db === null || items.length === 0) return 0

    try {
      const stmt = this.db.prepare(
        `INSERT INTO utterance (id, text, said_at, session_id, frame_seq, valid_until)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           text = excluded.text,
           said_at = excluded.said_at,
           session_id = excluded.session_id,
           frame_seq = excluded.frame_seq,
           valid_until = excluded.valid_until`,
      )

      let written = 0
      this.db.exec('BEGIN')
      try {
        for (const item of items) {
          stmt.run(item.id, item.text, item.saidAt, item.sessionId, item.frameSeq, item.validUntil)
          written += 1
        }
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
      return written
    } catch {
      return 0
    }
  }

  query(q: EchoQuery): EchoResult {
    if (this.db === null) return this.miss('unavailable', NOTE_UNAVAILABLE)

    try {
      if (this.countRows() === 0) return this.miss('empty-db', NOTE_EMPTY_DB)

      const where: string[] = []
      const params: Array<string | number> = []

      if (q.from !== undefined) {
        where.push('said_at >= ?')
        params.push(q.from)
      }
      if (q.to !== undefined) {
        where.push('said_at <= ?')
        params.push(q.to)
      }
      // ⚠️ bucket 模式下 days 只表示「桶多宽」，不是「只看最近几天」。
      // 若在这里也过滤，days=1 会把更早的记录全裁掉 ⇒ 永远只出一个桶。
      if (q.days !== undefined && q.days > 0 && q.mode !== 'bucket') {
        where.push('said_at >= ?')
        params.push(Date.now() - q.days * 86_400_000)
      }

      // 默认只看还有效的：过期的仍然在库里，只是不参与检索。
      // 想翻更早的（或想看"已经淡忘的"）就带上 includeExpired。
      if (!q.includeExpired) {
        where.push('(valid_until IS NULL OR valid_until > ?)')
        params.push(Date.now())
      }

      const sql = `SELECT id, text, said_at, session_id, frame_seq, valid_until FROM utterance${
        where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
      } ORDER BY said_at DESC`

      const rows = this.db.prepare(sql).all(...params) as unknown as Row[]
      const limit = clampLimit(q.limit)

      // 聚合模式：先看「哪一段有话」，再决定要不要细看。
      // 提问方想「昨天聊了啥」时，直接吐几百条原话没有意义。
      if (q.mode === 'bucket') {
        const windowMs = (q.days ?? 1) * 86_400_000
        const buckets = bucketize(rows, windowMs)
        if (buckets.length === 0) return this.miss('not-found', NOTE_NOT_FOUND)
        const total = buckets.reduce((sum, item) => sum + item.count, 0)
        return {
          hits: [],
          total,
          buckets,
          miss: null,
          note: `共 ${total} 条原话，分布在 ${buckets.length} 段里（每段 ${q.days ?? 1} 天，从当前时刻往回数）。`,
        }
      }

      const keyword = q.query?.trim() ?? ''
      if (keyword === '') {
        if (rows.length === 0) {
          const expired = this.countExpired()
          if (!q.includeExpired && expired > 0) {
            return this.miss(
              'expired',
              `有 ${expired} 条已经淡忘了；默认不再返回。要翻更早的，带 includeExpired: true。`,
            )
          }
          return this.miss('not-found', NOTE_NOT_FOUND)
        }
        return {
          hits: rows.slice(0, limit).map(toUtterance),
          total: rows.length,
          miss: null,
          note: `共 ${rows.length} 条原话，返回最近 ${Math.min(rows.length, limit)} 条。`,
        }
      }

      const queryVector = tokenize(keyword)
      if (queryVector.size === 0) return this.miss('not-found', NOTE_NOT_FOUND)

      const matched: Array<{ row: Row; score: number }> = []
      for (const row of rows) {
        const documentVector = tokenize(row.text)

        let hit = 0
        for (const key of queryVector.keys()) {
          if (documentVector.has(key)) hit += 1
        }
        if (hit === 0) continue

        const coverage = hit / queryVector.size
        const similarity = cosine(queryVector, documentVector)

        // 单 token 查询（常见于两个字的关键词）覆盖率恒为 1，必须再用相似度兜一层，
        // 否则"好了""咋样了"这类高频短句会把所有含相同双字的记录都捞上来。
        // 单 token（常见于两个字的查询，如「硬盘」）不能用余弦：余弦会被原文长度稀释 ——
        // 「硬盘」对一条 20+ 字的原话只有约 0.22，永远过不了阈值，于是明明存在的原话
        // 被判成「没说过」。那是这层最不能犯的错（把缺数据伪装成没说过）。
        // 改成子串包含：命中即算，靠时间倒序把最近的排在前。宁可多捞，不可漏判。
        // ⚠️ 必须与分词同口径地忽略大小写 —— 分词走 toLowerCase()，若这里大小写敏感，
        // 查 `NAS` 就匹配不到文本里的 `nas`，又会退回「把取不到说成没说过」那个错。
        const passed =
          queryVector.size >= 2 ? coverage >= MIN_COVERAGE : row.text.toLowerCase().includes(keyword.toLowerCase())
        if (passed) matched.push({ row, score: 0.6 * coverage + 0.4 * similarity })
      }

      if (matched.length === 0) {
        // 区分「真没有」和「有过但淡忘了」—— 后者不是「没说过」。
        if (!q.includeExpired) {
          const expired = this.countExpired()
          if (expired > 0) {
            return this.miss(
              'expired',
              `有 ${expired} 条已经淡忘了；默认不再返回。要翻更早的，带 includeExpired: true。`,
            )
          }
        }
        return this.miss('not-found', NOTE_NOT_FOUND)
      }

      const hits = matched
        .slice()
        .sort((a, b) => b.row.said_at - a.row.said_at)
        .slice(0, limit)
        .map((m) => toUtterance(m.row))

      return {
        hits,
        total: matched.length,
        miss: null,
        note: `在 ${rows.length} 条候选原话中匹配到 ${matched.length} 条，返回最近 ${hits.length} 条。`,
      }
    } catch {
      return this.miss('unavailable', NOTE_UNAVAILABLE)
    }
  }

  count(): number {
    if (this.db === null) return 0
    try {
      return this.countRows()
    } catch {
      return 0
    }
  }

  close(): void {
    if (this.db === null) return
    try {
      this.db.close()
    } catch {
      // 关闭失败不影响调用方；进程退出时操作系统会回收句柄。
    } finally {
      this.db = null
    }
  }

  /**
   * 有多少条已经淡忘（`valid_until` 已过）。
   *
   * 不带关键词：它回答的是「库里有没有被淡忘的东西」，
   * 而不是「你要找的那条是不是被淡忘了」—— 后者做不到，
   * 而前者已经足够让回答从「没有」变成「有，但已经淡忘」。
   */
  private countExpired(): number {
    if (this.db === null) return 0
    try {
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM utterance WHERE valid_until IS NOT NULL AND valid_until <= ?')
        .get(Date.now()) as unknown as { n: number }
      return row.n
    } catch {
      return 0
    }
  }

  private countRows(): number {
    if (this.db === null) return 0
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM utterance').get() as unknown as
      | { n: number }
      | undefined
    return row?.n ?? 0
  }

  private miss(reason: Exclude<EchoResult['miss'], null>, note: string): EchoResult {
    return { hits: [], total: 0, miss: reason, note }
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  const value = Math.trunc(limit)
  if (value < 1) return 1
  if (value > MAX_LIMIT) return MAX_LIMIT
  return value
}

function toUtterance(row: Row): Utterance {
  return {
    id: row.id,
    text: row.text,
    saidAt: row.said_at,
    sessionId: row.session_id,
    frameSeq: row.frame_seq,
    validUntil: row.valid_until,
  }
}

/**
 * 打开（必要时创建）一个原话库。
 *
 * 打不开时不抛错：返回的 store 会让每次查询报 `unavailable`，
 * 让上层能够把「取不到」与「没说过」分开回答。
 */
export function openStore(dbPath: string): EchoStore {
  return new SqliteEchoStore(dbPath)
}
