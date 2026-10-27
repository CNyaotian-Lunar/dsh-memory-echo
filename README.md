# dsh-memory-echo

原话级短期记忆插件，用于 DeepSeek Harness。

长期记忆库保留的是提炼后的结论；本插件保留**真正说过的话**，用于回答"我上次说过什么"这类需要逐字原文的问题。它不自动注入上下文，只在被查询时取用。

---

Utterance-level short-term memory for DeepSeek Harness.

A long-term memory store keeps distilled conclusions. This plugin keeps **what was actually said**, so questions like "what did I say last time" can be answered from verbatim text. It never injects into the context automatically; it is read only on demand.

## 为什么需要它 / Why this exists

提炼必然丢失语气与措辞，而"上次那句话是怎么说的"恰恰依赖措辞。把一段原话压缩成摘要，最常见的失败是丢掉**动词与否定的方向**——例如把"不要点它，会连坐杀掉后台任务"压成"连坐杀掉后台任务"，意思就从禁令变成了操作步骤。

Distillation loses tone and wording, yet "how exactly did I phrase that" depends on wording. The most common failure when compressing a sentence into a summary is losing **the verb and the direction of negation** — compressing "do not click it, it kills background jobs" into "it kills background jobs" turns a prohibition into an instruction.

## 设计约束 / Design constraints

| 约束 Constraint | 原因 Reason |
| --- | --- |
| 存全文，不做有损压缩 Store full text, no lossy compression | 压缩会改变语义方向 Compression changes semantic direction |
| 不自动注入 Never inject automatically | 执行途中不会停下来查询，预置反而抑制查询 Nothing queries mid-execution; pre-loading suppresses lookup |
| 查询失败必须区分原因 Failures must be distinguished | 「取不到」不等于「没说过」 "Unavailable" is not "never said" |
| 只存用户发言 Only user utterances | 助手回复与工具输出不是"说过的话" Assistant replies and tool output are not utterances |

## 状态 / Status

开发中。接口与数据格式尚未稳定。

Work in progress. Interfaces and data format are not yet stable.

## 许可证 / License

MIT
