/**
 * 宿主模块的最小声明。
 *
 * 为什么需要它：`@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` 是 DSH 运行时
 * 提供的，本地 `npm install` 拿不到它们的类型 ⇒ `tsc` 直接报 TS2307 挂掉，
 * 等于**整个仓库的类型检查不可用**（2026-10-28 实测：`tsc` 因 TS2688 根本起不来）。
 *
 * 这里只声明本项目**实际用到**的那几个成员，目的是让 `tsc` 能跑起来、
 * 从而抓住**自己代码**的类型错。
 *
 * ⚠️ 这不是宿主的真实类型 —— 宿主 API 变了这里不会报。
 * 真正的契约校验靠"注册冒烟"（apply() 真的跑一次），那比类型更硬。
 */

declare module '@deepseek-ai/cordis' {
  export interface Context {
    tools: {
      register(tool: unknown): void
    }
    on(event: string, handler: () => void): void
    logger?: {
      info?: (message: string) => void
      warn?: (message: string) => void
    }
  }
}

declare module '@deepseek-ai/dsh-tools' {
  /** 宿主认的 JSON Schema 子集（见 dsh-tools 的 assertSupportedJsonSchema）。 */
  export type JsonSchema = Record<string, unknown>

  export interface ToolDefinition {
    name: string
    description: string
    parameters: JsonSchema
    output: {
      schema: JsonSchema
      render: (args: unknown, value: unknown) => unknown
    }
    execute: (args: unknown) => Promise<unknown>
  }
}
