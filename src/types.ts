/**
 * dsh-memory-echo —— 共享类型定义（三路协作的唯一接口契约）
 *
 * 定位：**原话级短期记忆**。存在的理由是长期记忆库只存提炼后的结论，
 * 而「我上次说过什么」这类问题需要的是原话。
 *
 * 设计原则（2026-10-28 与用户逐条确认）：
 *   1. 存全文 —— 不做有损压缩（压缩会丢动词/否定词，把"别点 X"读成"要处理 X"）
 *   2. 不自动注入 —— 只在被问到时查（执行途中不会停下来查，预置反而会掐死触发）
 *   3. miss 必须三分 —— 绝不把「取不到」说成「没说过」
 *   4. 只存用户说的话 —— 不存 AI 回复、不存工具输出、不存子代理任务书
 */

/** 一条原话。 */
export interface Utterance {
  /** 稳定 id：`<sessionId 短>` + `-` + `<saidAt 毫秒>`，同一条重复扫描得到同一个 id。 */
  id: string
  /** 原话正文（逐字，不减一个字）。 */
  text: string
  /** 说话的时刻（毫秒时间戳）。 */
  saidAt: number
  /** 来自哪个会话。 */
  sessionId: string
  /** 在会话日志里是第几帧（用于溯源；扫不到时为 null）。 */
  frameSeq: number | null
  /**
   * 失效时刻（毫秒）；null 表示仍然有效。
   *
   * 语义是「**淡出，而不是删除**」：过期的记录仍然留在库里，
   * 默认查询看不到它，但带上 `includeExpired` 仍然能取回。
   * 这样「我记不清了」和「数据被抹了」是两件事。
   */
  validUntil: number | null
}

/** 一次扫描的结果。 */
export interface ScanResult {
  utterances: Utterance[]
  filesScanned: number
  filesSkipped: number
  framesScanned: number
  /** 单帧解压失败等非致命问题；不中断扫描，但要报出来。 */
  errors: string[]
}

/** 扫描参数。 */
export interface ScanOptions {
  /** 会话日志根目录；null 表示用 `$DSH_HOME/sessions` 下的全部工作区。 */
  sessionsRoot?: string | null
  /** 只扫 mtime 在最近 N 天内的文件；null 表示全量。 */
  sinceDays?: number | null
  /** 是否跳过子代理会话（默认 true）。 */
  skipSubagent?: boolean
}

/**
 * 查询不到的原因 —— 🩸 三种必须分开答，混成一句"没有"就是把运维故障
 * 伪装成记忆缺失。
 */
export type MissReason =
  /** 真的没有：库里没有匹配的记录。 */
  | 'not-found'
  /** 有记录但取不到：数据库打不开 / 查询失败。 */
  | 'unavailable'
  /** 库是空的（还没扫描过），与"没有"是两回事。 */
  | 'empty-db'
  /**
   * 有记录，但都已经淡忘（valid_until 过了），默认查询看不到。
   *
   * 🩸 这一种必须单独存在：把「淡忘了」说成「没说过」，
   * 正是这套东西最不能犯的错（设计约束 3）。
   */
  | 'expired'

/** 时间分桶：按**滚动窗口**切，不按日历日切。 */
export interface EchoBucket {
  /** 桶的起始时刻（毫秒，含）。 */
  from: number
  /** 桶的结束时刻（毫秒，不含）。 */
  to: number
  /** 这一段里有几条原话。 */
  count: number
  /** 几条代表性的原话（最多 3 条），用于让人先看一眼再决定要不要细看。 */
  samples: Utterance[]
}

/** 一次查询的结果。 */
export interface EchoResult {
  /** 命中的原话，按时间倒序。`mode='bucket'` 时为空数组。 */
  hits: Utterance[]
  /** 命中总数（可能大于 hits.length）。 */
  total: number
  /** `mode='bucket'` 时的分桶结果；其他模式为 undefined。 */
  buckets?: EchoBucket[]
  /** 没有命中时的原因；有命中时为 null。 */
  miss: MissReason | null
  /** 给人看的说明，可直接回给用户。 */
  note: string
}

/** 查询参数。 */
export interface EchoQuery {
  /** 关键词（走 bigram 相似度）；空则不限。 */
  query?: string
  /** 只要最近 N 天。 */
  days?: number
  /** 时间下界（毫秒，含）。 */
  from?: number
  /** 时间上界（毫秒，含）。 */
  to?: number
  /** 最多返回几条，默认 10。 */
  limit?: number
  /**
   * 是否连**已失效**的记录一起查。
   *
   * 默认 false：正常提问只该看到还记着的那些。
   * 想看"一个月之前的"就打开它 —— 数据一直在，只是默认不参与检索。
   */
  includeExpired?: boolean
  /**
   * 返回形态：`list`（默认，逐条原话）或 `bucket`（按天聚合）。
   *
   * 聚合用的是**滚动窗口**（从当前时刻往回数 N×24 小时），不是日历日 ——
   * 跨午夜连续工作的一整晚会落在同一个桶里，不会被 0 点切成两半。
   */
  mode?: 'list' | 'bucket'
}

/** 存储层接口（由 db.ts 实现）。 */
export interface EchoStore {
  /** 写入一批原话；同 id 覆盖。返回实际写入条数。 */
  upsert(items: Utterance[]): number
  /** 查询。 */
  query(q: EchoQuery): EchoResult
  /** 库里有多少条。 */
  count(): number
  /** 关闭。 */
  close(): void
}

/** 扫描器接口（由 scan.ts 实现）。 */
export type Scanner = (opts?: ScanOptions) => ScanResult
