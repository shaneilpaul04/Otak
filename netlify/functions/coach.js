// Otak — serverless proxy for OpenRouter API
// Reads OPENROUTER_API_KEY from Netlify environment variables.
// Accepts POST { prompt, stage, wordCount } and forwards to OpenRouter.

import { createHash } from 'crypto'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

// ── RATE LIMITER ─────────────────────────────────────────────────────────────
// Simple in-memory store — resets on cold start, fine for beta.
// Replace with Netlify Blobs or Upstash Redis when you add signups.
const rateStore = new Map()

function getClientKey(event) {
  const ip = event.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || event.headers['client-ip']
            || 'unknown'
  const ua = (event.headers['user-agent'] || '').slice(0, 50)
  return createHash('sha256').update(ip + '|' + ua).digest('hex').slice(0, 16)
}

function checkRateLimit(key) {
  const now = Date.now()
  const DAY = 24 * 60 * 60 * 1000
  const MONTH = 30 * DAY

  let r = rateStore.get(key) || { requests: [], essaysToday: [], essaysMonth: [], wordsMonth: 0 }

  // Prune old timestamps
  r.requests     = r.requests.filter(t => now - t < 60_000)
  r.essaysToday  = r.essaysToday.filter(t => now - t < DAY)
  r.essaysMonth  = r.essaysMonth.filter(t => now - t < MONTH)

  if (r.requests.length >= 20)
    return { allowed: false, reason: 'rate_limit_minute', message: "Too many requests. Wait a minute lah." }
  if (r.essaysToday.length >= 2)
    return { allowed: false, reason: 'daily_cap', message: "You've hit today's free essay limit. Come back tomorrow or upgrade to Pro." }
  if (r.essaysMonth.length >= 3)
    return { allowed: false, reason: 'monthly_cap', message: "You've used all 3 free essays this month. Upgrade to Pro for unlimited." }
  if (r.wordsMonth >= 6000)
    return { allowed: false, reason: 'word_cap', message: "You've hit the 6,000 word free monthly limit. Upgrade for unlimited." }

  r.requests.push(now)
  rateStore.set(key, r)
  return { allowed: true, record: r }
}

function recordEssay(key, wordCount) {
  const r = rateStore.get(key)
  if (!r) return
  const now = Date.now()
  r.essaysToday.push(now)
  r.essaysMonth.push(now)
  r.wordsMonth += (wordCount || 0)
  rateStore.set(key, r)
}

const MODEL_FOR_STAGE = {
  context:  'anthropic/claude-haiku-4-5',
  rubric:   'anthropic/claude-haiku-4-5',
  voice:    'anthropic/claude-haiku-4-5',
  coach:    'anthropic/claude-sonnet-4-6',
  evaluate: 'anthropic/claude-sonnet-4-6',
}
const DEFAULT_MODEL = 'openrouter/auto'

// Cap output tokens per stage — none of these need more than 1500.
// Without this, OpenRouter reserves the model's full context window (64k)
// against your credit balance even if the actual output is tiny.
const MAX_TOKENS_FOR_STAGE = {
  context:  600,
  rubric:   1200,
  voice:    800,
  coach:    3000,
  evaluate: 1000,
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export const handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' }
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    }
  }

  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    console.error('[coach] OPENROUTER_API_KEY is not set in environment variables')
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'API key not configured — set OPENROUTER_API_KEY in Netlify environment variables' }),
    }
  }

  let prompt, stage, wordCount
  try {
    const body = JSON.parse(event.body || '{}')
    prompt = body.prompt
    stage = body.stage
    wordCount = body.wordCount || 0
  } catch {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    }
  }

  if (!prompt || typeof prompt !== 'string') {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing required field: prompt' }),
    }
  }

  const model = MODEL_FOR_STAGE[stage] || DEFAULT_MODEL

  // Rate limiting — only gate on stage='context' (the start of each essay)
  if (stage === 'context') {
    const clientKey = getClientKey(event)
    const check = checkRateLimit(clientKey)
    if (!check.allowed) {
      return {
        statusCode: 429,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { message: check.message, code: check.reason } }),
      }
    }
    recordEssay(clientKey, wordCount)
  }

  let response
  try {
    response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://otak.app',
        'X-Title': 'Otak Writing Coach',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: MAX_TOKENS_FOR_STAGE[stage] || 1000,
      }),
    })
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Failed to reach OpenRouter: ${err.message}` }),
    }
  }

  const data = await response.json()
  if (!response.ok) {
    return {
      statusCode: response.status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: data?.error?.message || `OpenRouter error ${response.status}` }),
    }
  }

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }
}
