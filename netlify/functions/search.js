exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const q = event.queryStringParameters?.q;
  if (!q) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing query parameter q' }) };
  }

  const apiKey = process.env.GOOGLE_API_KEY || 'AIzaSyAHJt17vsq7qHnjwEQQLkEduLYslmpWQmk';
  const cx = process.env.GOOGLE_CSE_CX;

  if (!cx) {
    return { statusCode: 200, headers, body: JSON.stringify({ items: [], _note: 'CSE not configured' }) };
  }

  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(q)}&num=5`;
    const response = await fetch(url);
    const data = await response.json();
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message, items: [] }) };
  }
};
