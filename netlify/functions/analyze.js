// Rate limiting: 10 requests por hora por IP
// El Map persiste mientras el contenedor Lambda esté caliente.
import { createHash } from 'crypto';
import { neon } from '@neondatabase/serverless';

// IMPORTANTE: Ejecutar esta SQL una vez en Neon antes de usar el cache:
// CREATE TABLE IF NOT EXISTS cache_analisis (
//   id SERIAL PRIMARY KEY,
//   hash_contenido VARCHAR(64) UNIQUE NOT NULL,
//   resultado JSONB NOT NULL,
//   modelo VARCHAR(30),
//   created_at TIMESTAMP DEFAULT NOW()
// );

const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hora
const RATE_LIMIT = 10;

let _requestCount = 0;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false; // no limitado
  }

  if (entry.count >= RATE_LIMIT) {
    return true; // limitado
  }

  entry.count++;
  return false;
}

function cleanupRateMap() {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart >= RATE_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-linkguard',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (event.headers['x-linkguard'] !== 'fraude-uy-2026') {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  // Bot User-Agent check
  const ua = event.headers['user-agent'] || '';
  const botPatterns = /^$|curl|python-requests|scrapy|httpx|wget|axios|node-fetch|go-http|java\/|ruby|perl|php\/|libwww|bot|spider|crawler/i;
  if (botPatterns.test(ua)) {
    console.log(`[analyze] blocked bot ua="${ua}"`);
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  // Obtener IP del cliente (Netlify expone x-nf-client-connection-ip)
  const ip =
    event.headers['x-nf-client-connection-ip'] ||
    event.headers['x-forwarded-for']?.split(',')[0].trim() ||
    'unknown';

  // Limpiar entradas viejas cada 50 requests para no acumular memoria
  if (rateLimitMap.size > 50) cleanupRateMap();

  if (checkRateLimit(ip)) {
    console.log(`[analyze] rate_limited ip=${ip}`);
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ error: 'Too many requests. Máximo 10 análisis por hora.' }),
    };
  }

  try {
    const parsed = JSON.parse(event.body);
    const hasImage = parsed.messages?.[0]?.content?.some?.(c => c.type === 'image');
    const textContent = parsed.messages?.[0]?.content?.find?.(c => c.type === 'text');

    console.log('[analyze] model:', parsed.model);
    console.log('[analyze] has_image:', hasImage);
    console.log('[analyze] system_prompt (last 600 chars):', parsed.system?.slice(-600));
    console.log('[analyze] user_text_prompt:', textContent?.text);
    console.log(`[analyze] ip=${ip} count=${rateLimitMap.get(ip)?.count}`);

    // ====== CACHE: solo para requests sin imagen ======
    //
    // El hash del cache se saltea con `prompt_version` (string tipo "vN") que envía
    // el cliente en el body. Esto invalida el cache automáticamente cuando se cambia
    // el system prompt o la fuente única de contactos (ENTIDADES_OFICIALES en
    // index.html): bumpear PROMPT_VERSION en el cliente → el hash cambia → cache miss
    // forzado → respuestas viejas con números incorrectos quedan huérfanas.
    //
    // Convención: "vN" donde N es un entero. No usar fechas ni hashes.
    //
    // FASE 1 (este PR): backwards-compatible. Si el cliente no envía prompt_version,
    // se usa 'v1' como default. Las respuestas cacheadas pre-refactor tenían el hash
    // computado sin salt, así que de todas formas quedan huérfanas (no van a matchear
    // con el nuevo formato "v1|texto").
    //
    // TODO (FASE 2, objetivo 2026-05-18 / ~48h después del deploy de FASE 1):
    // endurecer el contrato: rechazar 400 si falta prompt_version. Borrar este TODO
    // y el fallback `|| 'v1'` cuando se haga FASE 2.
    let contentHash = null;
    if (!hasImage && textContent?.text && process.env.NEON_DATABASE_URL) {
      const sql = neon(process.env.NEON_DATABASE_URL);
      const rawPromptVersion = parsed.prompt_version || 'v1';
      if (!/^v\d+$/.test(rawPromptVersion)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'prompt_version inválido. Esperado: /^v\\d+$/' }),
        };
      }
      contentHash = createHash('sha256')
        .update(`${rawPromptVersion}|${textContent.text}`)
        .digest('hex');

      try {
        const cached = await sql`
          SELECT resultado FROM cache_analisis
          WHERE hash_contenido = ${contentHash}
            AND created_at > NOW() - INTERVAL '24 hours'
          LIMIT 1
        `;
        if (cached.length > 0) {
          console.log(`[analyze] cache_hit ip=${ip} hash=${contentHash}`);
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify(cached[0].resultado),
          };
        }
      } catch (cacheReadErr) {
        console.error('[analyze] cache read error:', cacheReadErr.message);
      }
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: event.body,
    });

    const data = await response.json();
    const rawText = data.content?.[0]?.text;
    console.log('[analyze] raw_response:', rawText);

    // ====== CACHE WRITE + CLEANUP ======
    if (response.ok && contentHash && process.env.NEON_DATABASE_URL) {
      _requestCount++;

      // Fire-and-forget cache write
      const sql = neon(process.env.NEON_DATABASE_URL);
      sql`
        INSERT INTO cache_analisis (hash_contenido, resultado, modelo)
        VALUES (${contentHash}, ${JSON.stringify(data)}::jsonb, ${parsed.model || null})
        ON CONFLICT (hash_contenido) DO UPDATE
          SET resultado = EXCLUDED.resultado,
              created_at = NOW(),
              modelo = EXCLUDED.modelo
      `.catch(e => console.error('[analyze] cache write error:', e.message));

      // Every 100 requests, purge entries older than 7 days
      if (_requestCount % 100 === 0) {
        sql`DELETE FROM cache_analisis WHERE created_at < NOW() - INTERVAL '7 days'`
          .catch(e => console.error('[analyze] cache cleanup error:', e.message));
      }
    }

    return {
      statusCode: response.status,
      headers,
      body: JSON.stringify(data),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
