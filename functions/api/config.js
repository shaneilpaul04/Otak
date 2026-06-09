// Serves Supabase public config to the frontend.
// The anon key is safe to expose — Supabase RLS policies enforce access control.
// Env vars set in Cloudflare Pages dashboard → Settings → Environment variables:
//   SUPABASE_URL, SUPABASE_ANON_KEY

export async function onRequest(context) {
  const { env } = context

  return new Response(
    JSON.stringify({
      supabaseUrl:    env.SUPABASE_URL,
      supabaseAnonKey: env.SUPABASE_ANON_KEY,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
    }
  )
}
