# dsh-memory-echo

原话级短期记忆插件，用于 DeepSeek Harness。

长期记忆库保留的是提炼后的结论；本插件保留**真正说过的话**，用于回答"我上次说过什么"这类需要逐字原文的问题。它不自动注入上下文，只在被查询时取用。

---

Utterance-level short-term memory for DeepSeek Harness.

A long-term memory store keeps distilled conclusions. This plugin keeps **what was actually said**, so questions like "what did I say last time" can be answered from verbatim text. It never injects into the context automatically; it is read only on demand.

## 安装 / Install

```
dsh plugin add dsh-memory-echo
```

或从源码安装 / or from source:

```
git clone https://github.com/CNyaotian-Lunar/dsh-memory-echo.git
cd dsh-memory-echo
npm install && npm run build
dsh plugin add link:$(pwd)
```

## 它读什么、写什么 / What it reads and writes

| | |
| --- | --- |
| **读取 Reads** | `$DSH_HOME/sessions/**/session.v4.jsonl.zstd` —— 你的会话日志 / your session logs |
| **只取 Keeps only** | 你自己发的消息（`source.kind === 'user'`）；不取助手回复、工具输出、子代理任务书 / your own messages only |
| **写入 Writes** | `<workspace>/.dsh-memory-echo/echo.db`（SQLite，跟着工作区走 / next to your workspace）；拿不到工作区时退回 `$DSH_HOME/data/dsh-memory-echo/echo.db` |
| **网络 Network** | 无。插件不发任何请求 / none |

## 隐私 / Privacy

这是一个**本地**插件，但它确实会**把你说过的话复制一份到本地 SQLite**。三件事你需要知道。

This is a **local** plugin, but it does copy **what you said** into a local SQLite file. Three things you should know.

1. **写入前脱敏 / Redaction before writing**
   落库前会替换掉可能被直接使用的凭据：`sk-` 密钥、JWT、`Authorization` / `Cookie` 头、查询串里的 `token=` / `sig=` / `X-Amz-Signature=`、`password=`、常见会话 cookie（`SESSDATA`、`__cf_bm`、`jsessionid` 等）、以及 32 位以上 hex / 40 位以上 base64 长串。替换是**只换值、保留键名与上下文**，所以你仍看得出"当时在配一个 token"。
   Credentials are replaced before the row is written, keeping the key name and surrounding context.

   ⚠️ **这不是万无一失**：脱敏是按模式匹配的，模式没覆盖到的形态会原样入库。若你曾把密钥粘进对话，请视为已落盘。
   ⚠️ **Not a guarantee**: redaction is pattern-based. Anything not matching a pattern is stored verbatim.

2. **默认会淡出 / Fades by default**
   每条原话带一个 `valid_until`（默认 30 天，`retentionDays: 0` 可关闭）。到期后**默认查询看不到**，但**数据仍在库里** —— 带 `includeExpired: true` 依然能取回。
   Rows carry a `valid_until` (30 days by default; set `retentionDays: 0` to disable). Expired rows disappear from normal queries but remain on disk; `includeExpired: true` still returns them.

3. **怎么删 / How to delete**
   关掉插件后直接删这个目录即可，插件不会重建它以外的任何东西。
   Disable the plugin, then delete that directory. Nothing else is created.

   ```
   删除 / delete: <workspace>/.dsh-memory-echo/
   （拿不到工作区时在 $DSH_HOME/data/dsh-memory-echo/）
   ```

## 配置 / Configuration

| 键 Key | 默认 Default | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后不注册工具、不扫描 / disables everything |
| `dbDir` | `''` | 库的基础目录；空 = 跟随当前工作区（`<workspace>/.dsh-memory-echo`）|
| `sessionsRoot` | `''` | 会话日志根；空 = `$DSH_HOME/sessions` |
| `autoScan` | `true` | 加载时做一次增量扫描 / incremental scan on load |
| `autoScanDays` | `7` | 增量扫描回看几天 |

## 用法 / Usage

工具名 `memory_echo`。

```
memory_echo({ query: "硬盘" })                      // 查关键词
memory_echo({ days: 1 })                            // 今天说过什么
memory_echo({ mode: "bucket", days: 1 })            // 按天聚合：哪一段、几条、样例
memory_echo({ query: "方案", includeExpired: true }) // 连已淡出的一起查
```

🩸 **`query` 必须是 2~4 个字的实体词**（`硬盘`、`报错`、`深色`），不要传整句。整句会被切成多个片段、要求每个都命中，反而一条都查不到 —— 想查"我上次说的那个方案"，就传 `方案`。

🩸 **`query` must be a 2–4 character concrete term.** A full sentence is split into fragments and each must match, so it usually matches nothing. To look up "that plan I mentioned", pass `方案`.

## 设计约束 / Design constraints

| 约束 | 原因 |
| --- | --- |
| **存全文，不做有损压缩** | 压缩会丢动词与否定词 —— 把「别点它，会连坐杀掉后台任务」压成「连坐杀掉后台任务」，意思就从禁令变成了操作步骤 |
| **不自动注入** | 执行途中不会停下来查询，预置反而抑制查询 |
| **查询失败必须区分原因** | `not-found` / `unavailable` / `empty-db` / `expired` 四种含义不同。「取不到」不等于「没说过」 |
| **只存用户发言** | 助手回复与工具输出不是"说过的话" |

## 状态 / Status

`0.1.x` —— 接口与数据格式尚未稳定。运行时的依赖为零（只用 `node:` 内置模块）。

`0.1.x` — interfaces and data format are not yet stable. Zero runtime dependencies (only `node:` built-ins).

## 许可证 / License

MIT
