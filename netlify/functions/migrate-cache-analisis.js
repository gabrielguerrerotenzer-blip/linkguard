// Migración one-shot: materializa la tabla `cache_analisis` en Neon que el
// endpoint analyze.js asume desde siempre y que nunca fue creada.
// El comentario al inicio de analyze.js documentaba el schema esperado pero
// asumía un paso manual en Neon dashboard que nunca se hizo, así que el cache
// venía fallando silenciosamente (try/catch en line 125 de analyze.js
// loguea "relation cache_analisis does not exist" pero no rompe el flow).
//
// Schema creado:
//   CREATE TABLE cache_analisis (
//     id             SERIAL       PRIMARY KEY,
//     hash_contenido VARCHAR(64)  UNIQUE NOT NULL,
//     resultado      JSONB        NOT NULL,
//     modelo         VARCHAR(50),
//     created_at     TIMESTAMP    DEFAULT NOW()
//   );
//   CREATE INDEX idx_cache_analisis_created_at ON cache_analisis (created_at DESC);
//
// NO se llama automáticamente. Solo accesible vía:
//   curl -X POST https://fraude.uy/.netlify/functions/migrate-cache-analisis \
//     -H "x-dashboard-key: <DASHBOARD_KEY>"
//
// Idempotente: ambos DDL usan IF NOT EXISTS. Aplicar dos veces no rompe nada
// y la respuesta reporta si la tabla/índice ya existían (table_created=false
// indica que la corrida fue noop sobre estructura existente).

import { neon } from '@neondatabase/serverless';

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

    // Chequear estado previo de la tabla (para reportar si fue creada esta corrida).
    const tableBefore = await sql`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'cache_analisis'
      ) AS exists
    `;
    const tableExistedBefore = tableBefore[0].exists;

    // Crear tabla. IF NOT EXISTS hace este DDL idempotente.
    await sql`
      CREATE TABLE IF NOT EXISTS cache_analisis (
        id             SERIAL       PRIMARY KEY,
        hash_contenido VARCHAR(64)  UNIQUE NOT NULL,
        resultado      JSONB        NOT NULL,
        modelo         VARCHAR(50),
        created_at     TIMESTAMP    DEFAULT NOW()
      )
    `;

    // Chequear estado previo del índice (después de crear la tabla, sino
    // pg_indexes no podría reportarlo en la primera corrida).
    const indexBefore = await sql`
      SELECT EXISTS (
        SELECT FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_cache_analisis_created_at'
      ) AS exists
    `;
    const indexExistedBefore = indexBefore[0].exists;

    // Crear índice. IF NOT EXISTS hace este DDL idempotente.
    await sql`
      CREATE INDEX IF NOT EXISTS idx_cache_analisis_created_at
        ON cache_analisis (created_at DESC)
    `;

    // Contar filas existentes (útil para confirmar que la tabla ya tenía data
    // si esto se corriera por error en un ambiente con tabla preexistente).
    const countRes = await sql`SELECT COUNT(*)::int AS c FROM cache_analisis`;
    const rowCount = countRes[0].c;

    console.log(
      `[migrate-cache-analisis] table_created=${!tableExistedBefore} ` +
      `index_created=${!indexExistedBefore} row_count=${rowCount}`
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        table_created: !tableExistedBefore,
        index_created: !indexExistedBefore,
        row_count: rowCount,
      }),
    };
  } catch (error) {
    console.error('[migrate-cache-analisis] error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
