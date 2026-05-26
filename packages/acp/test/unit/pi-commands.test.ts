import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isAcpCompatible, toAvailableCommandsFromPiGetCommands } from '../../src/acp/pi-commands.js'

test('toAvailableCommandsFromPiGetCommands: hides extension commands by default and filters skill commands', () => {
  const data = {
    commands: [
      { name: 'x', description: 'X', source: 'extension' },
      { name: 'skill:foo', description: 'Foo', source: 'skill', location: 'user' },
      { name: 'y', source: 'prompt', location: 'project' },
    ],
  }

  const all = toAvailableCommandsFromPiGetCommands(data, { enableSkillCommands: true }).commands
  assert.deepEqual(all, [
    { name: 'skill:foo', description: 'Foo' },
    { name: 'y', description: '(prompt:project)' },
  ])

  const noSkills = toAvailableCommandsFromPiGetCommands(data, {
    enableSkillCommands: false,
  }).commands
  assert.deepEqual(noSkills, [{ name: 'y', description: '(prompt:project)' }])
})

test('toAvailableCommandsFromPiGetCommands: includes only ACP-compatible extension commands when opted in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-commands-'))
  try {
    const compatiblePath = join(dir, 'compatible.ts')
    const incompatiblePath = join(dir, 'incompatible.ts')
    writeFileSync(compatiblePath, '// @pi-acp-compatible\nexport default function ext() {}\n')
    writeFileSync(incompatiblePath, 'export default function ext() {}\n')

    const data = {
      commands: [
        { name: 'compatible', description: 'yes', source: 'extension', path: compatiblePath },
        { name: 'incompatible', description: 'no', source: 'extension', path: incompatiblePath },
      ],
    }

    assert.equal(isAcpCompatible(data.commands[0]), true)
    assert.equal(isAcpCompatible(data.commands[1]), false)

    const commands = toAvailableCommandsFromPiGetCommands(data, {
      includeExtensionCommands: true,
    }).commands

    assert.deepEqual(commands, [{ name: 'compatible', description: 'yes' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
