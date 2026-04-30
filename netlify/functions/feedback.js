import { neon } from '@neondatabase/serverless';

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-linkguard',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  if (event.headers['x-linkguard'] !== 'fraude-uy-2026') {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  if (!process.env.NEON_DATABASE_URL) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DB not configured' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const comentario = typeof body.comentario === 'string' ? body.comentario.trim() : '';

    if (!comentario) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'comentario is required' }) };
    }
    if (comentario.length > 2000) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'comentario too long (max 2000 chars)' }) };
    }

    const sql = neon(process.env.NEON_DATABASE_URL);

    await sql`
      INSERT INTO feedback (comentario)
      VALUES (${comentario})
    `;

    const ip = event.headers['x-nf-client-connection-ip'] ||
               event.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
    console.log(`[feedback] nuevo comentario ip=${ip} len=${comentario.length}`);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

  } catch (error) {
    console.error('[feedback] error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
