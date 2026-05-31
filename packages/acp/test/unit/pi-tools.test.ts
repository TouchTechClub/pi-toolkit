import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import test from 'node:test'
import { normalizeDisplayPath, toolResultToText } from '../../src/acp/translate/pi-tools.js'

test('toolResultToText: extracts text from content blocks', () => {
  const text = toolResultToText({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' },
    ],
  })
  assert.equal(text, 'hello world')
})

test('toolResultToText: prefers details.diff when present', () => {
  const text = toolResultToText({ details: { diff: '--- a\n+++ b\n' } })
  assert.equal(text, '--- a\n+++ b\n')
})

test('toolResultToText: falls back to JSON', () => {
  const text = toolResultToText({ a: 1 })
  assert.match(text, /"a": 1/)
})

test('toolResultToText: extracts bash stdout/stderr from details', () => {
  const text = toolResultToText({
    details: {
      stdout: 'ok\n',
      stderr: 'warn\n',
      exitCode: 0,
    },
  })
  assert.match(text, /ok/)
  assert.match(text, /stderr:/)
  assert.match(text, /warn/)
  assert.match(text, /exit code: 0/)
})

// --- normalizeDisplayPath ---

const cwd = '/Users/dev/my-project'
const home = homedir()

test('normalizeDisplayPath: absolute inside cwd → relative', () => {
  assert.equal(normalizeDisplayPath(`${cwd}/src/foo.ts`, cwd), 'src/foo.ts')
})

test('normalizeDisplayPath: already relative → resolves to relative', () => {
  assert.equal(normalizeDisplayPath('src/foo.ts', cwd), 'src/foo.ts')
})

test('normalizeDisplayPath: cwd root itself → .', () => {
  assert.equal(normalizeDisplayPath(cwd, cwd), '.')
  assert.equal(normalizeDisplayPath(`${cwd}/`, cwd), '.')
})

test('normalizeDisplayPath: absolute inside home → ~ shorthand', () => {
  assert.equal(normalizeDisplayPath(`${home}/.config/foo`, cwd), '~/.config/foo')
})

test('normalizeDisplayPath: home root itself → ~', () => {
  assert.equal(normalizeDisplayPath(home, cwd), '~')
  assert.equal(normalizeDisplayPath(`${home}/`, cwd), '~')
})

test('normalizeDisplayPath: outside both → unchanged absolute', () => {
  assert.equal(normalizeDisplayPath('/etc/hosts', cwd), '/etc/hosts')
  assert.equal(normalizeDisplayPath('/tmp/log', cwd), '/tmp/log')
})

test('normalizeDisplayPath: cwd with trailing slash', () => {
  assert.equal(normalizeDisplayPath(`${cwd}/src/bar.ts`, `${cwd}/`), 'src/bar.ts')
})

test('normalizeDisplayPath: nested cwd inside home uses cwd shortening', () => {
  const nestedCwd = `${home}/work/repo`
  assert.equal(normalizeDisplayPath(`${nestedCwd}/lib/x.ts`, nestedCwd), 'lib/x.ts')
})
