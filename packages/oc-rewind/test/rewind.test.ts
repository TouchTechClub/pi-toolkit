import { describe, expect, test } from 'bun:test'
import {
  age,
  checkpointKey,
  collectBranchDiffFiles,
  colorizeDiff,
  diffFileCompletions,
  filterOlderThan,
  formatBytes,
  normalizeGitPath,
  parseGitWorktree,
  summarizeByProject,
  summarizeUsage,
  tildify,
  userText,
} from '../index.ts'

describe('normalizeGitPath', () => {
  test('passes through normal relative paths', () => {
    expect(normalizeGitPath('src/index.ts')).toBe('src/index.ts')
  })

  test('normalizes backslashes', () => {
    expect(normalizeGitPath('src\\a\\b.ts')).toBe('src/a/b.ts')
  })

  test('rejects absolute paths', () => {
    expect(normalizeGitPath('/etc/passwd')).toBeUndefined()
  })

  test('rejects traversal and dot', () => {
    expect(normalizeGitPath('.')).toBeUndefined()
    expect(normalizeGitPath('../x')).toBeUndefined()
    expect(normalizeGitPath('a/../b')).toBeUndefined()
  })

  test('rejects NUL bytes', () => {
    expect(normalizeGitPath('a\0b')).toBeUndefined()
  })

  test('rejects the .pi directory (snapshot/restore invariant)', () => {
    expect(normalizeGitPath('.pi')).toBeUndefined()
    expect(normalizeGitPath('.pi/settings.json')).toBeUndefined()
  })
})

