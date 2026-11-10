#!/usr/bin/env node
/**
 * 从 git log 生成发版说明草稿。
 *
 * 为什么要有它：发版说明以前是手写的（`release/notes-*.md`），而 `release/` 是产物目录
 * 且 gitignored —— 换台机器、或者别人 clone 下来，历史版本的说明就没了。约定 commit
 * 前缀之后，四块内容可以从提交里直接分出来，人只需要通读、润色、补英文。
 *
 *     node scripts/release-notes.mjs                    # 最近一个 tag → HEAD
 *     node scripts/release-notes.mjs v0.1.21            # 指定起点
 *     node scripts/release-notes.mjs v0.1.21 v0.1.22    # 指定区间
 *
 * 输出到 stdout，重定向进 `docs/releases/v<版本>.md` 再改。英文块不自动翻（提交是中文），
 * 只留骨架。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SECTIONS = [
  ['feat', '新增功能', 'New Features'],
  ['perf', '体验优化', 'Improvements'],
  ['fix', '问题修复', 'Bug Fixes'],
  ['chore', '其他变更', 'Chores'],
]

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

const [fromArg, toArg] = process.argv.slice(2)
const to = toArg || 'HEAD'
// 没给起点就取最近的 tag：发版时最常用的区间就是「上次发布到现在」。
const from = fromArg || git(['describe', '--tags', '--abbrev=0', to])
if (!from) {
  console.error('找不到起点 tag，请显式传一个')
  process.exit(2)
}

const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const tag = `v${version}`
const range = from === to ? to : `${from}..${to}`

// --no-merges：分支里合进来的内容已经在各自提交中，再列一遍会重复。
// 但 squash 合并的提交（「合并 PR #NN：…」）不是 merge commit，得单独滤掉。
const subjects = git(['log', '--no-merges', '--pretty=%s', range]).split('\n').filter(Boolean)

const buckets = new Map(SECTIONS.map(([type]) => [type, []]))
const unsorted = []

for (const subject of subjects) {
  if (/^合并 PR/.test(subject)) continue
  // 允许 `fix(scope): …`，作用域只用来表达范围，不进发版说明。
  const match = /^(feat|fix|perf|chore)(?:\([^)]*\))?:\s*(.+)$/.exec(subject)
  if (!match) {
    unsorted.push(subject)
    continue
  }
  buckets.get(match[1]).push(match[2])
}

const out = []
out.push('<a id="cn"></a>', '', '[中文](#cn) \\| [English](#en)', '')

for (const [type, cn] of SECTIONS) {
  const items = buckets.get(type)
  if (!items.length) continue
  out.push(`### ${cn}`, '', ...items.map((text) => `- ${text}`), '')
}

if (unsorted.length) {
  // 不静默丢弃：没前缀的提交多半是要发的东西，强行归错块比留个清单更糟。
  out.push('<!-- 以下提交没有前缀，请手工归入上面四块，或下次按 feat / fix / perf / chore 写 -->', '')
  out.push(...unsorted.map((text) => `- ${text}`), '')
}

out.push(`Full Changelog: [${from}...${tag}](https://github.com/yyh-001/DSH-X/compare/${from}...${tag})`, '')
out.push('---', '', '<a id="en"></a>', '', '## English', '')
for (const [, , en] of SECTIONS) {
  out.push(`### ${en}`, '', '- ', '')
}

process.stdout.write(out.join('\n'))
console.error(
  `\n区间 ${from}..${to}：${SECTIONS.map(([t, cn]) => `${cn} ${buckets.get(t).length}`).join(' / ')}` +
    (unsorted.length ? `，未归类 ${unsorted.length}` : '') +
    `\n英文块需要人工翻译。`,
)
