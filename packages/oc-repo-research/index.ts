// @pi-acp-compatible

import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GIT_TIMEOUT = 120_000 // 2 minutes
const STRUCTURE_LIMIT = 200
const DEFAULT_DEPTH = 3
const MAX_DEPTH = 6
const MIN_DEPTH = 1

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  'target',
  'vendor',
  '.idea',
  '.vscode',
])

const DEPENDENCY_FILES = [
  'package.json',
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'yarn.lock',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'Gemfile',
  'build.gradle',
  'build.gradle.kts',
  'pom.xml',
  'composer.json',
]

const REPOS_DIR = path.join(homedir(), '.pi', 'agent', 'repos')

// Git configuration flags to ensure consistent behavior (ported from opencode)
const GIT_CONFIG = [
  '--no-optional-locks',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.longpaths=true',
  '-c',
  'core.symlinks=true',
  '-c',
  'core.quotepath=false',
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RemoteReference {
  host: string
  path: string
  segments: string[]
  owner?: string
  repo: string
  remote: string
  label: string
  protocol?: string
}

interface CloneResult {
  repository: string
  host: string
  remote: string
  localPath: string
  status: 'cached' | 'cloned' | 'refreshed'
  head?: string
  branch?: string
}

interface OverviewMetadata {
  path: string
  repository?: string
  branch?: string
  head?: string
  packageManager?: string
  ecosystems: string[]
  dependencyFiles: string[]
  entrypoints: string[]
  depth: number
  truncated: boolean
}

// ---------------------------------------------------------------------------
// Git execution helper
// ---------------------------------------------------------------------------

interface GitResult {
  code: number
  stdout: string
  stderr: string
}

async function git(
  args: string[],
  cwd: string,
  opts: { timeout?: number; env?: Record<string, string> } = {},
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', [...GIT_CONFIG, ...args], {
      cwd,
      timeout: opts.timeout ?? GIT_TIMEOUT,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const execError = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean }
    if (execError.killed) {
      return {
        code: -1,
        stdout: '',
        stderr: `Command timed out after ${(opts.timeout ?? GIT_TIMEOUT) / 1000}s`,
      }
    }
    return {
      code: execError.code ?? -1,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? String(error),
    }
  }
}

async function gitText(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd)
  return result.code === 0 ? result.stdout.trim() : ''
}

