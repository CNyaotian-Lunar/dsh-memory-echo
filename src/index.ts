/**
 * dsh-memory-echo —— 原话级短期记忆（host 端入口）。
 *
 * 它解决的问题：长期记忆库只存提炼后的结论，而「我上次说过什么」这类问题
 * 需要的是原话。本插件保留真正说过的话，按需查询，不自动注入上下文。
 *
 * 设计约束（2026-10-28 与用户逐条确认）：
 *   1. 存全文，不做有损压缩 —— 压缩会丢动词与否定词。
 *   2. 不自动注入 —— 执行途中不会停下来查；预置反而会掐死触发。
 *   3. 查询失败必须区分原因，不得把「取不到」说成「没说过」。
 *   4. 只存用户说的话，不存助手回复、工具输出与子代理任务书。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openStore } from './db.js'
import { buildEchoTool } from './tool.js'
import { scanSessions } from './scan.js'
import type { EchoStore } from './types.js'

export const name = 'dsh-memory-echo'
export const inject = ['tools']

/**
 * 诊断埋点：把阶段与错误写进文件。
 *
 * 为什么需要：插件在 DSH 里标「异常」但 UI 点不开，宿主日志也找不到，
 * 只能让插件自己在每个阶段留下痕迹。定位完可以删掉这几处调用。
 */
// 只有显式设置 DSH_ECHO_DIAG 才写（默认零副作用、零文件）。
// 值可以是文件路径，也可以是相对 $DSH_HOME 的名字。
function diagFile(): string | null {
  const target = process.env.DSH_ECHO_DIAG
  if (typeof target !== 'string' || target.length === 0) return null
  if (target === '1') {
    const root = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    return join(root, 'cache', 'dsh-memory-echo-diag.log')
  }
  return target
}

function diag(stage: string, detail?: unknown): void {
  const file = diagFile()
  if (file === null) return
  try {
    const tail =
      detail === undefined
        ? ''
        : ' :: ' + (detail instanceof Error ? (detail.stack ?? detail.message) : String(detail))
    mkdirSync(join(file, '..'), { recursive: true })
    appendFileSync(file, `[${new Date().toISOString()}] ${stage}${tail}\n`, 'utf8')
  } catch {
    /* 诊断本身绝不许影响主流程 */
  }
}

// 模块顶层：走到这里说明 import 全部成功
diag('module-loaded')

/**
 * 插件配置（显式默认值，不引入 schema 库）。
 *
 * 刻意不用 schemastery：它是运行时依赖，而这里只有 5 个字段 ——
 * 为了配置校验把整个包拖进运行时依赖，会让"零依赖"这个卖点作废。
 */
export interface EchoConfig {
  /** 是否启用。关闭后不注册工具、不扫描。 */
  enabled: boolean
  /** 库的基础目录（工作区根）；空表示跟随当前工作区。 */
  dbDir: string
  /** 会话日志根目录；空表示 `$DSH_HOME/sessions`。 */
  sessionsRoot: string
  /** 启动时是否做一次增量扫描。 */
  autoScan: boolean
  /** 增量扫描回看天数。 */
  autoScanDays: number
}

/**
 * 插件配置的 schema。
 *
 * 🩸 必须是 schemastery 的 `Schema`，不能是纯对象 —— 宿主 loader 会用它
 * 生成默认 config 并写进运行时 `cordis.yml`。给纯对象时宿主读不到 schema，
 * 该条目不会带 config、插件也不会被 apply（2026-10-28 实测：装上了但工具不存在、库不建）。
 * 这是拿"零依赖"换"装不上"的教训。
 */
export const Config = z.object({
  /** 是否启用。关闭后不注册工具、不扫描。 */
  enabled: z.boolean().default(true).description('Enable the plugin.'),
  /** 库的基础目录（工作区根）；空表示跟随当前工作区。 */
  dbDir: z.string().default('').description('Base directory for the database. Empty means the current workspace.'),
  /** 会话日志根目录；留空则使用 $DSH_HOME/sessions。 */
  sessionsRoot: z.string().default('').description('Root of DSH session logs.'),
  /** 启动时是否做一次增量扫描。 */
  autoScan: z.boolean().default(true).description('Run an incremental scan when the plugin loads.'),
  /** 增量扫描回看天数。 */
  autoScanDays: z.number().default(7).description('How many days back the automatic scan looks.'),
})

/**
 * 默认值（独立于 `Config` 存一份）。
 *
 * 🩸 不能从 `Config` 上读 `.enabled` —— 它现在是 schemastery 的 Schema，不是普通对象；
 * 读属性只会拿到 undefined。默认值必须是这里这份可读的字面量。
 */
const DEFAULTS: EchoConfig = {
  enabled: true,
  dbDir: '',
  sessionsRoot: '',
  autoScan: true,
  autoScanDays: 7,
}

