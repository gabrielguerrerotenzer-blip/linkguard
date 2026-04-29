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

    await sql`
      INSERT INTO reportes (
        numero_reporte, celular_hash, inicio_flujo, fin_flujo,
        canal_email, canal_sms, canal_marketplace, canal_whatsapp,
        canal_llamada, canal_sitio_web, canal_publicidad,
        link_fraudulento, link_sitio_web,
        institucion, motivo, edad,
        dato_tarjeta, dato_cvv2, dato_vencimiento, dato_usuario_clave,
        dato_email, dato_token, dato_bancario_general, dato_ninguno, dato_otro,
        tiene_audio
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
        false
      )
    `;

    const ip = event.headers['x-nf-client-connection-ip'] ||
               event.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
    console.log(`[report] ${numeroReporte} institucion="${body.institucion}" edad="${body.edad}" ip=${ip}`);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, numero_reporte: numeroReporte }) };

  } catch (error) {
    console.error('[report] error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