async function gitLines(args: string[], cwd: string): Promise<string[]> {
  const text = await gitText(args, cwd)
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Repository reference parser (ported from opencode util/repository.ts)
// ---------------------------------------------------------------------------

function normalizeRepositoryInput(input: string): string {
  return input
    .trim()
    .replace(/^git\+/, '')
    .replace(/#.*$/, '')
    .replace(/\/+$/, '')
}

function trimGitSuffix(input: string): string {
  return input.replace(/\.git$/, '')
}

function parts(input: string): string[] {
  return input
    .split('/')
    .map((item) => trimGitSuffix(item.trim()))
    .filter(Boolean)
}

function safeHost(input: string): boolean {
  return Boolean(input) && !input.startsWith('-') && !/[\s/\\]/.test(input)
}

function safeSegment(input: string): boolean {
  return input !== '.' && input !== '..' && !input.includes(':') && !/[\s/\\]/.test(input)
}

function hostLike(input: string): boolean {
  return input.includes('.') || input.includes(':') || input === 'localhost'
}

function withSlash(input: string): string {
  return input.endsWith('/') ? input : `${input}/`
}

function githubRemote(pathname: string): string {
  const base = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
  if (!base) return `https://github.com/${pathname}.git`
  return new URL(`${pathname}.git`, withSlash(base)).href
}

function buildRemoteReference(input: {
  host: string
  segments: string[]
  remote?: string
  protocol?: string
}): RemoteReference | null {
  const segs = input.segments.map(trimGitSuffix).filter(Boolean)
  if (!safeHost(input.host) || !segs.length || segs.some((seg) => !safeSegment(seg))) {
    return null
  }
  const pathname = segs.join('/')
  const repo = segs[segs.length - 1]
  const host = input.host.toLowerCase()
  return {
    host,
    path: pathname,
    segments: segs,
    owner: segs.length === 2 ? segs[0] : undefined,
    repo,
    remote:
      input.remote ??
      (host === 'github.com' ? githubRemote(pathname) : `https://${host}/${pathname}.git`),
    label: host === 'github.com' && segs.length === 2 ? pathname : `${host}/${pathname}`,
    protocol: input.protocol,
  }
}

function parseRepositoryReference(input: string): RemoteReference | null {
  const cleaned = normalizeRepositoryInput(input)
  if (!cleaned) return null

  // github:owner/repo prefix
  const githubPrefixed = cleaned.match(/^github:([^/\s]+)\/([^/\s]+)$/)
  if (githubPrefixed) {
    return buildRemoteReference({
      host: 'github.com',
      segments: [githubPrefixed[1], githubPrefixed[2]],
    })
  }

  // SCP-style: git@host:path or host:path
  if (!cleaned.includes('://')) {
    const scp = cleaned.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/)
    if (scp) return buildRemoteReference({ host: scp[1], segments: parts(scp[2]), remote: cleaned })

    // host/path or owner/repo
    const direct = parts(cleaned)
    if (direct.length >= 2 && hostLike(direct[0])) {
      return buildRemoteReference({ host: direct[0], segments: direct.slice(1) })
    }

    // owner/repo → GitHub
    if (direct.length === 2) {
      return buildRemoteReference({ host: 'github.com', segments: direct })
    }
  }

  // URL parsing
  try {
    const url = new URL(cleaned)
    if (url.protocol === 'file:') return null // file repos not supported
    const pathname = parts(url.pathname)
    const host = url.host
    return buildRemoteReference({
      host,
      segments: pathname,
      remote: host === 'github.com' ? githubRemote(pathname.join('/')) : cleaned,
      protocol: url.protocol,
    })
  } catch {
    return null
  }
}

function parseRemoteReference(repository: string): RemoteReference {
  const reference = parseRepositoryReference(repository)
  if (!reference) {
    throw new Error(
      'Repository must be a git URL, host/path reference, or GitHub owner/repo shorthand',
    )
  }
  return reference
}

function validateBranch(branch: string): void {
  if (!/^[A-Za-z0-9/_.-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..')) {
    throw new Error(
      'Branch must contain only alphanumeric characters, /, _, ., and -, and cannot start with - or contain ..',
    )
  }
}

function repositoryCachePath(ref: RemoteReference): string {
  return path.join(REPOS_DIR, ...ref.host.split(':'), ...ref.segments)
}

function sameRepositoryReference(left: RemoteReference, right: RemoteReference): boolean {
  return `${left.host}/${left.path}` === `${right.host}/${right.path}`
}

// ---------------------------------------------------------------------------
// Repository cloner
// ---------------------------------------------------------------------------

async function cloneOrRefresh(
  ref: RemoteReference,
  opts: { refresh?: boolean; branch?: string },
): Promise<CloneResult> {
  const repository = ref.label
  const remote = ref.remote
  const localPath = repositoryCachePath(ref)
  const cloneTarget = parseRepositoryReference(remote) ?? ref

  // Ensure cache directory exists
  await mkdir(path.dirname(localPath), { recursive: true })

  // Check if already cloned
  const hasGitDir = await stat(path.join(localPath, '.git'))
    .then(() => true)
    .catch(() => false)

  let originUrl = ''
  if (hasGitDir) {
    originUrl = await gitText(['config', '--get', 'remote.origin.url'], localPath)
  }

  const originRef = originUrl ? parseRepositoryReference(originUrl) : null
  const reuseOrigin =
    hasGitDir && Boolean(originRef && sameRepositoryReference(originRef, cloneTarget))
  const exists = await stat(localPath)
    .then(() => true)
    .catch(() => false)

  // Remove stale cache
  if (exists && !reuseOrigin) {
    await rm(localPath, { recursive: true, force: true })
  }

  const currentBranch = hasGitDir
    ? await gitText(['symbolic-ref', '--quiet', '--short', 'HEAD'], localPath)
    : ''
  const branchMatches = opts.branch ? currentBranch === opts.branch : undefined
  const reuse = reuseOrigin

  let status: CloneResult['status']
  if (!reuse) {
    status = 'cloned'
  } else if (branchMatches === false || opts.refresh) {
    status = 'refreshed'
  } else {
    status = 'cached'
  }

  // Clone
  if (status === 'cloned') {
    const cloneArgs = [
      'clone',
      '--depth',
      '100',
      ...(opts.branch ? ['--branch', opts.branch] : []),
      '--',
      remote,
      localPath,
    ]
    const result = await git(cloneArgs, path.dirname(localPath))
    if (result.code !== 0) {
      throw new Error(
        `Clone failed: ${result.stderr.trim() || result.stdout.trim() || `Failed to clone ${repository}`}`,
      )
    }
  }

  // Refresh
  if (status === 'refreshed') {
    const fetchResult = await git(['fetch', '--all', '--prune'], localPath)
    if (fetchResult.code !== 0) {
      throw new Error(
        `Fetch failed: ${fetchResult.stderr.trim() || fetchResult.stdout.trim() || `Failed to refresh ${repository}`}`,
      )
    }

    // Checkout branch if specified
    if (opts.branch) {
      const checkoutResult = await git(
        ['checkout', '-B', opts.branch, `origin/${opts.branch}`],
        localPath,
      )
      if (checkoutResult.code !== 0) {
        throw new Error(
          `Checkout failed: ${checkoutResult.stderr.trim() || checkoutResult.stdout.trim() || `Failed to checkout ${opts.branch}`}`,
        )
      }
    }

    // Determine reset target
    const remoteHeadResult = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], localPath)
    const branchResult = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], localPath)

    let target: string
    if (opts.branch) {
      target = `origin/${opts.branch}`
    } else if (remoteHeadResult.code === 0 && remoteHeadResult.stdout.trim()) {
      target = remoteHeadResult.stdout.trim().replace(/^refs\/remotes\//, '')
    } else if (branchResult.code === 0 && branchResult.stdout.trim()) {
      target = `origin/${branchResult.stdout.trim()}`
    } else {
      target = 'HEAD'
    }

    // Hard reset to target
    const resetResult = await git(['reset', '--hard', target], localPath)
    if (resetResult.code !== 0) {
      throw new Error(
        `Reset failed: ${resetResult.stderr.trim() || resetResult.stdout.trim() || `Failed to reset ${repository}`}`,
      )
    }
  }

  // Gather final state
  const headResult = await git(['rev-parse', 'HEAD'], localPath)
  const branchName =
    (await gitText(['symbolic-ref', '--quiet', '--short', 'HEAD'], localPath)) || undefined

  return {
    repository,
    host: ref.host,
    remote,
    localPath,
    status,
    head: headResult.code === 0 ? headResult.stdout.trim() : undefined,
    branch: branchName,
  }
}

