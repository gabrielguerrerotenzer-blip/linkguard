import { neon } from '@neondatabase/serverless';
import { createHash } from 'crypto';

// ── Rate limit: 100 req/hora por api_key ────────────────────────────────────
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hora
const RATE_LIMIT = 100;

function checkRateLimit(key) {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return false; // no excedido
  }
  if (entry.count >= RATE_LIMIT) return true; // excedido
  entry.count++;
  return false;
}

function cleanupRateMap() {
  const now = Date.now();
  for (const [k, e] of rateLimitMap) {
    if (now - e.windowStart >= RATE_WINDOW_MS) rateLimitMap.delete(k);
  }
}

// ── Tipos válidos y su tabla ─────────────────────────────────────────────────
const TIPOS = {
  dominio:  'dominios_fraudulentos',
  telefono: 'telefonos_fraudulentos',
  email:    'emails_fraudulentos',
};

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET')     return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // ── 1. Parámetros ─────────────────────────────────────────────────────────
  const { type, value } = event.queryStringParameters || {};

  if (!type || !value) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Params required: type, value' }) };
  }
  if (!TIPOS[type]) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `type must be one of: ${Object.keys(TIPOS).join(', ')}` }) };
  }

  // ── 2. Autenticación ──────────────────────────────────────────────────────
  const apiKey = event.headers['x-api-key'];
  if (!apiKey) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Missing x-api-key header' }) };
  }

  if (!process.env.NEON_DATABASE_URL) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DB not configured' }) };
  }

  const sql = neon(process.env.NEON_DATABASE_URL);

  // Verificar api_key en DB (solo la cargamos una vez; el módulo se calienta en Lambda)
  let clientRow;
  try {
    const rows = await sql`
      SELECT id, nombre FROM api_clients
      WHERE api_key = ${apiKey} AND activo = true
      LIMIT 1
    `;
    clientRow = rows[0];
  } catch (e) {
    console.error('[api-lookup] auth query error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DB error' }) };
  }

  if (!clientRow) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Invalid or inactive API key' }) };
  }

  // ── 3. Rate limiting ──────────────────────────────────────────────────────
  if (rateLimitMap.size > 200) cleanupRateMap();
  if (checkRateLimit(apiKey)) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ error: 'Rate limit exceeded. Max 100 requests per hour.' }),
    };
  }

  // ── 4. Lookup ─────────────────────────────────────────────────────────────
  const normalizedValue = value.trim().toLowerCase();
  let row;
  let resultado = 'not_found';

  try {
    if (type === 'dominio') {
      const rows = await sql`
        SELECT dominio, entidad_suplantada, estado, total_reportes,
               score_riesgo, primera_vez, ultima_vez
        FROM dominios_fraudulentos
        WHERE dominio = ${normalizedValue}
        LIMIT 1
      `;
      row = rows[0] || null;

    } else if (type === 'telefono') {
      const rows = await sql`
        SELECT telefono, entidad_suplantada, canal, total_reportes,
               primera_vez, ultima_vez
        FROM telefonos_fraudulentos
        WHERE telefono = ${normalizedValue}
        LIMIT 1
      `;
      row = rows[0] || null;

    } else if (type === 'email') {
      const rows = await sql`
        SELECT email, entidad_suplantada, dominio_email, total_reportes,
               primera_vez, ultima_vez
        FROM emails_fraudulentos
        WHERE email = ${normalizedValue}
        LIMIT 1
      `;
      row = rows[0] || null;
    }
  } catch (e) {
    console.error('[api-lookup] lookup query error:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DB error' }) };
  }

  // ── 5. Campaña activa para la entidad encontrada ──────────────────────────
  let campanaActiva = false;
  if (row?.entidad_suplantada) {
    try {
      const campRows = await sql`
        SELECT id FROM campanas
        WHERE entidad_suplantada = ${row.entidad_suplantada}
          AND estado = 'activa'
        LIMIT 1
      `;
      campanaActiva = campRows.length > 0;
    } catch (e) {
      console.error('[api-lookup] campana query error:', e.message);
    }
  }

  // ── 6. Registrar en consultas_api ─────────────────────────────────────────
  resultado = row ? 'found' : 'not_found';
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex').slice(0, 64);
  try {
    await sql`
      INSERT INTO consultas_api (cliente, api_key_hash, tipo_consulta, valor_consultado, resultado)
      VALUES (${clientRow.nombre}, ${apiKeyHash}, ${type}, ${normalizedValue}, ${resultado})
    `;
  } catch (e) {
    console.error('[api-lookup] audit insert error:', e.message);
  }

  // ── 7. Respuesta ──────────────────────────────────────────────────────────
  if (!row) {
    return { statusCode: 200, headers, body: JSON.stringify({ found: false }) };
  }

  const response = {
    found:             true,
    total_reportes:    Number(row.total_reportes),
    entidad_suplantada: row.entidad_suplantada || null,
    primera_vez:       row.primera_vez,
    ultima_vez:        row.ultima_vez,
    campana_activa:    campanaActiva,
  };

  // Campos específicos por tipo
  if (type === 'dominio') {
    response.risk_score = Number(row.score_riesgo);
    response.estado     = row.estado;
  } else if (type === 'telefono') {
    response.canal = row.canal || null;
  } else if (type === 'email') {
    response.dominio_email = row.dominio_email || null;
  }

  console.log(`[api-lookup] ${clientRow.nombre} → ${type}:${normalizedValue} = ${resultado}`);

  return { statusCode: 200, headers, body: JSON.stringify(response) };
};
