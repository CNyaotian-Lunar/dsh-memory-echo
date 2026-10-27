// dsh-memory-echo —— test runner.
//
// No test framework: `node tests/run.mjs` prints "N passed, M failed" and sets a
// non-zero exit code on failure. Fixtures are written to a temporary directory and
// removed afterwards.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zstdCompressSync } from 'node:zlib'

/**
 * 只加载【构建产物】，**不回退 TS 源码**。
 *
 * 回退看起来"更宽容"，实际是有害的：它会让人误以为测试覆盖了发布物，
 * 而真正被打包的代码一步都没跑过（2026-10-28 就这么漏了一个"装上就抛"的缺陷）。
 */
async function loadTestkit() {
  try {
    return await import(new URL('../lib/testkit.js', import.meta.url).href)
  } catch (error) {
    throw new Error(`cannot load lib/testkit.js — run \`npm run build\` first: ${error.message}`)
  }
}

const FRAME_MAGIC = Buffer.from('28b52ffd', 'hex')

const toLine = (value) => JSON.stringify(value) + '\n'
const compress = (events) => zstdCompressSync(Buffer.from(events.map(toLine).join('')))
const multiFrame = (frames) => Buffer.concat(frames.map((frame) => compress(frame)))

const sessionEvent = (id, origin) => ({ type: 'session', version: 4, id, createdAt: 1, origin })

const userMessage = (text, time, seq, kind = 'user') => ({
  type: 'user/message',
  seq,
  time,
  data: { content: [{ type: 'text', text }], source: { kind }, role: 'user' },
})