// ---------------------------------------------------------------------------
// Repository overview
// ---------------------------------------------------------------------------

function detectPackageManager(files: Set<string>): string | undefined {
  if (files.has('bun.lock') || files.has('bun.lockb')) return 'bun'
  if (files.has('pnpm-lock.yaml')) return 'pnpm'
  if (files.has('yarn.lock')) return 'yarn'
  if (files.has('package-lock.json')) return 'npm'
  return undefined
}

function detectEcosystems(files: Set<string>): string[] {
  const ecosystems: string[] = []
  if (files.has('package.json')) ecosystems.push('Node.js')
  if (files.has('pyproject.toml') || files.has('requirements.txt')) ecosystems.push('Python')
  if (files.has('go.mod')) ecosystems.push('Go')
  if (files.has('Cargo.toml')) ecosystems.push('Rust')
  if (files.has('Gemfile')) ecosystems.push('Ruby')
  if (files.has('build.gradle') || files.has('build.gradle.kts') || files.has('pom.xml')) {
    ecosystems.push('Java/Kotlin')
  }
  if (files.has('composer.json')) ecosystems.push('PHP')
  return ecosystems
}

function detectEntrypoints(files: Set<string>, packageJson: Record<string, unknown>): string[] {
  const entrypoints: string[] = []

  // From package.json
  if (typeof packageJson.main === 'string') entrypoints.push(`main: ${packageJson.main}`)
  if (typeof packageJson.module === 'string') entrypoints.push(`module: ${packageJson.module}`)
  if (typeof packageJson.types === 'string') entrypoints.push(`types: ${packageJson.types}`)
  if (typeof packageJson.bin === 'string') {
    entrypoints.push(`bin: ${packageJson.bin}`)
  } else if (
    packageJson.bin &&
    typeof packageJson.bin === 'object' &&
    !Array.isArray(packageJson.bin)
  ) {
    for (const name of Object.keys(packageJson.bin as Record<string, unknown>)) {
      entrypoints.push(`bin: ${name}`)
    }
  }
  if (
    packageJson.exports &&
    typeof packageJson.exports === 'object' &&
    !Array.isArray(packageJson.exports)
  ) {
    for (const name of Object.keys(packageJson.exports as Record<string, unknown>).slice(0, 10)) {
      entrypoints.push(`exports: ${name}`)
    }
  }

  // Common patterns
  const commonPatterns = [
    'index.ts',
    'index.tsx',
    'index.js',
    'index.mjs',
    'main.ts',
    'main.js',
    'src/index.ts',
    'src/index.tsx',
    'src/index.js',
    'src/main.ts',
    'src/main.js',
  ]
  for (const pattern of commonPatterns) {
    if (files.has(pattern)) {
      entrypoints.push(`file: ${pattern}`)
    }
  }

  return entrypoints
}

