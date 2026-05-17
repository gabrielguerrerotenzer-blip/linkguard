import { neon } from '@neondatabase/serverless';

const SIGLAS_UY = new Set([
  'sucive','brou','oca','ute','ose','bbva','bcu','antel','anep',
  'asse','bps','dgi','mides','mtop','msp','bse','imm','ancap',
  'mef','miem','agesic',
]);

function normalizarEntidad(nombre) {
  if (!nombre || typeof nombre !== 'string') return nombre;
  const s = nombre.trim();
  if (!s) return null;
  // Sigla pura (sin espacios) → MAYÚSCULAS
  if (SIGLAS_UY.has(s.toLowerCase())) return s.toUpperCase();
  // Compuesto: capitalizar cada palabra, preservando siglas conocidas
  return s.replace(/\w+/g, w => {
    const wl = w.toLowerCase();
    return SIGLAS_UY.has(wl)
      ? wl.toUpperCase()
      : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  });
}

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
    const entidad = normalizarEntidad(institucion) || null;

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
        await recalcularScoreRiesgoWeb(sql, 'dominio', dominio);
      } catch (e) {
        console.error('[procesarIndicadoresWeb] dominios_fraudulentos upsert:', e.message);
      }
    }

    // Canal principal para enriquecer telefonos_fraudulentos.canal.
    // Usa el primero del array de canales reportados; el upsert ya hace COALESCE
    // para no sobrescribir un canal previo con NULL si este reporte no lo trae.
    const canalPrincipal = (Array.isArray(body.canales) && body.canales[0]) || null;

    // --- Teléfonos (arrays con backcompat singular) ---
    // body.telefonos: array nuevo. body.telefono: singular legacy.
    // Aplicamos slice(0, MAX_IOCS) por defensa server-side aunque el cliente ya lo hizo.
    const MAX_IOCS = 5;
    const telefonosRaw = (Array.isArray(body.telefonos) ? body.telefonos
                       : (body.telefono ? [body.telefono] : []))
                       .slice(0, MAX_IOCS);

    for (const telRaw of telefonosRaw) {
      // Cada teléfono en su propio try/catch: si el N-ésimo falla, los anteriores
      // ya están commiteados y el loop continúa con el siguiente.
      try {
        const tel = String(telRaw).replace(/[^\d+]/g, '').slice(0, 20) || null;
        if (!tel) continue;
        const digits = tel.replace(/\D/g, '');
        if (digits.length < 4 || digits.length > 15) continue;

        await sql`
          INSERT INTO indicadores_fraude (reporte_id, tipo, valor)
          VALUES (${reporteId}, 'telefono', ${tel})
        `;

        await sql`
          INSERT INTO telefonos_fraudulentos
            (telefono, canal, entidad_suplantada, total_reportes, primera_vez, ultima_vez)
          VALUES (${tel}, ${canalPrincipal}, ${entidad}, 1, NOW(), NOW())
          ON CONFLICT (telefono) DO UPDATE
            SET total_reportes     = telefonos_fraudulentos.total_reportes + 1,
                ultima_vez         = NOW(),
                entidad_suplantada = COALESCE(${entidad}, telefonos_fraudulentos.entidad_suplantada),
                canal              = COALESCE(${canalPrincipal}, telefonos_fraudulentos.canal)
        `;
        await recalcularScoreRiesgoWeb(sql, 'telefono', tel);
      } catch (e) {
        console.error('[procesarIndicadoresWeb] telefono fallido:', telRaw, e.message);
      }
    }

    // --- Emails (arrays con backcompat singular) ---
    const emailsRaw = (Array.isArray(body.emails) ? body.emails
                    : (body.email_estafador ? [body.email_estafador] : []))
                    .slice(0, MAX_IOCS);

    for (const emailRaw of emailsRaw) {
      try {
        const email = String(emailRaw).trim().toLowerCase();
        if (!email || !email.includes('@')) continue;
        const dominioEmail = email.split('@')[1] || null;

        await sql`
          INSERT INTO indicadores_fraude (reporte_id, tipo, valor)
          VALUES (${reporteId}, 'email', ${email})
        `;

        await sql`
          INSERT INTO emails_fraudulentos
            (email, dominio_email, entidad_suplantada, total_reportes, primera_vez, ultima_vez)
          VALUES (${email}, ${dominioEmail}, ${entidad}, 1, NOW(), NOW())
          ON CONFLICT (email) DO UPDATE
            SET total_reportes     = emails_fraudulentos.total_reportes + 1,
                ultima_vez         = NOW(),
                entidad_suplantada = COALESCE(${entidad}, emails_fraudulentos.entidad_suplantada)
        `;
        await recalcularScoreRiesgoWeb(sql, 'email', email);
      } catch (e) {
        console.error('[procesarIndicadoresWeb] email fallido:', emailRaw, e.message);
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

// ── REPUTACIÓN DE REPORTANTES ────────────────────────────────────────────────

async function obtenerOCrearReportanteWeb(sql, identificador) {
  if (!identificador) return { id: null, score: 0.5 };
  try {
    const ex = await sql`
      SELECT id, score_confiabilidad FROM reportantes
      WHERE identificador = ${identificador} LIMIT 1
    `;
    if (ex.length > 0) {
      await sql`
        UPDATE reportantes
        SET total_reportes = total_reportes + 1, ultima_vez = NOW()
        WHERE id = ${ex[0].id}
      `;
      return { id: ex[0].id, score: Number(ex[0].score_confiabilidad) };
    }
    const nr = await sql`
      INSERT INTO reportantes (identificador, tipo, score_confiabilidad, total_reportes)
      VALUES (${identificador}, 'fingerprint', 0.5, 1)
      RETURNING id, score_confiabilidad
    `;
    return { id: nr[0].id, score: Number(nr[0].score_confiabilidad) };
  } catch (e) {
    console.error('[obtenerOCrearReportanteWeb] error:', e.message);
    return { id: null, score: 0.5 };
  }
}

async function recalcularScoreRiesgoWeb(sql, tipo, valor) {
  try {
    const rows = await sql`
      SELECT COALESCE(AVG(rep.score_confiabilidad), 0.5) AS avg_score
      FROM indicadores_fraude i
      JOIN reportes    r   ON r.id   = i.reporte_id
      JOIN reportantes rep ON rep.id = r.reportante_id
      WHERE i.tipo = ${tipo} AND i.valor = ${valor}
    `;
    const score = Math.min(0.95, Math.max(0.1, Number(rows[0]?.avg_score || 0.5)));
    if (tipo === 'dominio') {
      await sql`UPDATE dominios_fraudulentos  SET score_riesgo = ${score} WHERE dominio  = ${valor}`;
    } else if (tipo === 'telefono') {
      await sql`UPDATE telefonos_fraudulentos SET score_riesgo = ${score} WHERE telefono = ${valor}`;
    } else if (tipo === 'email') {
      await sql`UPDATE emails_fraudulentos    SET score_riesgo = ${score} WHERE email    = ${valor}`;
    }
  } catch (e) {
    console.error('[recalcularScoreRiesgoWeb] error:', e.message);
  }
}

async function recalcularScoreReportanteWeb(sql, reportanteId) {
  if (!reportanteId) return;
  try {
    const confRows = await sql`
      SELECT COUNT(DISTINCT i.tipo || ':' || i.valor) AS confirmados
      FROM indicadores_fraude i
      JOIN reportes r ON r.id = i.reporte_id
      WHERE r.reportante_id = ${reportanteId}
        AND EXISTS (
          SELECT 1 FROM indicadores_fraude i2
          JOIN reportes r2 ON r2.id = i2.reporte_id
          WHERE i2.tipo = i.tipo AND i2.valor = i.valor
            AND r2.reportante_id != ${reportanteId}
        )
    `;
    const totalRows = await sql`
      SELECT total_reportes FROM reportantes WHERE id = ${reportanteId}
    `;
    const confirmados = parseInt(confRows[0]?.confirmados || '0', 10);
    const total       = parseInt(totalRows[0]?.total_reportes || '1', 10);
    const score = Math.min(0.95, Math.max(0.1, 0.3 + 0.7 * (confirmados / Math.max(total, 1))));
    await sql`
      UPDATE reportantes
      SET score_confiabilidad = ${score}, reportes_confirmados = ${confirmados}
      WHERE id = ${reportanteId}
    `;
    console.log(`[recalcularScoreReportanteWeb] id=${reportanteId} score=${score.toFixed(2)} confirmados=${confirmados}/${total}`);
  } catch (e) {
    console.error('[recalcularScoreReportanteWeb] error:', e.message);
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

    // Reputación: buscar o crear reportante por fingerprint
    const reportante = await obtenerOCrearReportanteWeb(sql, body.fingerprint || null);

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
        tiene_audio, fuente, reportante_id
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
        ${normalizarEntidad(body.institucion) || null},
        ${body.motivo           || null},
        ${body.edad             || null},
        false, false, false, false, false, false, false, false, false,
        false, ${body.fuente_override||'web'}, ${reportante.id}
      ) RETURNING id
    `;

    const reporteId = insertResult[0].id;
    await procesarIndicadoresWeb(sql, body, reporteId, body.institucion || null);
    await recalcularScoreReportanteWeb(sql, reportante.id);

    const ip = event.headers['x-nf-client-connection-ip'] ||
               event.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
    console.log(`[report] ${numeroReporte} institucion="${body.institucion}" edad="${body.edad}" ip=${ip}`);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, numero_reporte: numeroReporte }) };

  } catch (error) {
    console.error('[report] error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
