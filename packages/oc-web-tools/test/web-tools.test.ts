import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  fetchCacheKey,
  htmlToText,
  isImageAttachment,
  paginate,
  parseMcpResponse,
  ResponseCache,
  selectWebSearchProvider,
  truncateText,
} from '../index.ts'

describe('truncateText', () => {
  test('returns text unchanged when within limit', () => {
    expect(truncateText('hello', 10)).toBe('hello')
  })

  test('truncates and annotates when over limit', () => {
    const out = truncateText('abcdefghij', 4)
    expect(out.startsWith('abcd')).toBe(true)
    expect(out).toContain('6 characters truncated')
  })
})

describe('isImageAttachment', () => {
  test('recognizes known image mimes (with params)', () => {
    expect(isImageAttachment('image/png')).toBe(true)
    expect(isImageAttachment('image/jpeg; charset=binary')).toBe(true)
    expect(isImageAttachment('IMAGE/WEBP')).toBe(true)
  })

  test('rejects non-image mimes', () => {
    expect(isImageAttachment('text/html')).toBe(false)
    expect(isImageAttachment('')).toBe(false)
  })
})

describe('htmlToText', () => {
  test('strips tags and script/style content', () => {
    const out = htmlToText('<p>Hello <b>world</b></p><script>evil()</script><style>x{}</style>')
    expect(out).toContain('Hello')
    expect(out).toContain('world')
    expect(out).not.toContain('evil')
    expect(out).not.toContain('x{}')
  })

  test('collapses excess whitespace', () => {
    expect(htmlToText('<div>a</div>\n\n\n\n<div>b</div>')).not.toContain('\n\n\n')
  })
})

describe('parseMcpResponse', () => {
  test('parses direct JSON result content', () => {
    const body = JSON.stringify({
      result: { content: [{ type: 'text', text: 'answer' }] },
    })
    expect(parseMcpResponse(body)).toBe('answer')
  })

  test('parses SSE data lines', () => {
    const payload = JSON.stringify({ result: { content: [{ type: 'text', text: 'sse-answer' }] } })
    const body = `event: message\ndata: ${payload}\n\n`
    expect(parseMcpResponse(body)).toBe('sse-answer')
  })

  test('surfaces JSON-RPC errors', () => {
    const body = JSON.stringify({ error: { code: -32000, message: 'boom' } })
    expect(parseMcpResponse(body)).toBe('MCP error [-32000]: boom')
  })

  test('returns undefined on unparseable body', () => {
    expect(parseMcpResponse('not json')).toBeUndefined()
  })
})

describe('selectWebSearchProvider', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    delete process.env.OC_WEBSEARCH_PROVIDER
    delete process.env.EXA_API_KEY
    delete process.env.PARALLEL_API_KEY
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  test('honors explicit override', () => {
    process.env.OC_WEBSEARCH_PROVIDER = 'parallel'
    expect(selectWebSearchProvider()).toBe('parallel')
  })

  test('prefers parallel when its key is set', () => {
    process.env.PARALLEL_API_KEY = 'k'
    expect(selectWebSearchProvider()).toBe('parallel')
  })

  test('uses exa when only exa key is set', () => {
    process.env.EXA_API_KEY = 'k'
    expect(selectWebSearchProvider()).toBe('exa')
  })

  test('falls back to exa with no keys', () => {
    expect(selectWebSearchProvider()).toBe('exa')
  })
})

describe('paginate', () => {
  test('returns whole text when it fits in the window', () => {
    const p = paginate('hello', 0, 50_000)
    expect(p.text).toBe('hello')
    expect(p.total).toBe(5)
    expect(p.offset).toBe(0)
    expect(p.nextOffset).toBeUndefined()
  })

  test('windows long text and reports nextOffset', () => {
    const p = paginate('abcdefghij', 0, 4)
    expect(p.text).toBe('abcd')
    expect(p.nextOffset).toBe(4)
    expect(p.total).toBe(10)
  })

  test('continues from a given offset to the end', () => {
    const p = paginate('abcdefghij', 8, 4)
    expect(p.text).toBe('ij')
    expect(p.offset).toBe(8)
    expect(p.nextOffset).toBeUndefined()
  })

  test('clamps negative and out-of-range offsets', () => {
    expect(paginate('abc', -5, 10).offset).toBe(0)
    const past = paginate('abc', 99, 10)
    expect(past.offset).toBe(3)
    expect(past.text).toBe('')
    expect(past.nextOffset).toBeUndefined()
  })
})

describe('fetchCacheKey', () => {
  test('distinguishes by url and format', () => {
    expect(fetchCacheKey('https://x', 'markdown')).not.toBe(fetchCacheKey('https://x', 'text'))
    expect(fetchCacheKey('https://x', 'markdown')).toBe(fetchCacheKey('https://x', 'markdown'))
  })
})

describe('ResponseCache', () => {
  const entry = { output: 'body', contentType: 'text/html', sizeBytes: 4 }

  test('stores and retrieves before TTL', () => {
    let now = 1000
    const cache = new ResponseCache(5_000, 10, () => now)
    cache.set('k', entry)
    expect(cache.get('k')).toEqual(entry)
    now = 5999
    expect(cache.get('k')).toEqual(entry)
  })

  test('expires entries after TTL', () => {
    let now = 1000
    const cache = new ResponseCache(5_000, 10, () => now)
    cache.set('k', entry)
    now = 6001
    expect(cache.get('k')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  test('evicts least-recently-used past the cap', () => {
    const cache = new ResponseCache(60_000, 2, () => 0)
    cache.set('a', entry)
    cache.set('b', entry)
    cache.get('a') // touch a → b becomes LRU
    cache.set('c', entry)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBeDefined()
    expect(cache.get('c')).toBeDefined()
  })
})
