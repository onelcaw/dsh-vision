// dsh-vision: image-recognition bridge for DeepSeek Harness (dsh).
//
// What it adds, in two independent pieces:
//   1. a `vision_read_image` tool — reads a local file path or http(s) URL and
//      returns the image content transcribed as text;
//   2. a `(vision)` provider wrapper — clones the text-only DeepSeek models as
//      `(vision)` variants that declare image input, so pasted/uploaded images
//      are admitted and converted to text at request time (before the real
//      text-only model sees them).
//
// Engine: any OpenAI-compatible `/chat/completions` vision endpoint. Configure
// it in ~/.dsh-vision/config.json (baseUrl + apiKey + model). This file is
// dependency-free on purpose (node builtins only), like the modlens plugin it
// borrows its shape from, so out-of-tree package resolution is never a problem.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'

export const name = 'dsh-vision'
export const inject = ['tools', 'agents', 'attachments', 'llm']

const CONFIG_DIR = join(homedir(), '.dsh-vision')
const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  prompt:
    'Transcribe this image in full detail. Reproduce all visible text (OCR) verbatim, and describe charts, diagrams, tables, UI screenshots, photos, and documents precisely and concretely.',
  maxTokens: 2048,
  timeoutMs: 120000,
  maxImageBytes: 25 * 1024 * 1024,
}

const MIME_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

// DeepSeek's own vision models (and GLM's) need no bridge; skip them.
const VISION_ID = /(deepseek-(vl|ocr)|janus|glm-[\d.]*v(\b|-))/i

const EVIDENCE_CACHE_LIMIT = 64

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export function loadConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config file must hold a JSON object')
    }
    return { ...DEFAULTS, ...parsed }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...DEFAULTS }
    console.error(`[dsh-vision] cannot read ${CONFIG_PATH}: ${error?.message ?? error}`)
    return { ...DEFAULTS }
  }
}

function ensureConfigFile() {
  try {
    if (existsSync(CONFIG_PATH)) return
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o600 })
    chmodSync(CONFIG_PATH, 0o600)
  } catch (error) {
    console.error(`[dsh-vision] cannot write ${CONFIG_PATH}: ${error?.message ?? error}`)
  }
}

// ---------------------------------------------------------------------------
// vision engine (OpenAI-compatible /chat/completions)
// ---------------------------------------------------------------------------

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value)
}

function mimeForPath(path) {
  return MIME_EXT[extname(path).toLowerCase()] ?? 'image/png'
}

async function readImageBytes(pathOrUrl, maxBytes, signal) {
  if (isHttpUrl(pathOrUrl)) {
    const resp = await fetch(pathOrUrl, { signal })
    if (!resp.ok) throw new Error(`download failed (HTTP ${resp.status}) for ${pathOrUrl}`)
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length > maxBytes) throw new Error(`image over the ${maxBytes}-byte limit`)
    const mime = resp.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
    return { mime, base64: buf.toString('base64') }
  }
  const buf = readFileSync(pathOrUrl)
  if (buf.length > maxBytes) throw new Error(`image over the ${maxBytes}-byte limit`)
  return { mime: mimeForPath(pathOrUrl), base64: buf.toString('base64') }
}

/**
 * @param config - merged config from loadConfig()
 * @param imageRef - { kind:'base64', mime, base64 } or { kind:'url', url }
 * @param prompt - text prompt for the vision model
 * @param signal - optional AbortSignal
 * @returns the vision model's text answer
 */
export async function describeImage(config, imageRef, prompt, signal) {
  const { baseUrl, apiKey, model, maxTokens, timeoutMs } = config
  if (!model) {
    throw new Error('no vision model configured: set "model" in ~/.dsh-vision/config.json')
  }
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const imageUrl =
    imageRef.kind === 'url'
      ? imageRef.url
      : `data:${imageRef.mime};base64,${imageRef.base64}`
  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: maxTokens,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 500)
      throw new Error(`vision API HTTP ${resp.status}: ${detail}`)
    }
    const json = await resp.json()
    const text = json?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error('vision API returned no text content')
    }
    return text.trim()
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// tool: vision_read_image
// ---------------------------------------------------------------------------

function readImageTool(toolName) {
  return {
    name: toolName,
    description:
      'Read an image through the vision bridge. Use whenever a message references an image the current model cannot see: a local file path or an http(s) URL to a screenshot, photo, chart, diagram, or document scan. Returns the image content transcribed as text. Requires ~/.dsh-vision/config.json to be configured with a vision model.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute local file path or http(s) URL of the image',
        },
        prompt: {
          type: 'string',
          description: 'Optional extra focus (e.g. "focus on the axis labels")',
        },
      },
      required: ['path'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value?.text ?? '' }],
    },
    timeoutMs: 140000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({
      card: 'generic',
      title: toolName,
      kind: 'read',
      rawInput: args,
      ...(typeof args?.path === 'string' && !isHttpUrl(args.path)
        ? { locations: [{ path: args.path }] }
        : {}),
    }),
    async execute(args, exec) {
      if (typeof args?.path !== 'string' || args.path.trim() === '') {
        throw new Error(`${toolName} needs a non-empty string "path".`)
      }
      const cfg = loadConfig()
      const bytes = await readImageBytes(args.path, cfg.maxImageBytes, exec.signal)
      const text = await describeImage(
        cfg,
        { kind: 'base64', ...bytes },
        args.prompt || cfg.prompt,
        exec.signal,
      )
      return { text }
    },
  }
}

// ---------------------------------------------------------------------------
// image-block -> text conversion (used by the vision wrapper and auto-read)
// ---------------------------------------------------------------------------

function contentHasImage(blocks) {
  return (
    Array.isArray(blocks) &&
    blocks.some(
      (b) =>
        b?.type === 'image' ||
        (b?.type === 'tool-result' && contentHasImage(b.content)),
    )
  )
}

