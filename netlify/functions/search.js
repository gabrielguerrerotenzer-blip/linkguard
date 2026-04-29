exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  let q = event.queryStringParameters?.q;
  if (!q && event.body) {
    try {
      const body = JSON.parse(event.body);
      q = body.q || body.text;
    } catch (_) {}
  }
  if (!q) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing query parameter q' }) };
  }

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return { statusCode: 200, headers, body: JSON.stringify({ items: [], _note: 'Search not configured' }) };
  }

  try {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(q)}&num=5&api_key=${apiKey}`;
    const response = await fetch(url);
    const data = await response.json();

    // Normalizar formato al mismo que usaba Google CSE (items[].title, .link, .snippet)
    const items = (data.organic_results || []).slice(0, 5).map(r => ({
      title: r.title || '',
      link: r.link || '',
      snippet: r.snippet || '',
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ items }) };
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message, items: [] }) };
  }
};
