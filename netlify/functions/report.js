import { neon } from '@neondatabase/serverless';

function generarNumeroReporte(contador) {
  const hoy = new Date();
  const dia  = String(hoy.getDate()).padStart(2, '0');
  const mes  = String(hoy.getMonth() + 1).padStart(2, '0');
  const anio = String(hoy.getFullYear());
  const fechaNormal   = dia + mes + anio;
  const fechaInvertida = fechaNormal.split('').reverse().join('');
  const sec = String(contador).padStart(4, '0');
  return `FY${sec}${fechaInvertida}`;
}

function extraerDominio(url) {
  if (!url) return null;
  try {
    const u = url.includes('://') ? url : 'https://' + url;
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    try {
      const m = url.match(/(?:https?:\/\/)?(?:www\.)?([^\/\s?#]+)/i);
      return m ? m[1].toLowerCase() : null;
    } catch {
      return null;
    }
  }
}

async function procesarIndicadoresWeb(sql, body, reporteId, institucion) {
  try {
    const entidad = institucion || null;

    // --- Dominio ---
    const urlFuente = body.link_fraudulento || body.link_sitio_web || null;
    const dominio = extraerDominio(urlFuente);

    if (dominio) {
      try {
        await sql`
          INSERT INTO indicadores_fraude (reporte_id, tipo, valor)
          VALUES (${reporteId}, 'dominio', ${dominio})
        `;
      } catch (e) {
        console.error('[procesarIndicadoresWeb] indicadores_fraude dominio:', e.message);
      }

      try {
        await sql`
          INSERT INTO dominios_fraudulentos (dominio, entidad_suplantada, total_reportes, primera_vez, ultima_vez)
          VALUES (${dominio}, ${entidad}, 1, NOW(), NOW())
          ON CONFLICT (dominio) DO UPDATE
            SET total_reportes     = dominios_fraudulentos.total_reportes + 1,
                ultima_vez         = NOW(),
                entidad_suplantada = COALESCE(${entidad}, dominios_fraudulentos.entidad_suplantada)
        `;
      } catch (e) {
        console.error('[procesarIndicadoresWeb] dominios_fraudulentos upsert:', e.message);
      }
    }

    // --- Teléfono ---
    const telefono = body.telefono ? String(body.telefono).replace(/[^\d+]/g, '').slice(0, 20) || null : null;
    if (telefono) {
      try {
        await sql`
          INSERT INTO indicadores_fraude (reporte_id, tipo, valor)
          VALUES (${reporteId}, 'telefono', ${telefono})
        `;
      } catch (e) {
        console.error('[procesarIndicadoresWeb] indicadores_fraude telefono:', e.message);
      }

      try {
        await sql`
          INSERT INTO telefonos_fraudulentos (telefono, entidad_suplantada, total_reportes, primera_vez, ultima_vez)
          VALUES (${telefono}, ${entidad}, 1, NOW(), NOW())
          ON CONFLICT (telefono) DO UPDATE
            SET total_reportes     = telefonos_fraudulentos.total_reportes + 1,
                ultima_vez         = NOW(),
                entidad_suplantada = COALESCE(${entidad}, telefonos_fraudulentos.entidad_suplantada)
        `;
      } catch (e) {
        console.error('[procesarIndicadoresWeb] telefonos_fraudulentos upsert:', e.message);
      }
    }

    // --- Email ---
    const email = body.email_estafador ? String(body.email_estafador).trim().toLowerCase() : null;
    if (email) {
      const partes = email.split('@');
      const dominioEmail = partes.length === 2 ? partes[1] : null;

      try {
        await sql`
          INSERT INTO indicadores_fraude (reporte_id, tipo, valor)
          VALUES (${reporteId}, 'email', ${email})
        `;
      } catch (e) {
        console.error('[procesarIndicadoresWeb] indicadores_fraude email:', e.message);
      }

      try {
        await sql`
          INSERT INTO emails_fraudulentos (email, dominio_email, entidad_suplantada, total_reportes, primera_vez, ultima_vez)
          VALUES (${email}, ${dominioEmail}, ${entidad}, 1, NOW(), NOW())
          ON CONFLICT (email) DO UPDATE
            SET total_reportes     = emails_fraudulentos.total_reportes + 1,
                ultima_vez         = NOW(),
                entidad_suplantada = COALESCE(${entidad}, emails_fraudulentos.entidad_suplantada)
        `;
      } catch (e) {
        console.error('[procesarIndicadoresWeb] emails_fraudulentos upsert:', e.message);
      }
    }

    // --- Detección de campaña ---
    await detectarCampanaWeb(sql, reporteId, entidad, body.canales || []);

  } catch (err) {
    console.error('[procesarIndicadoresWeb] error general:', err.message);
  }
}

// Prioridad de canales (claves en minúscula, tal como las envía el frontend web)
const CANAL_PRIORITY_WEB = [
  { labels: ['sms'],         col: 'canal_sms',         nombre: 'SMS' },
  { labels: ['llamada'],     col: 'canal_llamada',      nombre: 'Llamada' },
  { labels: ['email'],       col: 'canal_email',        nombre: 'Email' },
  { labels: ['whatsapp'],    col: 'canal_whatsapp',     nombre: 'WhatsApp' },
  { labels: ['sitio_web'],   col: 'canal_sitio_web',    nombre: 'Sitio web' },
  { labels: ['marketplace'], col: 'canal_marketplace',  nombre: 'Marketplace' },
  { labels: ['publicidad'],  col: 'canal_publicidad',   nombre: 'Publicidad' },
];

const MESES_ES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

async function detectarCampanaWeb(sql, reporteId, entidad, canalesList) {
  try {
    if (!entidad) return;

    // 1. Canal principal según prioridad
    const canal = CANAL_PRIORITY_WEB.find(c => canalesList.some(cl => c.labels.includes(cl)));
    if (!canal) return;

    // 2. Contar reportes de los últimos 7 días con misma entidad y canal.
    //    La expresión parametrizada ($2 = 'canal_sms' AND canal_sms = true) evita
    //    SQL dinámico y es compatible con neon tagged templates.
    const countRows = await sql`
      SELECT COUNT(*) AS cnt
      FROM reportes
      WHERE institucion = ${entidad}
        AND fin_flujo >= NOW() - INTERVAL '7 days'
        AND (
          (${canal.col} = 'canal_sms'         AND canal_sms = true) OR
          (${canal.col} = 'canal_llamada'     AND canal_llamada = true) OR
          (${canal.col} = 'canal_email'       AND canal_email = true) OR
          (${canal.col} = 'canal_whatsapp'    AND canal_whatsapp = true) OR
          (${canal.col} = 'canal_sitio_web'   AND canal_sitio_web = true) OR
          (${canal.col} = 'canal_marketplace' AND canal_marketplace = true) OR
          (${canal.col} = 'canal_publicidad'  AND canal_publicidad = true)
        )
    `;
    const count = parseInt(countRows[0]?.cnt || '0', 10);
    if (count < 3) return;

    // 3. ¿Ya existe campaña activa para esta combinación?
    const campRows = await sql`
      SELECT id FROM campanas
      WHERE entidad_suplantada = ${entidad}
        AND canal_principal = ${canal.nombre}
        AND estado = 'activa'
      LIMIT 1
    `;

    let campanaId;
    if (campRows.length === 0) {
      // Crear campaña nueva
      const now = new Date();
      const nombre = `${entidad} ${canal.nombre} ${MESES_ES[now.getMonth()]}${now.getFullYear()}`;
      const newCamp = await sql`
        INSERT INTO campanas (nombre, entidad_suplantada, canal_principal, estado, total_reportes, inicio)
        VALUES (${nombre}, ${entidad}, ${canal.nombre}, 'activa', ${count}, NOW())
        RETURNING id
      `;
      campanaId = newCamp[0].id;
      console.log(`[detectarCampanaWeb] Nueva campaña: "${nombre}" id=${campanaId} reportes=${count}`);
    } else {
      // Actualizar campaña existente
      campanaId = campRows[0].id;
      await sql`
        UPDATE campanas SET total_reportes = ${count}, fin = NOW() WHERE id = ${campanaId}
      `;
      console.log(`[detectarCampanaWeb] Campaña ${campanaId} actualizada reportes=${count}`);
    }

    // 4. Vincular este reporte a la campaña
    try {
      await sql`
        INSERT INTO campana_reportes (campana_id, reporte_id)
        VALUES (${campanaId}, ${reporteId})
        ON CONFLICT DO NOTHING
      `;
    } catch (e) {
      console.error('[detectarCampanaWeb] campana_reportes insert:', e.message);
    }

  } catch (err) {
    console.error('[detectarCampanaWeb] error:', err.message);
  }
}

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
    const body    = JSON.parse(event.body || '{}');
    const canales = body.canales || [];

    const sql = neon(process.env.NEON_DATABASE_URL);

    // Incremento atómico del contador
    const cntRows = await sql`UPDATE contador SET valor = valor + 1 WHERE id = 1 RETURNING valor`;
    const contador = cntRows[0].valor;
    const numeroReporte = generarNumeroReporte(contador);

    const insertResult = await sql`
      INSERT INTO reportes (
        numero_reporte, celular_hash, inicio_flujo, fin_flujo,
        canal_email, canal_sms, canal_marketplace, canal_whatsapp,
        canal_llamada, canal_sitio_web, canal_publicidad,
        link_fraudulento, link_sitio_web,
        institucion, motivo, edad,
        dato_tarjeta, dato_cvv2, dato_vencimiento, dato_usuario_clave,
        dato_email, dato_token, dato_bancario_general, dato_ninguno, dato_otro,
        tiene_audio, fuente
      ) VALUES (
        ${numeroReporte}, NULL, NOW(), NOW(),
        ${canales.includes('email')},
        ${canales.includes('sms')},
        ${canales.includes('marketplace')},
        ${canales.includes('whatsapp')},
        ${canales.includes('llamada')},
        ${canales.includes('sitio_web')},
        ${canales.includes('publicidad')},
        ${body.link_fraudulento || null},
        ${body.link_sitio_web   || null},
        ${body.institucion      || null},
        ${body.motivo           || null},
        ${body.edad             || null},
        false, false, false, false, false, false, false, false, false,
        false, 'web'
      ) RETURNING id
    `;

    const reporteId = insertResult[0].id;
    await procesarIndicadoresWeb(sql, body, reporteId, body.institucion || null);

    const ip = event.headers['x-nf-client-connection-ip'] ||
               event.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
    console.log(`[report] ${numeroReporte} institucion="${body.institucion}" edad="${body.edad}" ip=${ip}`);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, numero_reporte: numeroReporte }) };

  } catch (error) {
    console.error('[report] error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
