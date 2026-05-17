import { neon } from '@neondatabase/serverless';
import { anonymize } from './lib/anonymize.js';

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

    // Anonimizar PII (cédulas, teléfonos, emails, tarjetas, cuentas)
    // antes de persistir. Cumplimiento Ley 18.331.
    const comentarioAnon = anonymize(comentario);

    await sql`
      INSERT INTO feedback (comentario)
      VALUES (${comentarioAnon})
    `;

    const ip = event.headers['x-nf-client-connection-ip'] ||
               event.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
    console.log(`[feedback] nuevo comentario ip=${ip} len=${comentario.length} anon_diff=${comentario.length !== comentarioAnon.length}`);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

  } catch (error) {
    console.error('[feedback] error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
