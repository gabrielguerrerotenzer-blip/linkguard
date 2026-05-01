import { neon } from '@neondatabase/serverless';

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-linkguard',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers, body: '' };

  const auth = event.headers['x-linkguard'];
  if (!auth || auth !== 'fraude-uy-2026') return { statusCode: 403, headers, body: '' };

  try {
    if (!process.env.NEON_DATABASE_URL) return { statusCode: 200, headers, body: '' };
    const sql = neon(process.env.NEON_DATABASE_URL);
    await sql`INSERT INTO page_views (page) VALUES ('/')`;
  } catch (_) {
    // silencioso — si la tabla no existe aún no rompe nada
  }

  return { statusCode: 200, headers, body: '' };
};
