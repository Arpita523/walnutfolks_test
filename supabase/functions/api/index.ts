// @ts-ignore: Native URL import resolved by Deno Edge Runtime
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

declare const EdgeRuntime: {
  waitUntil: (promise: Promise<unknown>) => void
}

// Ambient type declaration for IDE TypeScript language servers
declare const Deno: {
  env: {
    get: (key: string) => string | undefined
  }
  serve: (handler: (req: Request) => Promise<Response> | Response) => void
}

// CORS Headers for cross-origin client requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
}

// Global Supabase configuration
const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? 'https://oehnlycyvucimchrtivh.supabase.co'
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  ?? Deno.env.get('SUPABASE_ANON_KEY')
  ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
  ?? 'sb_publishable_n7AOgwawMDJR7Uv77Hiuzg_2b_4d7YN'

// Default server-side Supabase client instance
const defaultSupabase = createClient(supabaseUrl, supabaseKey)

// Helper to resolve Supabase client (supports optional client-supplied keys without breaking on invalid secrets)
function getSupabaseClient(req?: Request) {
  const reqKey = req?.headers.get('apikey') || req?.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (reqKey && reqKey !== 'SUPABASE_PUBLISHABLE_KEY' && !reqKey.startsWith('sb_secret_')) {
    return createClient(supabaseUrl, reqKey)
  }
  return defaultSupabase
}

// Helper for consistent JSON responses
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  })

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Authenticated Supabase client instance for this request
  const supabase = getSupabaseClient(req)

  const url = new URL(req.url)
  const pathname = url.pathname

  // 1. HEALTH CHECK: GET / or GET /api or GET /health
  if (req.method === 'GET' && (pathname.endsWith('/api') || pathname.endsWith('/api/') || pathname === '/' || pathname.endsWith('/health'))) {
    return json({
      status: 'HEALTHY',
      current_time: new Date().toISOString()
    })
  }

  // 2. WEBHOOK INGESTION: POST /v1/webhooks/transactions
  if (req.method === 'POST' && pathname.includes('/webhooks/transactions')) {
    try {
      const body = await req.json().catch(() => null)
      if (!body || typeof body !== 'object') {
        return json({ error: 'Invalid JSON payload' }, 400)
      }

      const { transaction_id, source_account, destination_account, amount, currency } = body

      // Payload validation
      if (!transaction_id || !source_account || !destination_account || amount === undefined || isNaN(Number(amount)) || !currency) {
        return json({
          error: 'Invalid payload. Required fields: transaction_id, source_account, destination_account, amount, currency'
        }, 400)
      }

      const createdAt = new Date().toISOString()

      // Single-query insert with status 'PROCESSING'
      const { error: insertError } = await supabase
        .from('transactions')
        .insert({
          transaction_id,
          source_account,
          destination_account,
          amount: Number(amount),
          currency,
          status: 'PROCESSING',
          created_at: createdAt,
          processed_at: null
        })

      // Idempotency: PostgreSQL error code 23505 = unique constraint violation
      if (insertError) {
        if (insertError.code === '23505') {
          return json({
            status: 'ACCEPTED',
            message: 'Transaction already received'
          }, 202)
        }
        console.error('[Insert Error]', insertError.message)
        return json({ error: 'Database insert failed' }, 500)
      }

      // Background Processing (Simulate 30-second delay using EdgeRuntime.waitUntil)
      // Asynchronously updates status from PROCESSING to PROCESSED
      const backgroundProcessing = (async () => {
        try {
          console.log(`[Worker] Starting 30s background processing for: ${transaction_id}`)
          await new Promise((resolve) => setTimeout(resolve, 30000))

          const processedAt = new Date().toISOString()
          const { error: updateError } = await supabase
            .from('transactions')
            .update({
              status: 'PROCESSED',
              processed_at: processedAt
            })
            .eq('transaction_id', transaction_id)
            .eq('status', 'PROCESSING')

          if (updateError) {
            console.error(`[Worker Update Error] ${transaction_id}:`, updateError.message)
          } else {
            console.log(`[Worker] ${transaction_id} marked as PROCESSED at ${processedAt}`)
          }
        } catch (workerErr) {
          console.error(`[Worker Exception] ${transaction_id}:`, workerErr)
        }
      })()

      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
        EdgeRuntime.waitUntil(backgroundProcessing)
      }

      // Immediate 202 acknowledgment
      return json({
        status: 'ACCEPTED',
        message: 'Transaction webhook received'
      }, 202)
    } catch (err) {
      console.error('[Webhook Handling Error]', err)
      return json({ error: 'Internal server error processing webhook' }, 500)
    }
  }

  // 3. LIST ALL TRANSACTIONS: GET /v1/transactions
  const isListTransactions = req.method === 'GET' && (pathname.endsWith('/transactions') || pathname.endsWith('/transactions/'))
  if (isListTransactions) {
    const urlParams = url.searchParams
    const limit = Math.min(Math.max(parseInt(urlParams.get('limit') || '25', 10), 1), 100)
    const page = Math.max(parseInt(urlParams.get('page') || '1', 10), 1)
    const offset = (page - 1) * limit
    const statusFilter = urlParams.get('status')
    const search = urlParams.get('search')

    let query = supabase
      .from('transactions')
      .select('transaction_id, source_account, destination_account, amount, currency, status, created_at, processed_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (statusFilter && (statusFilter === 'PROCESSING' || statusFilter === 'PROCESSED')) {
      query = query.eq('status', statusFilter)
    }

    if (search) {
      query = query.or(`transaction_id.ilike.%${search}%,source_account.ilike.%${search}%,destination_account.ilike.%${search}%`)
    }

    const { data: txList, count, error } = await query

    if (error) {
      console.error('[List Error]', error.message)
      return json({ error: 'Database list query failed', details: error.message }, 500)
    }

    return json({
      total: count ?? (txList?.length || 0),
      page,
      limit,
      total_pages: Math.ceil((count ?? 0) / limit) || 1,
      transactions: txList || []
    }, 200)
  }

  // 4. QUERY TRANSACTION STATUS: GET /v1/transactions/:transaction_id
  if (req.method === 'GET' && pathname.includes('/transactions/')) {
    const segments = pathname.split('/').filter(Boolean)
    const transactionId = segments[segments.length - 1]

    if (!transactionId || transactionId === 'transactions') {
      return json({ error: 'transaction_id is required' }, 400)
    }

    const { data: tx, error } = await supabase
      .from('transactions')
      .select('transaction_id, source_account, destination_account, amount, currency, status, created_at, processed_at')
      .eq('transaction_id', transactionId)
      .maybeSingle()

    if (error) {
      console.error('[Query Error]', error.message)
      return json({ error: 'Database query failed' }, 500)
    }

    if (!tx) {
      return json({ error: 'Transaction not found' }, 404)
    }

    return json({
      transaction_id: tx.transaction_id,
      source_account: tx.source_account,
      destination_account: tx.destination_account,
      amount: Number(tx.amount),
      currency: tx.currency,
      status: tx.status,
      created_at: tx.created_at,
      processed_at: tx.processed_at
    }, 200)
  }

  // Fallback for unmatched routes
  return json({ error: 'Endpoint not found', path: pathname }, 404)
})
