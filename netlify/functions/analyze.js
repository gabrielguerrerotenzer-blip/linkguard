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

  try {
    const parsed = JSON.parse(event.body);
    const hasImage = parsed.messages?.[0]?.content?.some?.(c => c.type === 'image');
    const textContent = parsed.messages?.[0]?.content?.find?.(c => c.type === 'text');

    console.log('[analyze] model:', parsed.model);
    console.log('[analyze] has_image:', hasImage);
    console.log('[analyze] system_prompt (last 600 chars):', parsed.system?.slice(-600));
    console.log('[analyze] user_text_prompt:', textContent?.text);

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
