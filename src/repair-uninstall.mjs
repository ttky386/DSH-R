// 调用方持有 profile/lock 和官方 package.json.lock；此处仅调用官方操作体，避免重复取锁。
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [anchor, home, profile, name] = process.argv.slice(2)
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
if (!anchor || !home || !/^[\w.-]+$/.test(profile || '') || !PACKAGE_NAME.test(name || '') || process.env.DSH_HOME !== home) {
  throw new Error('卸载目标无效。')
}
const require = createRequire(anchor)
const { runProfilePnpm } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')))
const dir = join(home, 'profiles', profile)
const result = await runProfilePnpm({ profile, dir, installAnchor: join(dirname(dirname(anchor)), 'package.json'), cwd: dir }, ['remove', name], {
  execution: 'cli',
  outputBytes: 65536,
  onOutput(text, stream) {
    process[stream].write(text)
  },
})
process.exitCode = result.exitCode
