/**
 * dsh-memory-echo —— 工具层。
 *
 * 这里只做包装：把查询结果整理成模型可读的形状，并负责渲染。
 * 真正的读写逻辑全部在 EchoStore 里（见 db.ts），本文件不重复实现查询。
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { EchoQuery, EchoResult, EchoStore, Utterance } from './types.js'

const DESCRIPTION = [
  '查询用户过去说过的原话（逐字文本），用于回答「我上次说过什么」「这句话以前提过吗」这类问题。',
  '这是检索，不是总结：返回的是用户当时说的句子本身，不是提炼后的结论。',
  '没有命中时会说明原因（真的没有 / 暂时不可用 / 库为空），三种情况含义不同，不要一律回答成「没有」。',
  '🩸 query 必须是 2~4 个字的实体词（「硬盘」「报错」「深色」），不能直接传整句：整句会被切成多个片段、要求每个都命中，反而一条都查不到。想把「我上次说的那个方案」变成查询，就传「方案」。',
].join('')

const PARAM_DESCRIPTION = {
  query: '查什么：一个 2~4 个字的实体词（如「硬盘」「报错」「深色」）。⚠️ 不要传整句 —— 多词查询要求每个片段都命中，整句几乎必然查不到。留空表示不按内容过滤、只按时间范围取最近的原话。',
  days: '只查最近多少天，例如 7 表示最近一周。不传表示不限时间。',
  limit: '最多返回几条，默认 10，上限 50。',
  mode: 'list（默认）逐条返回原话；bucket 按时间段聚合，只给「哪一段有几条」加几条样例 —— 问「昨天聊了啥」这种范围问题时用它，别一次性拉几百条。',
  includeExpired: '是否连已经淡忘的原话一起查。默认 false，只想看更早的内容时才打开。',
} as const

/** 渲染用的时间格式：本地时区的 YYYY-MM-DD HH:mm。 */
function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function toOutput(result: EchoResult): {
  note: string
  total: number
  miss: EchoResult['miss']
  hits: Array<{
    id: string
    text: string
    saidAt: number
    sessionId: string
    frameSeq: number | null
  }>
  buckets?: Array<{ from: number; to: number; count: number; samples: string[] }>
} {
  return {
    note: result.note,
    total: result.total,
    miss: result.miss,
    hits: result.hits.map((hit: Utterance) => ({
      id: hit.id,
      text: hit.text,
      saidAt: hit.saidAt,
      sessionId: hit.sessionId,
      frameSeq: hit.frameSeq,
    })),
    ...(result.buckets === undefined
      ? {}
      : {
          buckets: result.buckets.map((bucket) => ({
            from: bucket.from,
            to: bucket.to,
            count: bucket.count,
            samples: bucket.samples.map((item) => item.text),
          })),
        }),
  }
}

/**
 * 构造 `memory_echo` 工具。
 *
 * store 由调用方注入（通常是进程级单例），这样工具本身无状态、
 * 便于在测试里换成内存实现。
 */
export function buildEchoTool(store: EchoStore): ToolDefinition {
  return {
    name: 'memory_echo',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: PARAM_DESCRIPTION.query },
        days: { type: 'integer', minimum: 1, maximum: 3650, description: PARAM_DESCRIPTION.days },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: PARAM_DESCRIPTION.limit },
    mode: {
      type: 'string',
      enum: ['list', 'bucket'],
      default: 'list',
      description: PARAM_DESCRIPTION.mode,
    },
    includeExpired: { type: 'boolean', default: false, description: PARAM_DESCRIPTION.includeExpired },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['note', 'hits', 'total', 'miss'],
        properties: {
          note: {
            type: 'string',
            description: '可直接回给用户的一句话说明。',
          },
          total: {
            type: 'integer',
            description: '命中的总条数，可能大于返回的 hits 条数。',
          },
          miss: {
            type: ['string', 'null'],
            enum: ['not-found', 'unavailable', 'empty-db', null],
            description: '没有命中的原因；有命中时为 null。',
          },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'text', 'saidAt', 'sessionId'],
              properties: {
                id: { type: 'string', description: '记录标识。' },
                text: { type: 'string', description: '用户当时说的原话，逐字。' },
                saidAt: { type: 'integer', description: '说话时刻，毫秒时间戳。' },
                sessionId: { type: 'string', description: '来自哪个会话。' },
                frameSeq: {
                  type: ['integer', 'null'],
                  description: '在会话日志中的帧序号，用于溯源；未知时为 null。',
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const v = value as
          | { note?: unknown; total?: unknown; miss?: unknown; hits?: unknown }
          | null
          | undefined

        const note = typeof v?.note === 'string' ? v.note : ''
        const hits = Array.isArray(v?.hits) ? v.hits : []
        const lines: string[] = []

        if (note !== '') lines.push(note)

        for (const raw of hits) {
          if (raw === null || typeof raw !== 'object') continue
          const hit = raw as { text?: unknown; saidAt?: unknown }
          const text = typeof hit.text === 'string' ? hit.text : ''
          const saidAt = typeof hit.saidAt === 'number' ? hit.saidAt : 0
          lines.push(`- [${formatTime(saidAt)}] ${text}`)
        }

        return lines.join('\n')
      },
    },
    async execute(args: unknown) {
      const input = (args ?? {}) as {
        query?: unknown
        days?: unknown
        limit?: unknown
        mode?: unknown
        includeExpired?: unknown
      }

      const query: EchoQuery = {
        query: typeof input.query === 'string' ? input.query : undefined,
        days: typeof input.days === 'number' ? input.days : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
        mode: input.mode === 'bucket' ? 'bucket' : 'list',
        includeExpired: input.includeExpired === true,
      }

      return toOutput(store.query(query))
    },
  }
}