function writeSession(root, workspace, sessionId, buffer) {
  const dir = join(root, workspace, sessionId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), buffer)
}

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${name}: ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function equalJson(actual, expected, message) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}: got ${a}, want ${b}`)
}

const kit = await loadTestkit()
const scanSessions = kit.scanSessions
const scratch = mkdtempSync(join(tmpdir(), 'dsh-memory-echo-test-'))

try {
  // ---- fixture: one ordinary session, one subagent session -------------------
  const root = join(scratch, 'sessions')
  const mainId = 'aaaa1111-2222-3333-4444-555566667777'
  const subId = 'bbbb2222-3333-4444-5555-666677778888'

  const longBrief = '你是独立的审查员，请先读工作区说明再干活。' + '补充说明。'.repeat(60)

  writeSession(
    root,
    'workspace-a',
    mainId,
    multiFrame([
      [sessionEvent(mainId, 'main')],
      [
        userMessage('第一条原话', 1000, 1),
        userMessage('这条是 AI 回复，必须排除', 1001, 2, 'assistant'),
      ],
      [
        userMessage(longBrief, 1002, 3),
        userMessage('!force 这条要保留', 1003, 4),
      ],
    ]),
  )

  writeSession(
    root,
    'workspace-a',
    subId,
    multiFrame([[sessionEvent(subId, 'subagent')], [userMessage('子代理任务书，必须排除', 1100, 1)]]),
  )

  // ---- fixture: two utterances sharing one millisecond ----------------------
  const sameMsId = 'cccc3333-4444-5555-6666-777788889999'
  writeSession(
    root,
    'workspace-b',
    sameMsId,
    multiFrame([
      [sessionEvent(sameMsId, 'main')],
      [userMessage('同一毫秒 A', 2000, 5), userMessage('同一毫秒 B', 2000, 6)],
    ]),
  )

  const first = scanSessions({ sessionsRoot: root })
  const second = scanSessions({ sessionsRoot: root })

  // ---- 1. multi-frame decoding ---------------------------------------------
  check('decodes every zstd frame (3 frames, all utterances reachable)', () => {
    equalJson(first.framesScanned, 3 + 2 + 2, 'framesScanned')
    assert(first.utterances.length === 4, `expected 4 utterances, got ${first.utterances.length}`)
  })

  // ---- 2. filtering ---------------------------------------------------------
  check('excludes assistant replies, task briefs and subagent sessions', () => {
    const texts = first.utterances.map((item) => item.text)
    assert(!texts.includes('这条是 AI 回复，必须排除'), 'assistant reply leaked in')
    assert(!texts.some((text) => text.startsWith('你是独立的审查员')), 'task brief leaked in')
    assert(!texts.includes('子代理任务书，必须排除'), 'subagent session leaked in')
    assert(texts.includes('第一条原话'), 'ordinary utterance missing')
    assert(texts.includes('这条要保留'), '!force prefix was not stripped in place')
    equalJson(first.filesScanned, 2, 'filesScanned')
    equalJson(first.filesSkipped, 1, 'filesSkipped')
  })

  // ---- 3. stable ids --------------------------------------------------------
  check('produces identical ids across two scans', () => {
    const a = first.utterances.map((item) => item.id).sort()
    const b = second.utterances.map((item) => item.id).sort()
    equalJson(a, b, 'id set')
    assert(new Set(a).size === a.length, 'ids are not unique')
  })

  check('disambiguates two utterances sharing one millisecond', () => {
    const pair = first.utterances.filter((item) => item.saidAt === 2000)
    assert(pair.length === 2, `expected 2 utterances at 2000ms, got ${pair.length}`)
    assert(pair[0].id !== pair[1].id, 'ids collide inside the same millisecond')
  })

  check('records frameSeq for every utterance', () => {
    assert(first.utterances.every((item) => item.frameSeq !== null), 'frameSeq is null')
  })

  // ---- 4. fault tolerance ---------------------------------------------------
  check('keeps going when one frame is corrupt', () => {
    const brokenRoot = join(scratch, 'broken')
    const brokenId = 'dddd4444-5555-6666-7777-888899990000'
    const corrupt = Buffer.concat([
      FRAME_MAGIC,
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    ])
    writeSession(
      brokenRoot,
      'workspace-c',
      brokenId,
      Buffer.concat([
        compress([sessionEvent(brokenId, 'main')]),
        compress([userMessage('坏帧之前', 3000, 1)]),
        corrupt,
        compress([userMessage('坏帧之后', 3001, 2)]),
      ]),
    )

    const result = scanSessions({ sessionsRoot: brokenRoot })
    const texts = result.utterances.map((item) => item.text)
    assert(texts.includes('坏帧之前'), 'utterance before the corrupt frame was lost')
    assert(texts.includes('坏帧之后'), 'utterance after the corrupt frame was lost')
    assert(result.errors.length > 0, 'corrupt frame was not reported in errors')
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
// ── 注册冒烟 ──────────────────────────────────────────────
// 专门拦「装上就抛」那类缺陷：tool schema 不合宿主子集时，
// ctx.tools.register() 会直接 throw ⇒ 插件加载失败、工具根本不存在。
// 不真的走一次 apply() 就永远发现不了（2026-10-28 就这么漏掉一个 P0）。
try {
  const { apply } = await import(new URL('../lib/index.js', import.meta.url).href)
  let registered = null
  // 收集 dispose 回调：不 close 的话 SQLite 还占着文件，临时目录删不掉（EPERM）。
  const disposers = []
  const ctx = {
    tools: { register: (tool) => { registered = tool } },
    on: (event, fn) => { if (event === 'dispose') disposers.push(fn) },
    logger: { info: () => {}, warn: () => {} },
  }
  const smokeDir = mkdtempSync(join(tmpdir(), 'echo-smoke-'))
  try {
    apply(ctx, {
      enabled: true,
      dbDir: smokeDir,
      sessionsRoot: '',
      autoScan: false,
      autoScanDays: 1,
    })
    assert(registered !== null, 'apply() 没有注册任何工具')
    assert(registered.name === 'memory_echo', `工具名不对: ${registered.name}`)
    assert(registered.output && typeof registered.output.schema === 'object', '缺 output.schema')
    assert(registered.parameters && registered.parameters.type === 'object', '缺 parameters')
    // render 挂在 output 上（宿主契约），不是工具顶层
    assert(typeof registered.output.render === 'function', 'output.render 不存在')
    const blocks = registered.output.render({}, { note: 'x', total: 1, miss: null, hits: [], buckets: [] })
    assert(Array.isArray(blocks), 'render 应返回 content blocks 数组')
    assert(blocks[0] && blocks[0].type === 'text', 'render 的 block 应有 type=text')
    passed += 1
    console.log('ok   注册冒烟：apply() 不抛且注册出 memory_echo')
  } finally {
    // 先让插件自己收尾（关库），再删目录；删不掉也不该让测试红
    for (const dispose of disposers) {
      try { dispose() } catch { /* 收尾失败不影响断言 */ }
    }
    try { rmSync(smokeDir, { recursive: true, force: true }) } catch { /* Windows 上可能仍被占用 */ }
  }
} catch (error) {
  failed += 1
  console.log(`FAIL 注册冒烟: ${error.message}`)
}

if (failed > 0) process.exitCode = 1
