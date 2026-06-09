// Otak — Cloudflare Pages Function proxy for OpenRouter API
// Env vars set in Cloudflare Pages dashboard → Settings → Environment variables:
//   OPENROUTER_API_KEY

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// ── RATE LIMITER ──────────────────────────────────────────────────────────────
// In-memory — resets on cold start. Fine for beta.
const rateStore = new Map()

function getClientKey(request) {
  // cf-connecting-ip is Cloudflare's reliable real-IP header
  const ip = request.headers.get('cf-connecting-ip')
            || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            || 'unknown'
  const ua = (request.headers.get('user-agent') || '').slice(0, 40)
  return (ip + '|' + ua).slice(0, 48)
}

function checkRateLimit(key) {
  const now = Date.now()
  const DAY   = 24 * 60 * 60 * 1000
  const MONTH = 30 * DAY

  let r = rateStore.get(key) || { requests: [], essaysToday: [], essaysMonth: [], wordsMonth: 0 }

  r.requests    = r.requests.filter(t => now - t < 60_000)
  r.essaysToday = r.essaysToday.filter(t => now - t < DAY)
  r.essaysMonth = r.essaysMonth.filter(t => now - t < MONTH)

  if (r.requests.length >= 20)
    return { allowed: false, reason: 'rate_limit_minute', message: 'Too many requests. Wait a minute lah.' }
  if (r.essaysToday.length >= 2)
    return { allowed: false, reason: 'daily_cap', message: "You've hit today's free essay limit. Come back tomorrow or upgrade." }
  if (r.essaysMonth.length >= 3)
    return { allowed: false, reason: 'monthly_cap', message: "You've used all 3 free essays this month. Upgrade for unlimited." }
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

// ── MODEL + TOKEN CONFIG ──────────────────────────────────────────────────────
const MODEL_FOR_STAGE = {
  context:  'anthropic/claude-haiku-4-5',
  rubric:   'anthropic/claude-sonnet-4-6',
  voice:    'anthropic/claude-sonnet-4-6',
  coach:    'anthropic/claude-sonnet-4-6',
  evaluate: 'anthropic/claude-sonnet-4-6',
}

const MAX_TOKENS_FOR_STAGE = {
  context:  600,
  rubric:   1200,
  voice:    800,
  coach:    3000,
  evaluate: 1000,
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
export async function onRequest(context) {
  const { request, env } = context

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }

  const apiKey = env.OPENROUTER_API_KEY
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'API key not configured — set OPENROUTER_API_KEY in Cloudflare Pages environment variables' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }

  let prompt, stage, wordCount
  try {
    const body = await request.json()
    prompt    = body.prompt
    stage     = body.stage
    wordCount = body.wordCount || 0
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }

  if (!prompt || typeof prompt !== 'string') {
    return new Response(
      JSON.stringify({ error: 'Missing required field: prompt' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }

  // Rate limit only at the start of each essay
  if (stage === 'context') {
    const clientKey = getClientKey(request)
    const check = checkRateLimit(clientKey)
    if (!check.allowed) {
      return new Response(
        JSON.stringify({ error: { message: check.message, code: check.reason } }),
        { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      )
    }
    recordEssay(clientKey, wordCount)
  }

  const model = MODEL_FOR_STAGE[stage] || 'openrouter/auto'

  let orResponse
  try {
    orResponse = await fetch(OPENROUTER_URL, {
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
    return new Response(
      JSON.stringify({ error: `Failed to reach OpenRouter: ${err.message}` }),
      { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }

  const data = await orResponse.json()

  if (!orResponse.ok) {
    const status = orResponse.status
    return new Response(
      JSON.stringify({ error: data?.error?.message || `OpenRouter error ${status}` }),
      { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    )
  }

  return new Response(
    JSON.stringify(data),
    { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
  )
}