interface DirEntry {
  name: string
  isDir: boolean
}

async function walkStructure(
  dir: string,
  depth: number,
  currentLevel: number,
): Promise<{ lines: string[]; truncated: boolean }> {
  const lines: string[] = []

  async function visit(d: string, level: number): Promise<boolean> {
    if (level >= depth || lines.length >= STRUCTURE_LIMIT) {
      return lines.length >= STRUCTURE_LIMIT
    }

    let entries: DirEntry[]
    try {
      const names = await readdir(d)
      entries = await Promise.all(
        names.map(async (name): Promise<DirEntry | null> => {
          if (IGNORED_DIRS.has(name)) return null
          const full = path.join(d, name)
          try {
            const info = await stat(full)
            return { name, isDir: info.isDirectory() }
          } catch {
            return null
          }
        }),
      ).then((items) => items.filter((item): item is DirEntry => item !== null))
    } catch {
      return false
    }

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (lines.length >= STRUCTURE_LIMIT) return true

      const prefix = '  '.repeat(level)
      lines.push(`${prefix}${entry.name}${entry.isDir ? '/' : ''}`)

      if (entry.isDir) {
        const truncated = await visit(path.join(d, entry.name), level + 1)
        if (truncated) return true
      }
    }
    return false
  }

  const truncated = await visit(dir, currentLevel)
  return { lines, truncated }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const REPO_CLONE_DESCRIPTION = `Clones a remote git repository into a managed local cache directory.
Once cloned, you can inspect the repository with the repo_overview tool, and use read/glob/grep tools on the cached path.

The repository is cached at ~/.pi/agent/repos/<host>/<path> and will be reused across sessions.
Subsequent calls with the same repository reference use the cache (unless refresh is set to true).

Supported repository reference formats:
  - GitHub shorthand: "owner/repo" (e.g., "facebook/react")
  - github: prefix: "github:owner/repo"
  - HTTPS URLs: "https://github.com/owner/repo.git"
  - SSH/SCP-style: "git@github.com:owner/repo.git"`

