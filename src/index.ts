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
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openStore } from './db.js'
import { buildEchoTool } from './tool.js'
import { scanSessions } from './scan.js'

export const name = 'dsh-memory-echo'
export const inject = ['tools']

/** 插件配置。 */
export const Config = z.object({
  /** 是否启用。关闭后不注册工具、不扫描。 */
  enabled: z.boolean().default(true).description('Enable the plugin.'),
  /** 数据库目录（相对工作区根）。 */
  dbDir: z.string().default('.dsh-memory-echo').description('Directory for the SQLite file, relative to the workspace.'),
  /** 会话日志根目录；留空则使用 $DSH_HOME/sessions 下的全部工作区。 */
  sessionsRoot: z.string().default('').description('Root of DSH session logs. Empty means $DSH_HOME/sessions.'),
  /** 启动时是否做一次增量扫描。 */
  autoScan: z.boolean().default(true).description('Run an incremental scan when the plugin loads.'),
  /** 增量扫描回看天数。 */
  autoScanDays: z.number().default(7).description('How many days back the automatic scan looks.'),
})

export type EchoConfig = {
  enabled: boolean
  dbDir: string
  sessionsRoot: string
  autoScan: boolean
  autoScanDays: number
}

/**
 * 解析库路径。workspace 由调用方给出，便于测试与多工作区。
 */
export function echoDbPath(workspace: string, dbDir: string): string {
  const dir = join(workspace, dbDir)
  mkdirSync(dir, { recursive: true })
  return join(dir, 'echo.db')
}

/**
 * 插件入口。
 *
 * 失败策略：扫描失败不影响工具注册（查询仍然可用），但会把错误写进日志。
 * 这与「查不到必须说清楚」一致：能查就一直能查，不能查要说原因。
 */
export function apply(ctx: Context, config: EchoConfig): void {
  if (!config?.enabled) return

  const workspace = (ctx as unknown as { baseDir?: string }).baseDir ?? process.cwd()
  const dbPath = echoDbPath(workspace, config.dbDir)
  const store = openStore(dbPath)

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
