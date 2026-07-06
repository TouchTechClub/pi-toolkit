import { describe, expect, test } from 'bun:test'
import {
  buildReferencesContext,
  detectEcosystems,
  detectPackageManager,
  formatBytes,
  normalizeReferenceConfig,
  parseRepositoryReference,
  type ReferenceConfig,
  type ResolvedReference,
  summarizeUsage,
  validateBranch,
  validateReferenceAlias,
} from '../index.ts'

describe('parseRepositoryReference', () => {
  test('owner/repo shorthand → github.com', () => {
    const ref = parseRepositoryReference('facebook/react')
    expect(ref?.host).toBe('github.com')
    expect(ref?.path).toBe('facebook/react')
    expect(ref?.remote).toBe('https://github.com/facebook/react.git')
    expect(ref?.label).toBe('facebook/react')
  })

  test('github: prefix', () => {
    const ref = parseRepositoryReference('github:vercel/next.js')
    expect(ref?.host).toBe('github.com')
    expect(ref?.repo).toBe('next.js')
  })

  test('https URL with .git suffix', () => {
    const ref = parseRepositoryReference('https://github.com/foo/bar.git')
    expect(ref?.host).toBe('github.com')
    expect(ref?.path).toBe('foo/bar')
  })

  test('SCP-style git@host:path', () => {
    const ref = parseRepositoryReference('git@github.com:foo/bar.git')
    expect(ref?.host).toBe('github.com')
    expect(ref?.path).toBe('foo/bar')
  })

  test('non-github host keeps host in label', () => {
    const ref = parseRepositoryReference('https://gitlab.com/group/proj')
    expect(ref?.host).toBe('gitlab.com')
    expect(ref?.label).toBe('gitlab.com/group/proj')
    // For non-github URLs the original cleaned URL is used verbatim as the remote.
    expect(ref?.remote).toBe('https://gitlab.com/group/proj')
  })

  test('non-github host/path shorthand gets a .git remote', () => {
    const ref = parseRepositoryReference('gitlab.com/group/proj')
    expect(ref?.host).toBe('gitlab.com')
    expect(ref?.remote).toBe('https://gitlab.com/group/proj.git')
  })

  test('rejects file: URLs', () => {
    expect(parseRepositoryReference('file:///tmp/repo')).toBeNull()
  })

  test('rejects empty / single-segment input', () => {
    expect(parseRepositoryReference('')).toBeNull()
    expect(parseRepositoryReference('justone')).toBeNull()
  })

  test('rejects path traversal segments', () => {
    expect(parseRepositoryReference('foo/../bar')).toBeNull()
  })
})

describe('validateBranch', () => {
  test('accepts normal branch names', () => {
    expect(() => validateBranch('main')).not.toThrow()
    expect(() => validateBranch('feature/foo-bar_1.2')).not.toThrow()
  })

  test('rejects leading dash, .., and whitespace', () => {
    expect(() => validateBranch('-x')).toThrow()
    expect(() => validateBranch('a..b')).toThrow()
    expect(() => validateBranch('a b')).toThrow()
  })
})

describe('detectPackageManager', () => {
  test('prefers bun, then pnpm, then yarn, then npm', () => {
    expect(detectPackageManager(new Set(['bun.lock', 'package-lock.json']))).toBe('bun')
    expect(detectPackageManager(new Set(['pnpm-lock.yaml', 'package-lock.json']))).toBe('pnpm')
    expect(detectPackageManager(new Set(['yarn.lock']))).toBe('yarn')
    expect(detectPackageManager(new Set(['package-lock.json']))).toBe('npm')
    expect(detectPackageManager(new Set())).toBeUndefined()
  })
})

describe('detectEcosystems', () => {
  test('maps marker files to ecosystems', () => {
    expect(detectEcosystems(new Set(['package.json']))).toContain('Node.js')
    expect(detectEcosystems(new Set(['go.mod']))).toContain('Go')
    expect(detectEcosystems(new Set(['Cargo.toml']))).toContain('Rust')
    expect(detectEcosystems(new Set(['pom.xml']))).toContain('Java/Kotlin')
  })
})

describe('formatBytes', () => {
  test('handles zero and negatives', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })

  test('scales through units', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB')
  })

  test('drops the decimal for large values within a unit', () => {
    expect(formatBytes(150 * 1024)).toBe('150 KB')
  })
})

describe('summarizeUsage', () => {
  test('reports empty state', () => {
    expect(summarizeUsage([], 'repository', 'repositories')).toBe('No cached repositories found.')
  })

  test('sorts largest-first and totals', () => {
    const out = summarizeUsage(
      [
        { label: 'a/small', path: '/x/a', bytes: 1024 },
        { label: 'b/big', path: '/x/b', bytes: 5 * 1024 * 1024 },
      ],
      'repository',
      'repositories',
    )
    const lines = out.split('\n')
    expect(lines[0]).toContain('b/big')
    expect(lines[1]).toContain('a/small')
    expect(out).toContain('total across 2 repositories')
  })

  test('singular noun for one entry', () => {
    const out = summarizeUsage(
      [{ label: 'a/b', path: '/x', bytes: 10 }],
      'repository',
      'repositories',
    )
    expect(out).toContain('total across 1 repository')
  })
})

// ---------------------------------------------------------------------------
// Reference config tests
// ---------------------------------------------------------------------------

