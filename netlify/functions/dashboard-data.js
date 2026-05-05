import { neon } from '@neondatabase/serverless';

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-dashboard-key',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET')     return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const key = event.headers['x-dashboard-key'];
  if (!key || key !== process.env.DASHBOARD_KEY) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  if (!process.env.NEON_DATABASE_URL) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'DB not configured' }) };
  }

  try {
    const sql = neon(process.env.NEON_DATABASE_URL);

    const [
      totales,
      porFuente,
      topEntidades,
      topDominios,
      topTelefonos,
      topEmails,
      porDepartamento,
      porEdad,
      porCanal,
      porDia,
      campanas,
      feedback,
      pageViews,
      campanasActivas,
      dominiosCalientes,
      telefonosCalientes,
      emailsCalientes,
    ] = await Promise.all([

      // 1. Totales generales
      sql`
        SELECT
          COUNT(*)                                                        AS total,
          COUNT(*) FILTER (WHERE fin_flujo >= NOW() - INTERVAL '7 days') AS ultimos_7,
          COUNT(*) FILTER (WHERE fin_flujo >= NOW() - INTERVAL '30 days')AS ultimos_30
        FROM reportes
      `,

      // 2. Por fuente
      sql`
        SELECT COALESCE(fuente,'whatsapp') AS fuente, COUNT(*) AS total
        FROM reportes
        GROUP BY fuente
        ORDER BY total DESC
      `,

      // 3. Top 10 entidades suplantadas (agrupadas sin distinguir mayúsculas)
      sql`
        SELECT INITCAP(MIN(institucion)) AS entidad, COUNT(*) AS total
        FROM reportes
        WHERE institucion IS NOT NULL AND institucion <> ''
        GROUP BY LOWER(institucion)
        ORDER BY total DESC
        LIMIT 10
      `,

      // 4. Top 10 dominios fraudulentos
      sql`
        SELECT dominio, total_reportes, score_riesgo, estado,
               COALESCE(entidad_suplantada,'—') AS entidad
        FROM dominios_fraudulentos
        ORDER BY total_reportes DESC
        LIMIT 10
      `,

      // 5. Top 10 teléfonos fraudulentos
      sql`
        SELECT telefono, total_reportes, canal,
               COALESCE(entidad_suplantada,'—') AS entidad
        FROM telefonos_fraudulentos
        ORDER BY total_reportes DESC
        LIMIT 10
      `,

      // 6. Top 10 emails fraudulentos
      sql`
        SELECT email, total_reportes,
               COALESCE(entidad_suplantada,'—') AS entidad
        FROM emails_fraudulentos
        ORDER BY total_reportes DESC
        LIMIT 10
      `,

      // 7. Por departamento
      sql`
        SELECT COALESCE(departamento,'No informado') AS departamento, COUNT(*) AS total
        FROM reportes
        GROUP BY departamento
        ORDER BY total DESC
        LIMIT 20
      `,

      // 8. Por rango de edad
      sql`
        SELECT COALESCE(edad,'No informado') AS edad, COUNT(*) AS total
        FROM reportes
        GROUP BY edad
        ORDER BY total DESC
      `,

      // 9. Por canal (sumar booleans)
      sql`
        SELECT
          SUM(canal_email::int)       AS email,
          SUM(canal_sms::int)         AS sms,
          SUM(canal_whatsapp::int)    AS whatsapp,
          SUM(canal_llamada::int)     AS llamada,
          SUM(canal_sitio_web::int)   AS sitio_web,
          SUM(canal_marketplace::int) AS marketplace,
          SUM(canal_publicidad::int)  AS publicidad
        FROM reportes
      `,

      // 10. Reportes por día (últimos 30 días)
      sql`
        SELECT DATE(fin_flujo) AS dia, COUNT(*) AS total
        FROM reportes
        WHERE fin_flujo >= NOW() - INTERVAL '30 days'
        GROUP BY dia
        ORDER BY dia ASC
      `,

      // 11. Campañas activas
      sql`
        SELECT id, nombre, entidad_suplantada, canal_principal,
               estado, total_reportes, inicio
        FROM campanas
        ORDER BY total_reportes DESC
        LIMIT 20
      `,

      // 12. Feedback reciente
      sql`
        SELECT id, comentario, created_at
        FROM feedback
        ORDER BY created_at DESC
        LIMIT 20
      `.catch(() => []),

      // 13. Visitas (page_views)
      sql`
        SELECT
          COUNT(*)                                                          AS total,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')  AS ultimos_7,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days') AS ultimos_30
        FROM page_views
      `.catch(() => [{ total: 0, ultimos_7: 0, ultimos_30: 0 }]),

      // 14. Campañas activas on-the-fly (3+ reportes misma institución + canal dominante, últimos 7 días)
      sql`
        SELECT
          INITCAP(MIN(institucion)) AS entidad,
          COUNT(*) AS cantidad_reportes,
          MIN(fin_flujo) AS primer_reporte,
          MAX(fin_flujo) AS ultimo_reporte,
          CASE
            WHEN SUM(canal_email::int) >= SUM(canal_sms::int) AND SUM(canal_email::int) >= SUM(canal_whatsapp::int) THEN 'email'
            WHEN SUM(canal_sms::int) >= SUM(canal_whatsapp::int) THEN 'sms'
            ELSE 'whatsapp'
          END AS canal
        FROM reportes
        WHERE fin_flujo >= NOW() - INTERVAL '7 days'
          AND institucion IS NOT NULL AND institucion <> ''
        GROUP BY LOWER(institucion)
        HAVING COUNT(*) >= 3
        ORDER BY cantidad_reportes DESC
        LIMIT 10
      `.catch(() => []),

      // 15. Dominios calientes (últimas 48hs)
      sql`
        SELECT dominio, total_reportes AS reportes
        FROM dominios_fraudulentos
        WHERE ultima_vez >= NOW() - INTERVAL '48 hours'
          AND total_reportes >= 2
        ORDER BY total_reportes DESC LIMIT 10
      `.catch(() => []),

      // 16. Teléfonos calientes (últimas 48hs)
      sql`
        SELECT telefono, total_reportes AS reportes
        FROM telefonos_fraudulentos
        WHERE ultima_vez >= NOW() - INTERVAL '48 hours'
          AND total_reportes >= 2
        ORDER BY total_reportes DESC LIMIT 10
      `.catch(() => []),

      // 17. Emails calientes (últimas 48hs)
      sql`
        SELECT email, total_reportes AS reportes
        FROM emails_fraudulentos
        WHERE ultima_vez >= NOW() - INTERVAL '48 hours'
          AND total_reportes >= 2
        ORDER BY total_reportes DESC LIMIT 10
      `.catch(() => []),
    ]);

    const t = totales[0];
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        generado_at: new Date().toISOString(),
        totales: {
          total:      Number(t.total),
          ultimos_7:  Number(t.ultimos_7),
          ultimos_30: Number(t.ultimos_30),
        },
        por_fuente:      porFuente.map(r => ({ fuente: r.fuente, total: Number(r.total) })),
        top_entidades:   topEntidades.map(r => ({ entidad: r.entidad, total: Number(r.total) })),
        top_dominios:    topDominios.map(r => ({
          dominio:   r.dominio,
          reportes:  Number(r.total_reportes),
          score:     Number(r.score_riesgo),
          estado:    r.estado,
          entidad:   r.entidad,
        })),
        top_telefonos:   topTelefonos.map(r => ({
          telefono: r.telefono,
          reportes: Number(r.total_reportes),
          canal:    r.canal || '—',
          entidad:  r.entidad,
        })),
        top_emails:      topEmails.map(r => ({
          email:    r.email,
          reportes: Number(r.total_reportes),
          entidad:  r.entidad,
        })),
        por_departamento: porDepartamento.map(r => ({ dep: r.departamento, total: Number(r.total) })),
        por_edad:         porEdad.map(r => ({ edad: r.edad, total: Number(r.total) })),
        por_canal: {
          email:       Number(porCanal[0]?.email       || 0),
          sms:         Number(porCanal[0]?.sms         || 0),
          whatsapp:    Number(porCanal[0]?.whatsapp    || 0),
          llamada:     Number(porCanal[0]?.llamada     || 0),
          sitio_web:   Number(porCanal[0]?.sitio_web   || 0),
          marketplace: Number(porCanal[0]?.marketplace || 0),
          publicidad:  Number(porCanal[0]?.publicidad  || 0),
        },
        por_dia:   porDia.map(r => ({ dia: r.dia, total: Number(r.total) })),
        feedback:  (feedback || []).map(r => ({
          id:          r.id,
          comentario:  r.comentario,
          created_at:  r.created_at,
        })),
        page_views: {
          total:      Number(pageViews[0]?.total      || 0),
          ultimos_7:  Number(pageViews[0]?.ultimos_7  || 0),
          ultimos_30: Number(pageViews[0]?.ultimos_30 || 0),
        },
        campanas:  campanas.map(r => ({
          id:       r.id,
          nombre:   r.nombre || '—',
          entidad:  r.entidad_suplantada || '—',
          canal:    r.canal_principal || '—',
          estado:   r.estado,
          reportes: Number(r.total_reportes),
          inicio:   r.inicio,
        })),
        campanas_activas: (campanasActivas || []).map(r => ({
          entidad:           r.entidad,
          canal:             r.canal,
          cantidad_reportes: Number(r.cantidad_reportes),
          primer_reporte:    r.primer_reporte,
          ultimo_reporte:    r.ultimo_reporte,
        })),
        dominios_calientes:  (dominiosCalientes  || []).map(r => ({ dominio:  r.dominio,  reportes: Number(r.reportes) })),
        telefonos_calientes: (telefonosCalientes || []).map(r => ({ telefono: r.telefono, reportes: Number(r.reportes) })),
        emails_calientes:    (emailsCalientes    || []).map(r => ({ email:    r.email,    reportes: Number(r.reportes) })),
      }),
    };

  } catch (error) {
    console.error('[dashboard-data] error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