describe('userText', () => {
  test('returns string content as-is', () => {
    expect(userText({ content: 'hello' })).toBe('hello')
  })

  test('joins text blocks and ignores non-text', () => {
    expect(
      userText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', data: 'x' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('ab')
  })

  test('returns empty string for unsupported content', () => {
    expect(userText({ content: 42 })).toBe('')
  })
})

describe('colorizeDiff', () => {
  // Minimal fake theme that tags each line with the color key it was given,
  // so we can assert which lines were classified as additions/deletions/etc.
  const theme = {
    fg: (color: string, text: string) => `<${color}>${text}`,
  } as unknown as Parameters<typeof colorizeDiff>[1]

  test('classifies each diff line by prefix', () => {
    const diff = ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-old', '+new', ' ctx'].join('\n')
    const out = colorizeDiff(diff, theme).split('\n')
    expect(out[0]).toBe('<dim>--- a/x')
    expect(out[1]).toBe('<dim>+++ b/x')
    expect(out[2]).toBe('<dim>@@ -1 +1 @@')
    expect(out[3]).toBe('<toolDiffRemoved>-old')
    expect(out[4]).toBe('<toolDiffAdded>+new')
    expect(out[5]).toBe('<text> ctx')
  })
})

describe('collectBranchDiffFiles', () => {
  const userEntry = (id: string) =>
    ({ type: 'message', id, message: { role: 'user', content: '' } }) as Parameters<
      typeof collectBranchDiffFiles
    >[0][number]
  const cp = (files: string[]) =>
    ({ files }) as unknown as NonNullable<
      ReturnType<Parameters<typeof collectBranchDiffFiles>[1]['get']>
    >

  test('returns sorted unique files from checkpoints on the branch', () => {
    const branch = [userEntry('u1'), userEntry('u2'), userEntry('u3')]
    const checkpoints = new Map([
      ['u1', cp(['src/b.ts', 'src/a.ts'])],
      ['u2', cp(['src/a.ts', 'README.md'])],
      // u3 has no checkpoint
    ])
    expect(collectBranchDiffFiles(branch, checkpoints)).toEqual([
      'README.md',
      'src/a.ts',
      'src/b.ts',
    ])
  })

  test('ignores checkpoints whose user entry is not on the branch', () => {
    const branch = [userEntry('u1')]
    const checkpoints = new Map([
      ['u1', cp(['on-branch.ts'])],
      ['other', cp(['off-branch.ts'])],
    ])
    expect(collectBranchDiffFiles(branch, checkpoints)).toEqual(['on-branch.ts'])
  })

  test('empty when no checkpoints match', () => {
    expect(collectBranchDiffFiles([userEntry('u1')], new Map())).toEqual([])
  })
})

describe('diffFileCompletions', () => {
  const files = ['src/agent.ts', 'src/session.ts', 'README.md']

  test('returns all files for an empty prefix', () => {
    expect(diffFileCompletions(files, '').map((i) => i.value)).toEqual(files)
  })

  test('filters case-insensitively by substring', () => {
    expect(diffFileCompletions(files, 'SES').map((i) => i.value)).toEqual(['src/session.ts'])
    expect(diffFileCompletions(files, 'src/').map((i) => i.value)).toEqual([
      'src/agent.ts',
      'src/session.ts',
    ])
  })

  test('maps to AutocompleteItem shape', () => {
    const [item] = diffFileCompletions(['README.md'], 'read')
    expect(item).toEqual({
      value: 'README.md',
      label: 'README.md',
      description: 'changed in this session',
    })
  })

  test('empty when nothing matches', () => {
    expect(diffFileCompletions(files, 'nope')).toEqual([])
  })
})

describe('checkpointKey', () => {
  test('is deterministic and depends on cwd + sessionId', () => {
    const a = checkpointKey('/proj', 'sess1')
    expect(a).toBe(checkpointKey('/proj', 'sess1'))
    expect(a).not.toBe(checkpointKey('/proj', 'sess2'))
    expect(a).not.toBe(checkpointKey('/other', 'sess1'))
    expect(a).toMatch(/^[0-9a-f]{24}$/)
  })
})

describe('formatBytes', () => {
  test('handles zero and scales through units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

describe('summarizeUsage (with current flag)', () => {
  test('marks the current entry and totals', () => {
    const out = summarizeUsage(
      [
        { label: '/proj/a', path: '/x/a', bytes: 2048, current: true },
        { label: '/proj/b', path: '/x/b', bytes: 10 * 1024 * 1024, current: false },
      ],
      'session',
    )
    expect(out).toContain('/proj/a (current)')
    expect(out).not.toContain('/proj/b (current)')
    expect(out).toContain('total across 2 sessions')
    // largest first
    expect(out.indexOf('/proj/b')).toBeLessThan(out.indexOf('/proj/a'))
  })

  test('empty state', () => {
    expect(summarizeUsage([], 'session')).toBe('No cached sessions found.')
  })
})

const store = (over: Partial<Parameters<typeof summarizeByProject>[0][number]> = {}) =>
  ({
    label: over.cwd ?? 'x',
    path: '/store',
    bytes: 0,
    current: false,
    ...over,
  }) as Parameters<typeof summarizeByProject>[0][number]

describe('summarizeByProject', () => {
  test('empty state', () => {
    expect(summarizeByProject([])).toBe('No checkpoint snapshots found.')
  })

  test('groups sessions by project, largest-first, with a total', () => {
    const out = summarizeByProject([
      store({ cwd: '/proj/a', bytes: 1024 }),
      store({ cwd: '/proj/a', bytes: 1024 }),
      store({ cwd: '/proj/b', bytes: 5 * 1024 * 1024 }),
    ])
    expect(out).toContain('/proj/b (1 session)')
    expect(out).toContain('/proj/a (2 sessions)')
    // /proj/b is larger so it comes first
    expect(out.indexOf('/proj/b')).toBeLessThan(out.indexOf('/proj/a'))
    expect(out).toContain('total across 2 projects')
  })

  test('normalizes the home directory to ~ in project paths', () => {
    const out = summarizeByProject([store({ cwd: '/home/me/repos/proj', bytes: 1 })])
    expect(out).toContain(`${tildify('/home/me/repos/proj')} (1 session)`)
  })

  test('groups unknown-cwd stores under a placeholder', () => {
    const out = summarizeByProject([store({ cwd: undefined, bytes: 10 })])
    expect(out).toContain('(unknown project)')
    expect(out).toContain('total across 1 project')
  })
})

describe('filterOlderThan', () => {
  const now = 10 * 24 * 60 * 60 * 1000 // day 10
  const day = 24 * 60 * 60 * 1000

  test('returns stores updated strictly before the cutoff', () => {
    const entries = [
      store({ label: 'old', updatedAt: now - 8 * day }),
      store({ label: 'recent', updatedAt: now - 2 * day }),
    ]
    const out = filterOlderThan(entries, 7, now)
    expect(out.map((e) => e.label)).toEqual(['old'])
  })

  test('excludes entries with unknown timestamps', () => {
    const entries = [store({ label: 'no-ts', updatedAt: undefined })]
    expect(filterOlderThan(entries, 0, now)).toEqual([])
  })

  test('rejects invalid day counts', () => {
    const entries = [store({ updatedAt: 0 })]
    expect(filterOlderThan(entries, -1, now)).toEqual([])
    expect(filterOlderThan(entries, Number.NaN, now)).toEqual([])
  })

  test('days=0 deletes everything with a known older timestamp', () => {
    const entries = [store({ label: 'a', updatedAt: now - 1 })]
    expect(filterOlderThan(entries, 0, now).map((e) => e.label)).toEqual(['a'])
  })
})

describe('parseGitWorktree', () => {
  const config = [
    '[core]',
    '\trepositoryformatversion = 0',
    '\tbare = false',
    '\tworktree = /Users/me/repos/proj',
    '\tignorecase = true',
  ].join('\n')

  test('extracts core.worktree from a git config', () => {
    expect(parseGitWorktree(config)).toBe('/Users/me/repos/proj')
  })

  test('handles paths with spaces', () => {
    expect(parseGitWorktree('[core]\n\tworktree = /Users/me/My Code/proj\n')).toBe(
      '/Users/me/My Code/proj',
    )
  })

  test('undefined when no worktree key', () => {
    expect(parseGitWorktree('[core]\n\tbare = false\n')).toBeUndefined()
    expect(parseGitWorktree('')).toBeUndefined()
  })
})

describe('tildify', () => {
  test('replaces a leading home dir with ~', () => {
    expect(tildify('/Users/me/repos/proj', '/Users/me')).toBe('~/repos/proj')
    expect(tildify('/Users/me', '/Users/me')).toBe('~')
  })

  test('leaves non-home paths untouched', () => {
    expect(tildify('/var/tmp/x', '/Users/me')).toBe('/var/tmp/x')
    // Must match a full path segment, not a prefix substring.
    expect(tildify('/Users/meddler/x', '/Users/me')).toBe('/Users/meddler/x')
  })

  test('no-op when home is empty', () => {
    expect(tildify('/Users/me/x', '')).toBe('/Users/me/x')
  })
})

describe('age', () => {
  const now = 1000 * 60 * 60 * 24 * 365 // 1 year in ms

  test('returns just now for recent timestamps', () => {
    expect(age(now, now)).toBe('just now')
    expect(age(now - 59_000, now)).toBe('just now')
  })

  test('minutes', () => {
    expect(age(now - 60_000, now)).toBe('1m ago')
    expect(age(now - 59 * 60_000, now)).toBe('59m ago')
  })

  test('hours', () => {
    expect(age(now - 60 * 60_000, now)).toBe('1h ago')
    expect(age(now - 23 * 60 * 60_000, now)).toBe('23h ago')
  })

  test('days', () => {
    expect(age(now - 24 * 60 * 60_000, now)).toBe('1d ago')
    expect(age(now - 29 * 24 * 60 * 60_000, now)).toBe('29d ago')
  })

  test('months', () => {
    expect(age(now - 30 * 24 * 60 * 60_000, now)).toBe('1mo ago')
    expect(age(now - 11 * 30 * 24 * 60 * 60_000, now)).toBe('11mo ago')
  })

  test('years', () => {
    expect(age(now - 12 * 30 * 24 * 60 * 60_000, now)).toBe('1y ago')
  })

  test('handles undefined / NaN timestamps', () => {
    expect(age(undefined, now)).toBe('?')
    expect(age(Number.NaN, now)).toBe('?')
  })

  test('negative diff (future timestamp) returns just now', () => {
    expect(age(now + 1, now)).toBe('just now')
  })
})