describe('validateReferenceAlias', () => {
  test('accepts simple alias names', () => {
    expect(() => validateReferenceAlias('docs')).not.toThrow()
    expect(() => validateReferenceAlias('sdk')).not.toThrow()
    expect(() => validateReferenceAlias('my-lib_v2')).not.toThrow()
  })

  test('rejects empty alias', () => {
    expect(() => validateReferenceAlias('')).toThrow()
  })

  test('rejects alias with /', () => {
    expect(() => validateReferenceAlias('foo/bar')).toThrow()
  })

  test('rejects alias with whitespace', () => {
    expect(() => validateReferenceAlias('foo bar')).toThrow()
    expect(() => validateReferenceAlias('foo\tbar')).toThrow()
  })

  test('rejects alias with backticks or commas', () => {
    expect(() => validateReferenceAlias('foo`bar')).toThrow()
    expect(() => validateReferenceAlias('foo,bar')).toThrow()
  })
})

describe('normalizeReferenceConfig', () => {
  test('passes through object configs', () => {
    const config: ReferenceConfig = {
      path: '../docs',
      description: 'Use for docs',
    }
    expect(normalizeReferenceConfig(config)).toEqual(config)
  })

  test('string shorthand: ./ → path', () => {
    expect(normalizeReferenceConfig('./local/docs')).toEqual({ path: './local/docs' })
  })

  test('string shorthand: ../ → path', () => {
    expect(normalizeReferenceConfig('../shared-lib')).toEqual({ path: '../shared-lib' })
  })

  test('string shorthand: ~/ → path', () => {
    expect(normalizeReferenceConfig('~/docs')).toEqual({ path: '~/docs' })
  })

  test('string shorthand: / → path', () => {
    expect(normalizeReferenceConfig('/usr/share/docs')).toEqual({ path: '/usr/share/docs' })
  })

  test('string shorthand: owner/repo → repository', () => {
    expect(normalizeReferenceConfig('facebook/react')).toEqual({ repository: 'facebook/react' })
  })

  test('string shorthand: host/path → repository', () => {
    expect(normalizeReferenceConfig('gitlab.com/group/proj')).toEqual({
      repository: 'gitlab.com/group/proj',
    })
  })
})

describe('buildReferencesContext', () => {
  test('empty refs returns empty string', () => {
    expect(buildReferencesContext({})).toBe('')
  })

  test('refs without descriptions return empty string', () => {
    const refs: Record<string, ResolvedReference> = {
      sdk: {
        alias: 'sdk',
        config: { repository: 'facebook/react' },
        resolvedPath: '/tmp/cache/facebook/react',
        source: 'git',
      },
    }
    expect(buildReferencesContext(refs)).toBe('')
  })

  test('includes described references', () => {
    const refs: Record<string, ResolvedReference> = {
      sdk: {
        alias: 'sdk',
        config: {
          repository: 'facebook/react',
          description: 'Use for React implementation patterns',
        },
        resolvedPath: '/tmp/cache/facebook/react',
        source: 'git',
      },
    }
    const ctx = buildReferencesContext(refs)
    expect(ctx).toContain('PROJECT REFERENCES')
    expect(ctx).toContain('@sdk')
    expect(ctx).toContain('git: facebook/react')
    expect(ctx).toContain('Use for React implementation patterns')
  })

  test('includes git branch when specified', () => {
    const refs: Record<string, ResolvedReference> = {
      sdk: {
        alias: 'sdk',
        config: {
          repository: 'facebook/react',
          branch: 'v18',
          description: 'Use for React 18 patterns',
        },
        resolvedPath: '/tmp/cache/facebook/react',
        source: 'git',
      },
    }
    const ctx = buildReferencesContext(refs)
    expect(ctx).toContain('branch: v18')
  })

  test('includes local references with path', () => {
    const refs: Record<string, ResolvedReference> = {
      docs: {
        alias: 'docs',
        config: {
          path: '../product-docs',
          description: 'Product documentation conventions',
        },
        resolvedPath: '/abs/path/product-docs',
        source: 'local',
      },
    }
    const ctx = buildReferencesContext(refs)
    expect(ctx).toContain('@docs')
    expect(ctx).toContain('local: ../product-docs')
    expect(ctx).toContain('Product documentation conventions')
  })

  test('mixes git and local references', () => {
    const refs: Record<string, ResolvedReference> = {
      sdk: {
        alias: 'sdk',
        config: { repository: 'foo/bar', description: 'SDK ref' },
        resolvedPath: '/cache/foo/bar',
        source: 'git',
      },
      docs: {
        alias: 'docs',
        config: { path: '../docs', description: 'Docs ref' },
        resolvedPath: '/abs/docs',
        source: 'local',
      },
    }
    const ctx = buildReferencesContext(refs)
    expect(ctx).toContain('@sdk')
    expect(ctx).toContain('@docs')
    expect(ctx).toContain('git: foo/bar')
    expect(ctx).toContain('local: ../docs')
  })

  test('hidden refs with description are still included', () => {
    const refs: Record<string, ResolvedReference> = {
      internal: {
        alias: 'internal',
        config: {
          path: '../internal',
          description: 'Internal implementation details',
          hidden: true,
        },
        resolvedPath: '/abs/internal',
        source: 'local',
      },
    }
    const ctx = buildReferencesContext(refs)
    expect(ctx).toContain('@internal')
    expect(ctx).toContain('Internal implementation details')
  })
})
