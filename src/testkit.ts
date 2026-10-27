/**
 * 测试入口：把内部函数暴露出来给 tests/run.mjs 用。
 *
 * 存在的理由：宿主只认 `lib/index.js` 的 `apply`，但测试还需要直接调
 * `scanSessions` / `openStore` / `buildEchoTool`。多打一个 bundle 比
 * "让测试去跑 TS 源码"可靠 —— 否则测的就不是发布物了。
 *
 * ⚠️ 这个文件不在 `package.json` 的 `files` 白名单里（只发 lib/index.js），
 * 但它的产物 `lib/testkit.js` 会跟着 lib 一起进仓 —— 那是给测试用的，不是给用户的。
 */
export { scanSessions } from './scan.js'
export { openStore } from './db.js'
export { buildEchoTool } from './tool.js'
