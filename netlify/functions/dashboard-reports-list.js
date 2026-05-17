// Endpoint protegido del dashboard: lista reportes individuales paginados
// con filtros básicos (período / entidad / fuente / canal).
//
// Auth: header x-dashboard-key
// CORS: mismo allowlist que dashboard-data
// Rate limit: 60 req/h por IP (compartido en memoria con este Lambda)

import { neon } from '@neondatabase/serverless';

const ALLOWED_ORIGINS = ['https://fraude.uy', 'https://www.fraude.uy', 'http://localhost:8888'];

const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hora
const RATE_LIMIT = 60;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false;
  }
  if (entry.count >= RATE_LIMIT) return true;
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

// Canales válidos para filtro (mapean a columnas boolean en reportes)
const CANALES_VALIDOS = new Set([
  'email', 'sms', 'whatsapp', 'llamada', 'sitio_web', 'marketplace', 'publicidad',
]);

export const handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin;
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '';

  const headers = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, x-dashboard-key',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET')     return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const ip =
    event.headers['x-nf-client-connection-ip'] ||
    event.headers['x-forwarded-for']?.split(',')[0].trim() ||
    'unknown';

  if (rateLimitMap.size > 50) cleanupRateMap();
  if (checkRateLimit(ip)) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ error: 'Rate limit exceeded. Máximo 60 requests por hora.' }),
    };
  }

  const key = event.headers['x-dashboard-key'];
  if (!key || key !== process.env.DASHBOARD_KEY) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  if (!process.env.NEON_DATABASE_URL) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DB not configured' }) };
  }

  try {
    const qs = event.queryStringParameters || {};

    // Paginación
    const limit  = Math.min(Math.max(parseInt(qs.limit  || '50', 10), 1), 200);
    const offset = Math.max(parseInt(qs.offset || '0',  10), 0);

    // Filtros
    const dias    = ['1', '7', '30'].includes(qs.dias) ? parseInt(qs.dias, 10) : null;
    const entidad = (qs.entidad || '').trim().slice(0, 100) || null;
    const fuente  = ['web', 'whatsapp'].includes(qs.fuente) ? qs.fuente : null;
    const canal   = CANALES_VALIDOS.has(qs.canal) ? qs.canal : null;

    const sql = neon(process.env.NEON_DATABASE_URL);

    // Estrategia: parametrizamos cada filtro como NULL-OR-MATCH. Esto evita
    // SQL dinámico y es compatible con neon tagged templates.
    // El filtro de canal se materializa con 7 ramas porque la columna depende
    // del valor de qs.canal (igual patrón que dashboard-data en detectarCampanaWeb).

    const [totalRows, rows] = await Promise.all([
      sql`
        SELECT COUNT(*) AS total
        FROM reportes
        WHERE (${dias}::int IS NULL OR fin_flujo >= NOW() - (${dias}::int || ' days')::interval)
          AND (${entidad}::text IS NULL OR LOWER(institucion) = LOWER(${entidad}::text))
          AND (${fuente}::text  IS NULL OR fuente = ${fuente}::text)
          AND (${canal}::text   IS NULL OR (
                 (${canal}::text = 'email'       AND canal_email       = true) OR
                 (${canal}::text = 'sms'         AND canal_sms         = true) OR
                 (${canal}::text = 'whatsapp'    AND canal_whatsapp    = true) OR
                 (${canal}::text = 'llamada'     AND canal_llamada     = true) OR
                 (${canal}::text = 'sitio_web'   AND canal_sitio_web   = true) OR
                 (${canal}::text = 'marketplace' AND canal_marketplace = true) OR
                 (${canal}::text = 'publicidad'  AND canal_publicidad  = true)
               ))
      `,
      sql`
        SELECT
          id, numero_reporte, fin_flujo, fuente, institucion, motivo, edad,
          departamento, reportante_id,
          canal_email, canal_sms, canal_whatsapp, canal_llamada,
          canal_sitio_web, canal_marketplace, canal_publicidad,
          dato_tarjeta, dato_cvv2, dato_vencimiento, dato_usuario_clave,
          dato_email, dato_token, dato_bancario_general, dato_ninguno, dato_otro
        FROM reportes
        WHERE (${dias}::int IS NULL OR fin_flujo >= NOW() - (${dias}::int || ' days')::interval)
          AND (${entidad}::text IS NULL OR LOWER(institucion) = LOWER(${entidad}::text))
          AND (${fuente}::text  IS NULL OR fuente = ${fuente}::text)
          AND (${canal}::text   IS NULL OR (
                 (${canal}::text = 'email'       AND canal_email       = true) OR
                 (${canal}::text = 'sms'         AND canal_sms         = true) OR
                 (${canal}::text = 'whatsapp'    AND canal_whatsapp    = true) OR
                 (${canal}::text = 'llamada'     AND canal_llamada     = true) OR
                 (${canal}::text = 'sitio_web'   AND canal_sitio_web   = true) OR
                 (${canal}::text = 'marketplace' AND canal_marketplace = true) OR
                 (${canal}::text = 'publicidad'  AND canal_publicidad  = true)
               ))
        ORDER BY fin_flujo DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
    ]);

    const total = Number(totalRows[0]?.total || 0);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        total,
        limit,
        offset,
        filtros: { dias, entidad, fuente, canal },
        rows: rows.map(r => ({
          id:             r.id,
          numero_reporte: r.numero_reporte,
          fecha:          r.fin_flujo,
          fuente:         r.fuente || '—',
          institucion:    r.institucion || '—',
          motivo:         r.motivo      || '—',
          edad:           r.edad        || '—',
          departamento:   r.departamento|| '—',
          reportante_id:  r.reportante_id,
          canales: {
            email:       !!r.canal_email,
            sms:         !!r.canal_sms,
            whatsapp:    !!r.canal_whatsapp,
            llamada:     !!r.canal_llamada,
            sitio_web:   !!r.canal_sitio_web,
            marketplace: !!r.canal_marketplace,
            publicidad:  !!r.canal_publicidad,
          },
          datos: {
            tarjeta:           !!r.dato_tarjeta,
            cvv2:              !!r.dato_cvv2,
            vencimiento:       !!r.dato_vencimiento,
            usuario_clave:     !!r.dato_usuario_clave,
            email:             !!r.dato_email,
            token:             !!r.dato_token,
            bancario_general:  !!r.dato_bancario_general,
            ninguno:           !!r.dato_ninguno,
            otro:              !!r.dato_otro,
          },
        })),
      }),
    };
  } catch (error) {
    console.error('[dashboard-reports-list] error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