async function convertBlocks(blocks, convertOne) {
  const out = []
  for (const block of blocks) {
    if (block?.type === 'image') {
      out.push(await convertOne(block))
    } else if (block?.type === 'tool-result' && contentHasImage(block.content)) {
      out.push({ ...block, content: await convertBlocks(block.content, convertOne) })
    } else {
      out.push(block)
    }
  }
  return out
}

async function convertImagesToEvidence(ctx, messages, signal, adapter) {
  const out = []
  for (const message of messages) {
    if (!contentHasImage(message.content)) {
      out.push(message)
      continue
    }
    const content = await convertBlocks(message.content, (block) =>
      cachedEvidence(ctx, adapter, block, signal),
    )
    out.push({ ...message, content })
  }
  return out
}

function cachedEvidence(ctx, adapter, block, signal) {
  const key = JSON.stringify(block.attachment ?? block)
  const hit = adapter.evidenceCache.get(key)
  if (hit !== undefined) {
    adapter.evidenceCache.delete(key)
    adapter.evidenceCache.set(key, hit)
    return hit
  }
  const pending = readImageBlock(ctx, block).then(
    (evidence) => {
      if (!evidence.ok && adapter.evidenceCache.get(key) === pending) {
        adapter.evidenceCache.delete(key)
      }
      return evidence.block
    },
    () => {
      if (adapter.evidenceCache.get(key) === pending) adapter.evidenceCache.delete(key)
      return { type: 'text', text: '[A pasted image could not be read by the vision bridge.]' }
    },
  )
  adapter.evidenceCache.set(key, pending)
  while (adapter.evidenceCache.size > EVIDENCE_CACHE_LIMIT) {
    adapter.evidenceCache.delete(adapter.evidenceCache.keys().next().value)
  }
  return pending
}

async function readImageBlock(ctx, block) {
  try {
    const stored = await ctx.attachments.readImage(block.attachment, undefined)
    if (!stored?.data) {
      throw new Error("attachments.readImage returned no 'data' bytes")
    }
    const mediaType = stored.ref?.mediaType ?? block.attachment?.mediaType ?? 'image/png'
    const cfg = loadConfig()
    const base64 = Buffer.from(stored.data).toString('base64')
    const text = await describeImage(cfg, { kind: 'base64', mime: mediaType, base64 }, cfg.prompt, undefined)
    return {
      ok: true,
      block: { type: 'text', text: `[Pasted image, read by the vision bridge]\n${text}` },
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      block: {
        type: 'text',
        text: `[A pasted image could not be read by the vision bridge: ${detail}. Configure ~/.dsh-vision/config.json with a vision model.]`,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// vision provider wrapper: registers a `(vision)` model variant
// ---------------------------------------------------------------------------

function registerVisionProvider(ctx, config) {
  const upstream = config.upstream || 'deepseek-official'
  const providerId = config.providerId || 'deepseek-vision'
  const displayName = config.displayName || 'DeepSeek (vision)'

  if (typeof ctx.llm?.registerAdapter !== 'function' || typeof ctx.llm?.stream !== 'function') {
    console.error('[dsh-vision] llm registration surface unavailable; vision wrapper skipped')
    return
  }

  const shouldWrap = (info) => {
    const id = String(info?.id ?? '').toLowerCase()
    if (VISION_ID.test(id)) return false
    if (Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')) return false
    return true
  }

  const withVision = (info) => ({
    ...info,
    provider: providerId,
    inputModalities: ['text', 'image'],
  })

  try {
    ctx.llm.registerAdapter([providerId], {
      providerInfo(provider) {
        return { id: provider, name: displayName }
      },
      providerRetryPolicy() {
        return undefined
      },
      async listModels(_provider, signal) {
        try {
          const models = await ctx.llm.listModels(upstream, signal)
          return models
            .filter(shouldWrap)
            .map((model) => ({
              ...withVision(model),
              name: `${model.name ?? model.id} (vision)`,
            }))
        } catch {
          return []
        }
      },
      async resolveModel(_provider, model, signal) {
        const info = await ctx.llm.resolveModelInfo(upstream, model, signal)
        if (!shouldWrap(info)) {
          throw new Error(`model "${model}" is outside the vision wrap scope`)
        }
        return { ...withVision(info), id: model }
      },
      stream(options) {
        const self = this
        return (async function* () {
          const messages = await convertImagesToEvidence(ctx, options.messages, options.signal, self)
          yield* ctx.llm.stream({ ...options, provider: upstream, messages })
        })()
      },
      evidenceCache: new Map(),
    })
  } catch (error) {
    console.error(`[dsh-vision] vision provider registration skipped (${providerId}): ${error}`)
  }
}

// ---------------------------------------------------------------------------
// optional pre-step auto-read (off by default; the wrapper already converts)
// ---------------------------------------------------------------------------

function registerAutoRead(ctx) {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (!decision.messages.some((message) => contentHasImage(message.content))) return decision
    const messages = []
    for (const message of decision.messages) {
      if (!contentHasImage(message.content)) {
        messages.push(message)
        continue
      }
      const content = await convertBlocks(message.content, async (block) => (await readImageBlock(ctx, block)).block)
      messages.push({ ...message, content })
    }
    return { kind: 'enter', messages }
  })
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  ensureConfigFile()

  const toolName = config.toolName || 'vision_read_image'
  try {
    ctx.tools.register(readImageTool(toolName))
  } catch (error) {
    console.error(`[dsh-vision] ${toolName} registration skipped: ${error}`)
  }

  if (config.visionProvider !== false) {
    registerVisionProvider(ctx, config)
  }

  if (config.autoRead === true) {
    registerAutoRead(ctx)
  }
}
