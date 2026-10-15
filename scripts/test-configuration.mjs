import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { builtinModules } from 'node:module'
import { build } from 'vite'

const root = process.cwd()
const parent = path.join(root, 'sandbox/tmp')
fs.mkdirSync(parent, { recursive: true })
const scratch = fs.mkdtempSync(path.join(parent, 'configuration-tests-'))
const home = path.join(scratch, 'home')
fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
// Contain the CLI's canonical Git-root local-settings lookup inside the fixture too.
execFileSync('git', ['init', '--quiet', scratch], { env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
try {
  await build({
    configFile: false, logLevel: 'warn',
    resolve: { alias: { '@shared': path.join(root, 'src/shared') } },
    build: {
      target: 'node22', outDir: path.join(scratch, 'build'), emptyOutDir: true,
      lib: { entry: path.join(root, 'tests/configuration.test.ts'), formats: ['es'], fileName: () => 'configuration.test.mjs' },
      rollupOptions: { external: (id) => id === '@anthropic-ai/claude-agent-sdk' || id.startsWith('node:') || builtinModules.includes(id) }
    }
  })
  // The tests cannot see real Claude settings, credentials, provider environments or chat data.
  const env = {
    HOME: home, PATH: process.env.PATH, TMPDIR: scratch,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CONFIGURATION_TEST_ROOT: scratch,
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
  }
  const child = spawn(process.execPath, ['--test', path.join(scratch, 'build/configuration.test.mjs')], { cwd: root, env, stdio: 'inherit', detached: true })
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGTERM') } catch {} }, 90_000)
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  clearTimeout(timer)
  process.exitCode = code ?? 1
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
