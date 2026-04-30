import { neon } from '@neondatabase/serverless';

// Caché en memoria: 5 minutos
const cache = { data: null, ts: 0 };
const CACHE_TTL = 5 * 60 * 1000;

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-linkguard',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.headers['x-linkguard'] !== 'fraude-uy-2026') {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  // Devolver caché si sigue vigente
  if (cache.data && Date.now() - cache.ts < CACHE_TTL) {
    console.log('[threats] cache hit');
    return { statusCode: 200, headers, body: JSON.stringify(cache.data) };
  }

  if (!process.env.NEON_DATABASE_URL) {
    console.warn('[threats] NEON_DATABASE_URL no configurada');
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ fraudulentDomains: [], scamPhones: [], scamEmails: [] }),
    };
  }

  try {
    const sql = neon(process.env.NEON_DATABASE_URL);

    const domains = await sql`
      SELECT dominio, entidad_suplantada, score_riesgo, total_reportes
      FROM dominios_fraudulentos
      WHERE estado = 'activo'
      ORDER BY total_reportes DESC
      LIMIT 500
    `;

    const phones = await sql`
      SELECT telefono, entidad_suplantada, total_reportes
      FROM telefonos_fraudulentos
      ORDER BY total_reportes DESC
      LIMIT 500
    `;

    const emails = await sql`
      SELECT email, dominio_email, entidad_suplantada, total_reportes
      FROM emails_fraudulentos
      ORDER BY total_reportes DESC
      LIMIT 500
    `;

    cache.data = {
      fraudulentDomains: domains.map(r => ({
        dominio:  r.dominio,
        score:    r.score_riesgo,
        reportes: r.total_reportes,
        entidad:  r.entidad_suplantada,
      })),
      scamPhones: phones.map(r => r.telefono),
      scamEmails: emails.map(r => r.email),
    };
    cache.ts = Date.now();

    console.log(
      `[threats] cargados: ${domains.length} dominios, ` +
      `${phones.length} teléfonos, ${emails.length} emails`
    );
    return { statusCode: 200, headers, body: JSON.stringify(cache.data) };

  } catch (error) {
    console.error('[threats] error DB:', error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