const REPO_OVERVIEW_DESCRIPTION = `Inspects the structure of a cached or local repository directory.
Use this after repo_clone to get a high-level understanding of a repository's layout.

Reports:
  - Top-level directory tree (up to the specified depth)
  - Detected language ecosystems (Node.js, Python, Go, Rust, Ruby, Java/Kotlin, PHP)
  - Package manager (npm, yarn, pnpm, bun)
  - Dependency files found
  - Likely entrypoints from package.json and common patterns
  - Current git branch and HEAD SHA

Specify "repository" to inspect a previously cloned repo, or "path" to inspect any local directory.
Either "repository" or "path" must be provided.`

export default function repoResearch(pi: ExtensionAPI) {
  // -----------------------------------------------------------------------
  // repo_clone tool
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: 'repo_clone',
    label: 'Clone Repository',
    description: REPO_CLONE_DESCRIPTION,
    promptSnippet: 'Clone a git repository into a managed cache for inspection',
    promptGuidelines: [
      'Use repo_clone to clone remote repositories for research and analysis.',
      'Supports GitHub shorthand (owner/repo), full git URLs, and SCP-style references.',
      'Once cloned, use repo_overview to inspect the structure, then read/glob/grep on the cached path.',
      'Set refresh=true to fetch the latest remote state into an existing cache.',
      'Set branch to clone a specific branch or tag.',
      'The cached repository path is returned in the output — use it directly with read, glob, and grep.',
    ],
    parameters: Type.Object({
      repository: Type.String({
        description:
          'Repository to clone, as a git URL, host/path reference, or GitHub owner/repo shorthand',
      }),
      refresh: Type.Optional(
        Type.Boolean({
          description: 'When true, fetches the latest remote state into the managed cache',
        }),
      ),
      branch: Type.Optional(
        Type.String({
          description: 'Branch or ref to clone and inspect',
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const repository = params.repository as string
      const refresh = (params.refresh as boolean) || false
      const branch = params.branch as string | undefined

      // Validate
      if (branch) validateBranch(branch)

      const ref = parseRemoteReference(repository)

      // Clone or refresh
      const result = await cloneOrRefresh(ref, { refresh, branch })

      // Format output
      const lines = [
        `Repository ready: ${result.repository}`,
        `Status: ${result.status}`,
        `Local path: ${result.localPath}`,
      ]
      if (result.branch) lines.push(`Branch: ${result.branch}`)
      if (result.head) lines.push(`HEAD: ${result.head}`)

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        details: result,
      }
    },
  })

  // -----------------------------------------------------------------------
  // repo_overview tool
  // -----------------------------------------------------------------------

  pi.registerTool({
    name: 'repo_overview',
    label: 'Repository Overview',
    description: REPO_OVERVIEW_DESCRIPTION,
    promptSnippet: 'Inspect repository structure, detect ecosystems and entrypoints',
    promptGuidelines: [
      "Use repo_overview after repo_clone to understand a repository's layout before diving into files.",
      'Reports directory structure, detected ecosystems, package manager, dependency files, and entrypoints.',
      'Use "repository" to inspect a previously cloned repo, or "path" for any local directory.',
      'The depth parameter controls how deep the directory tree goes (1-6, default 3).',
      'Either "repository" or "path" must be provided.',
    ],
    parameters: Type.Object({
      repository: Type.Optional(
        Type.String({
          description:
            'Cached repository to inspect, as a git URL, host/path reference, or GitHub owner/repo shorthand',
        }),
      ),
      path: Type.Optional(
        Type.String({
          description:
            'Directory path to inspect instead of a cached repository. Must be an absolute path or relative to the current working directory.',
        }),
      ),
      depth: Type.Optional(
        Type.Number({
          description: 'Maximum structure depth to include. Defaults to 3, max 6.',
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const repository = params.repository as string | undefined
      const dirPath = params.path as string | undefined
      const depthRaw = params.depth as number | undefined

      if (!repository && !dirPath) {
        throw new Error('Either repository or path must be provided')
      }

      // Resolve depth
      const depth =
        depthRaw && Number.isInteger(depthRaw) && depthRaw >= MIN_DEPTH && depthRaw <= MAX_DEPTH
          ? depthRaw
          : DEFAULT_DEPTH

      // Resolve target path
      let targetPath: string
      let repoLabel: string | undefined

      if (dirPath) {
        targetPath = path.isAbsolute(dirPath) ? dirPath : path.resolve(process.cwd(), dirPath)
      } else if (repository) {
        const ref = parseRemoteReference(repository)
        targetPath = repositoryCachePath(ref)
        repoLabel = ref.label
      } else {
        throw new Error('Either repository or path must be provided')
      }

      // Check path exists
      const info = await stat(targetPath).catch(() => null)
      if (!info) {
        if (repoLabel) {
          throw new Error(
            `Repository is not cloned: ${repoLabel}. Use repo_clone first to clone it.`,
          )
        }
        throw new Error(`Directory not found: ${targetPath}`)
      }
      if (!info.isDirectory()) {
        throw new Error(`Path is not a directory: ${targetPath}`)
      }

      // Get git branch and HEAD
      const branch = await gitText(
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        targetPath,
      ).catch(() => '')
      const head = await gitText(['rev-parse', 'HEAD'], targetPath).catch(() => '')

      // Read top-level directory and detect files
      const names = await readdir(targetPath).catch(() => [] as string[])
      const topLevel = new Set(names)
      const dependencyFiles = DEPENDENCY_FILES.filter((file) => topLevel.has(file))

      // Parse package.json if present
      let packageJson: Record<string, unknown> = {}
      if (topLevel.has('package.json')) {
        try {
          const pkgContent = await readFile(path.join(targetPath, 'package.json'), 'utf-8')
          packageJson = JSON.parse(pkgContent)
        } catch {
          // ignore parse errors
        }
      }

      // Walk directory structure
      const structureResult = await walkStructure(targetPath, depth, 0)

      // Detect metadata
      const ecosystems = detectEcosystems(topLevel)
      const packageManager = detectPackageManager(topLevel)
      const entrypoints = detectEntrypoints(topLevel, packageJson)

      const outputLines: string[] = [`Path: ${targetPath}`]
      if (repoLabel) outputLines.push(`Repository: ${repoLabel}`)
      if (branch) outputLines.push(`Branch: ${branch}`)
      if (head) outputLines.push(`HEAD: ${head}`)
      if (ecosystems.length) outputLines.push(`Ecosystems: ${ecosystems.join(', ')}`)
      if (packageManager) outputLines.push(`Package manager: ${packageManager}`)
      if (dependencyFiles.length) {
        outputLines.push(`Dependency files: ${dependencyFiles.join(', ')}`)
      }
      if (entrypoints.length) {
        outputLines.push('Likely entrypoints:', ...entrypoints.map((e) => `- ${e}`))
      }
      outputLines.push('Top-level structure:')
      outputLines.push(...structureResult.lines)
      if (structureResult.truncated) {
        outputLines.push('(Structure truncated — use a smaller depth or explore subdirectories)')
      }

      const metadata: OverviewMetadata = {
        path: targetPath,
        repository: repoLabel,
        branch: branch || undefined,
        head: head || undefined,
        packageManager,
        ecosystems,
        dependencyFiles,
        entrypoints,
        depth,
        truncated: structureResult.truncated,
      }

      return {
        content: [{ type: 'text', text: outputLines.join('\n') }],
        details: metadata,
      }
    },
  })
}
