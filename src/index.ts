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
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openStore } from './db.js'
import { buildEchoTool } from './tool.js'
import { scanSessions } from './scan.js'
import type { EchoStore } from './types.js'

export const name = 'dsh-memory-echo'
export const inject = ['tools']

/**
 * 插件配置（显式默认值，不引入 schema 库）。
 *
 * 刻意不用 schemastery：它是运行时依赖，而这里只有 5 个字段 ——
 * 为了配置校验把整个包拖进运行时依赖，会让"零依赖"这个卖点作废。
 */
export interface EchoConfig {
  /** 是否启用。关闭后不注册工具、不扫描。 */
  enabled: boolean
  /** 库的基础目录；空表示 `$DSH_HOME/data/dsh-memory-echo`。 */
  dbDir: string
  /** 会话日志根目录；空表示 `$DSH_HOME/sessions`。 */
  sessionsRoot: string
  /** 启动时是否做一次增量扫描。 */
  autoScan: boolean
  /** 增量扫描回看天数。 */
  autoScanDays: number
}

/** 宿主读这个常量做配置界面；纯对象即可，不需要 schema 库。 */
export const Config = {
  enabled: true,
  dbDir: '',
  sessionsRoot: '',
  autoScan: true,
  autoScanDays: 7,
} satisfies EchoConfig

/** 合并用户配置与默认值。 */
export function resolveConfig(input: Partial<EchoConfig> = {}): EchoConfig {
  return {
    enabled: input.enabled ?? Config.enabled,
    dbDir: input.dbDir ?? Config.dbDir,
    sessionsRoot: input.sessionsRoot ?? Config.sessionsRoot,
    autoScan: input.autoScan ?? Config.autoScan,
    autoScanDays: input.autoScanDays ?? Config.autoScanDays,
  }
}

/**
 * 解析库路径。
 *
 * 默认落在 DSH 数据目录（`$DSH_HOME/data/dsh-memory-echo`），**不用 process.cwd()** ——
 * 宿主进程的 cwd 是应用安装目录：不可控、升级会抹掉、且所有工作区会共用一个库。
 * 传 base 可覆盖（测试用）。
 *
 * ⚠️ 这里只解析路径、不建目录：建目录失败该由 apply 决定怎么降级，
 * 而不是让插件在加载阶段就抛出去。
 */
export function echoDbPath(base?: string | null): string {
  const root = base ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(root, 'data', 'dsh-memory-echo', 'echo.db')
}

/**
 * 插件入口。
 *
 * 失败策略：扫描失败不影响工具注册（查询仍然可用），但会把错误写进日志。
 * 这与「查不到必须说清楚」一致：能查就一直能查，不能查要说原因。
 */
export function apply(ctx: Context, input: Partial<EchoConfig> = {}): void {
  const config = resolveConfig(input)
  if (!config.enabled) return

  const dbPath = echoDbPath(config.dbDir === '' ? null : config.dbDir)

  // 目录建不出来时不要抛：工具仍然注册，查询时会返回 unavailable。
  // 插件加载失败比"能装但库不可用"更糟 —— 后者用户至少能看到原因。
  let store: EchoStore
  try {
    mkdirSync(join(dbPath, '..'), { recursive: true })
    store = openStore(dbPath)
  } catch (error) {
    ctx.logger?.warn?.(`dsh-memory-echo: 无法准备数据目录 ${dbPath}: ${error instanceof Error ? error.message : String(error)}`)
    store = openStore(':memory:')
  }

  ctx.tools.register(buildEchoTool(store))

  ctx.on('dispose', () => {
    try {
      store.close()
    } catch {
      /* 关闭失败不影响宿主退出 */
    }
  })

  if (config.autoScan) {
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
