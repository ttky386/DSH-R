import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const agentFile = join(root, 'src', 'remote-agent.mjs')
const server = readFileSync(join(root, 'src', 'server.js'), 'utf8')
const html = readFileSync(join(root, 'src', 'public', 'index.html'), 'utf8')
const launch = readFileSync(join(root, 'src', 'remote-launch.js'), 'utf8')

function runAgent(home, operation, payload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  return spawnSync(process.execPath, [agentFile, operation, encoded], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home },
  })
}

function agentJson(result) {
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function profileWithFilePlugins(dir, { all = true } = {}) {
  const names = [
    '@deepseek-ai/dsh-client-file-upload',
    '@deepseek-ai/dsh-api-workspace-files',
    '@deepseek-ai/dsh-client-ui-sidebar-files',
    '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
    '@deepseek-ai/dsh-file-reference',
  ].filter((_name, index) => all || index !== 1)
  mkdirSync(join(dir, 'profiles', 'web'), { recursive: true })
  writeFileSync(join(dir, 'profiles', 'web', 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: Object.fromEntries(names.map((name) => [name, '^0.1.5-alpha.1'])),
  }, null, 2)}\n`)
  for (const name of names) {
    const packageDir = join(dir, 'profiles', 'web', 'node_modules', ...name.split('/'))
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({ name, version: '0.1.5-alpha.1' }, null, 2)}\n`)
  }
}

test('远端文件列表和预览读取限制在 DSH_HOME 内', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-remote-files-'))
  const home = join(rootDir, 'home')
  const dshHome = join(rootDir, 'dsh')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(dshHome, 'profiles', 'web', 'sub'), { recursive: true })
  writeFileSync(join(dshHome, 'profiles', 'web', 'a.md'), 'hello remote\n')
  writeFileSync(join(dshHome, 'profiles', 'web', 'b.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))
  writeFileSync(join(dshHome, '.credentials.yaml'), 'version: 1\nrefs: {}\n')
  symlinkSync('a.md', join(dshHome, 'profiles', 'web', 'a-link.md'))
  try {
    const listing = agentJson(runAgent(home, 'file-list', { dshHome, profile: 'web', path: 'profiles/web' }))
    assert.equal(listing.ok, true)
    assert.deepEqual(listing.entries.map((item) => item.name).sort(), ['a-link.md', 'a.md', 'b.bin', 'sub'])
    assert.equal(listing.entries.find((item) => item.name === 'a-link.md').type, 'file')
    assert.equal(listing.entries.find((item) => item.name === 'sub').type, 'directory')

    const text = agentJson(runAgent(home, 'file-read', { dshHome, profile: 'web', path: 'profiles/web/a.md' }))
    assert.equal(text.kind, 'text')
    assert.equal(text.mime, 'text/markdown')
    assert.equal(text.text, 'hello remote\n')

    const bytes = agentJson(runAgent(home, 'file-read', { dshHome, profile: 'web', path: 'profiles/web/b.bin' }))
    assert.equal(bytes.kind, 'bytes')
    assert.equal(bytes.base64, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]).toString('base64'))

    const linked = agentJson(runAgent(home, 'file-read', { dshHome, profile: 'web', path: 'profiles/web/a-link.md' }))
    assert.equal(linked.text, 'hello remote\n')

    const sensitive = runAgent(home, 'file-read', { dshHome, profile: 'web', path: '.credentials.yaml' })
    assert.notEqual(sensitive.status, 0)
    assert.match(sensitive.stderr, /REMOTE_FILE_SENSITIVE/)

    for (const path of ['../outside', '/etc/passwd']) {
      const denied = runAgent(home, 'file-read', { dshHome, profile: 'web', path })
      assert.notEqual(denied.status, 0)
      assert.match(denied.stderr, /路径越界|DSH_HOME 外/)
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('远端 symlink 不能把文件面板指向 DSH_HOME 外', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-remote-files-link-'))
  const home = join(rootDir, 'home')
  const dshHome = join(rootDir, 'dsh')
  mkdirSync(home, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  writeFileSync(join(rootDir, 'secret.txt'), 'secret')
  symlinkSync(join(rootDir, 'secret.txt'), join(dshHome, 'secret-link'))
  try {
    const denied = runAgent(home, 'file-read', { dshHome, profile: 'web', path: 'secret-link' })
    assert.notEqual(denied.status, 0)
    assert.match(denied.stderr, /DSH_HOME 外/)
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('远端文件能力探测官方上传、文件树、预览和路径引用插件', () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'dsh-remote-file-capabilities-'))
  const home = join(rootDir, 'home')
  mkdirSync(home, { recursive: true })
  try {
    profileWithFilePlugins(join(rootDir, 'dsh'))
    const ready = agentJson(runAgent(home, 'file-capabilities', { dshHome: join(rootDir, 'dsh'), profile: 'web' }))
    assert.deepEqual(ready.features, { upload: true, tree: true, preview: true, links: true })
    assert.deepEqual(ready.missing, [])

    profileWithFilePlugins(join(rootDir, 'missing'), { all: false })
    const missing = agentJson(runAgent(home, 'file-capabilities', { dshHome: join(rootDir, 'missing'), profile: 'web' }))
    assert.equal(missing.features.preview, false)
    assert.deepEqual(missing.missing, ['@deepseek-ai/dsh-api-workspace-files'])
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
})

test('远程文件面板走 SSH agent，并提供官方插件一键补齐', () => {
  assert.match(launch, /remoteFileCapabilities/)
  assert.match(launch, /remoteFileList/)
  assert.match(launch, /remoteFileRead/)
  assert.match(launch, /\.\.\.files,\s*\n\s*`\$\{target\.user\}@\$\{target\.host\}:\$\{stage\}\/`/, 'agent 更新必须批量 SCP，高延迟 VPN 不能逐文件往返')
  assert.match(launch, /'chmod', '600', `\$HOME\/\$\{REMOTE_ROOT\}\/lib\/\*`/, '批量落位后仍要收紧 agent 文件权限')
  assert.match(server, /url\.pathname === '\/api\/remote\/files'/)
  assert.match(server, /action === 'install-official'/)
  assert.match(server, /remotePluginInstall\(target, dshHome, profile, name, version/)
  for (const id of ['remoteFileCapabilities', 'remoteFileList', 'remoteFilePreviewEmpty', 'remoteFilePdf', 'remoteFileImage', 'remoteFileText', 'remoteFileInstall']) {
    assert.ok(html.includes(`id="${id}"`), `页面缺少 ${id}`)
  }
  assert.match(html, /remoteProfilePost\('\/api\/remote\/files'/)
  assert.match(html, /official|官方文件链路可用/)
  assert.match(html, /previewRemoteFile\(button\.dataset\.remoteFilePreview\)/)
})
