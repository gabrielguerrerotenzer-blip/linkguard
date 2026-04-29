// Rate limiting: 10 requests por hora por IP
// El Map persiste mientras el contenedor Lambda esté caliente.
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hora
const RATE_LIMIT = 10;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return false; // no limitado
  }

  if (entry.count >= RATE_LIMIT) {
    return true; // limitado
  }

  entry.count++;
  return false;
}

function cleanupRateMap() {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart >= RATE_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-linkguard',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (event.headers['x-linkguard'] !== 'fraude-uy-2026') {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  // Obtener IP del cliente (Netlify expone x-nf-client-connection-ip)
  const ip =
    event.headers['x-nf-client-connection-ip'] ||
    event.headers['x-forwarded-for']?.split(',')[0].trim() ||
    'unknown';

  // Limpiar entradas viejas cada 50 requests para no acumular memoria
  if (rateLimitMap.size > 50) cleanupRateMap();

  if (checkRateLimit(ip)) {
    console.log(`[analyze] rate_limited ip=${ip}`);
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ error: 'Too many requests. Máximo 10 análisis por hora.' }),
    };
  }

  try {
    const parsed = JSON.parse(event.body);
    const hasImage = parsed.messages?.[0]?.content?.some?.(c => c.type === 'image');
    const textContent = parsed.messages?.[0]?.content?.find?.(c => c.type === 'text');

    console.log('[analyze] model:', parsed.model);
    console.log('[analyze] has_image:', hasImage);
    console.log('[analyze] system_prompt (last 600 chars):', parsed.system?.slice(-600));
    console.log('[analyze] user_text_prompt:', textContent?.text);
    console.log(`[analyze] ip=${ip} count=${rateLimitMap.get(ip)?.count}`);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: event.body,
    });

    const data = await response.json();
    const rawText = data.content?.[0]?.text;
    console.log('[analyze] raw_response:', rawText);

    return {
      statusCode: response.status,
      headers,
      body: JSON.stringify(data),
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