/** 合并用户配置与默认值。 */
export function resolveConfig(input: Partial<EchoConfig> = {}): EchoConfig {
  return {
    enabled: input.enabled ?? DEFAULTS.enabled,
    dbDir: input.dbDir ?? DEFAULTS.dbDir,
    sessionsRoot: input.sessionsRoot ?? DEFAULTS.sessionsRoot,
    autoScan: input.autoScan ?? DEFAULTS.autoScan,
    autoScanDays: input.autoScanDays ?? DEFAULTS.autoScanDays,
  }
}

/**
 * 解析库路径。
 *
 * 默认落在**工作区**下（`<workspace>/.dsh-memory-echo/echo.db`）—— 库跟着工作区走，
 * 重装 DSH 不会丢。工作区来自 `session.header.cwd`，拿不到时才退回
 * `$DSH_HOME/data/dsh-memory-echo`。
 *
 * 🩸 绝不用 `process.cwd()`：那是宿主进程的安装目录，不可控、升级会被抹掉，
 * 而且所有工作区会共用一个库。
 *
 * ⚠️ 这里只解析路径、不建目录：建目录失败该由 apply 决定怎么降级，
 * 而不是让插件在加载阶段就抛出去。
 */
export function echoDbPath(dir?: string | null): string {
  // 传了目录就用它（完整目录，不再拼子路径）
  if (typeof dir === 'string' && dir.length > 0) {
    return join(dir, 'echo.db')
  }
  const root = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(root, 'data', 'dsh-memory-echo', 'echo.db')
}

/** 从宿主 Session 里取工作区；取不到返回 null。 */
/**
 * 库是**全局的**，不按工作区分。
 *
 * 🩸 曾经想按工作区定位，但那做不到也别做：
 * ① `ctx.session` 在 `apply` 里读会抛 `cannot get property "session" without inject`；
 * ② `DSH_WORKSPACE` 这个环境变量**宿主根本不设**（2026-10-28 实测：env 为空，
 *    宿主 129 个包里递归 grep 0 命中）。
 *
 * 而且**按工作区分开本身就不对**：这层存的是"你说过的原话"，
 * 换个工作区并不改变"你"是谁。所有工作区的原话放一个库才是符合直觉的。
 *
 * ⇒ 路径只由 `Config.dbDir` 决定（profile patch 里覆盖成本机路径），
 *   兜底 `$DSH_HOME/data/dsh-memory-echo/`。
 */

/**
 * 插件入口。
 *
 * 失败策略：扫描失败不影响工具注册（查询仍然可用），但会把错误写进日志。
 * 这与「查不到必须说清楚」一致：能查就一直能查，不能查要说原因。
 */
export function apply(ctx: Context, input: Partial<EchoConfig> = {}): void {
  diag('apply-enter', JSON.stringify(input))
  try {
    applyInner(ctx, input)
    diag('apply-ok')
  } catch (error) {
    diag('apply-FAILED', error)
    throw error
  }
}

/** 真正的实现；外面那层只负责留痕。 */
function applyInner(ctx: Context, input: Partial<EchoConfig> = {}): void {
  const config = resolveConfig(input)
  if (!config.enabled) return

  const dbPath = echoDbPath(config.dbDir === '' ? null : config.dbDir)

  // 目录建不出来时不要抛：工具仍然注册，查询时会返回 unavailable。
  // 插件加载失败比"能装但库不可用"更糟 —— 后者用户至少能看到原因。
  let store: EchoStore
  let degraded = false
  try {
    mkdirSync(join(dbPath, '..'), { recursive: true })
    store = openStore(dbPath)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(`dsh-memory-echo: 无法准备数据目录 ${dbPath}: ${reason}`)
    // 🩸 不撒谎：库建不出来时**不要**降级成内存库 —— 那样查询会报 `empty-db`
    // （"尚未扫描任何会话"），用户以为记忆在工作，重启才发现全丢。
    // 这里给一个永远回答 `unavailable` 的 store，把真实原因带出去。
    degraded = true
    store = {
      upsert: () => 0,
      count: () => 0,
      close: () => {},
      query: () => ({
        hits: [],
        total: 0,
        miss: 'unavailable' as const,
        note: `库不可用：${reason}。数据目录 ${dbPath} 建不出来。`,
      }),
    }
  }

  ctx.tools.register(buildEchoTool(store))

  ctx.on('dispose', () => {
    try {
      store.close()
    } catch {
      /* 关闭失败不影响宿主退出 */
    }
  })

  // 降级时不扫描：扫进一个内存库等于白干，还会在日志里报「wrote N」让人误以为在工作。
  if (config.autoScan && !degraded) {
    // 启动后异步补一次：不阻塞插件加载，失败只记日志。
    queueMicrotask(() => {
      try {
        const result = scanSessions({
          sessionsRoot: config.sessionsRoot || null,
          sinceDays: config.autoScanDays,
          skipSubagent: true,
        })
        const written = store.upsert(result.utterances)
        if (result.errors.length > 0) {
          ctx.logger?.warn?.(`dsh-memory-echo: scan finished with ${result.errors.length} error(s); first: ${result.errors[0]}`)
        }
        ctx.logger?.info?.(`dsh-memory-echo: scanned ${result.filesScanned} file(s), wrote ${written} utterance(s)`)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-memory-echo: auto scan failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }
}
