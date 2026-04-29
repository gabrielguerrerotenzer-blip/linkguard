import { neon } from '@neondatabase/serverless';

// Caché en memoria: 5 minutos
const cache = { data: null, ts: 0 };
const CACHE_TTL = 5 * 60 * 1000;

function extractHostname(url) {
  if (!url) return null;
  try {
    const u = url.includes('://') ? url : 'https://' + url;
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

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

    const rows = await sql`
      SELECT link_fraudulento, link_sitio_web, telefono_normalizado, email_estafador
      FROM reportes
      WHERE link_fraudulento    IS NOT NULL
         OR link_sitio_web      IS NOT NULL
         OR telefono_normalizado IS NOT NULL
         OR email_estafador     IS NOT NULL
      LIMIT 500
    `;

    const domainsSet = new Set();
    const phonesSet  = new Set();
    const emailsSet  = new Set();

    for (const row of rows) {
      const d1 = extractHostname(row.link_fraudulento);
      const d2 = extractHostname(row.link_sitio_web);
      if (d1) domainsSet.add(d1);
      if (d2) domainsSet.add(d2);
      if (row.telefono_normalizado) phonesSet.add(row.telefono_normalizado.trim());
      if (row.email_estafador)      emailsSet.add(row.email_estafador.trim().toLowerCase());
    }

    cache.data = {
      fraudulentDomains: [...domainsSet],
      scamPhones:        [...phonesSet],
      scamEmails:        [...emailsSet],
    };
    cache.ts = Date.now();

    console.log(
      `[threats] cargados: ${domainsSet.size} dominios, ` +
      `${phonesSet.size} teléfonos, ${emailsSet.size} emails`
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
