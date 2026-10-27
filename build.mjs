/**
 * 构建脚本：src/ → lib/（单文件 ESM bundle）。
 *
 * 宿主相关包保持 external，由 DSH 提供；其余全部打进 bundle，
 * 保证插件目录自包含、可整包分发。
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

mkdirSync(new URL('./lib', import.meta.url), { recursive: true })

// 测试入口单独打一个 bundle：让测试跑【产物】而不是 TS 源码。
// 少这一个包，测试就会悄悄退回 `src/*.ts`，于是"测过了"不代表"发布物可用"。
await build({
  entryPoints: ['src/testkit.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'lib/testkit.js',
  logLevel: 'error',
  external: ['@deepseek-ai/*'],
})

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'lib/index.js',
  sourcemap: true,
  logLevel: 'info',
  // 宿主提供的包不打进 bundle：版本由 DSH 决定，打进去会造成双实例。
  external: ['@deepseek-ai/*'],
  banner: {
    js: [`// ${pkg.name} v${pkg.version} — built with DeepSeek Harness (DSH)`].join('\n'),
  },
})

console.log(`[build] ${pkg.name} v${pkg.version} → lib/index.js`)
