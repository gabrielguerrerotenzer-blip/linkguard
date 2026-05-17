// Migración retroactiva one-shot: anonimiza los feedback.comentario
// que existían antes de que el INSERT pasara por el anonimizador.
//
// NO se llama automáticamente. Solo accesible vía:
//   curl -X POST https://fraude.uy/.netlify/functions/migrate-anonymize-feedback \
//     -H "x-dashboard-key: <DASHBOARD_KEY>"
//
// Idempotente: aplicar dos veces no rompe nada (los textos ya anonimizados
// no contienen patrones que el regex vuelva a matchear).

import { neon } from '@neondatabase/serverless';
import { anonymize } from './lib/anonymize.js';

export const handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST required' }) };
  }

  if (event.headers['x-dashboard-key'] !== process.env.DASHBOARD_KEY) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  if (!process.env.NEON_DATABASE_URL) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DB not configured' }) };
  }

  try {
    const sql = neon(process.env.NEON_DATABASE_URL);
    const rows = await sql`SELECT id, comentario FROM feedback ORDER BY id ASC`;

    let cambiados = 0;
    let sinCambio = 0;
    const samples = [];

    for (const r of rows) {
      const original = r.comentario || '';
      const anon = anonymize(original);
      if (anon !== original) {
        await sql`UPDATE feedback SET comentario = ${anon} WHERE id = ${r.id}`;
        cambiados++;
        if (samples.length < 5) {
          samples.push({ id: r.id, before_len: original.length, after_len: anon.length });
        }
      } else {
        sinCambio++;
      }
    }

    console.log(`[migrate-anonymize-feedback] total=${rows.length} cambiados=${cambiados} sin_cambio=${sinCambio}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        total: rows.length,
        cambiados,
        sinCambio,
        samples,
      }),
    };
  } catch (error) {
    console.error('[migrate-anonymize-feedback] error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
