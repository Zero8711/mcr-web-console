/**
 * GitHub Pages 에서 NVIDIA API 를 쓰기 위한 HTTPS 중계.
 * Cloudflare Workers 대시보드에 이 파일 내용을 붙여 넣고 Deploy 한다.
 *
 * 브라우저(github.io) → 이 Worker → integrate.api.nvidia.com
 * 키는 브라우저가 보낸 Authorization 을 그대로 넘긴다. 여기에 키를 넣지 않는다.
 */
const ALLOW_ORIGINS = [
  'https://zero8711.github.io',
];

function isAllowedHost(host) {
  const name = String(host || '').toLowerCase();
  return name === 'integrate.api.nvidia.com' ||
    name === 'api.nvidia.com' ||
    name.slice(-15) === '.api.nvidia.com';
}

function isAllowedOrigin(origin) {
  return ALLOW_ORIGINS.indexOf(origin) >= 0;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Llm-Target',
    'Access-Control-Max-Age': '86400',
  };
}

function json(origin, status, obj) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
    }, corsHeaders(origin)),
  });
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      if (!isAllowedOrigin(origin)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!isAllowedOrigin(origin)) {
      return json(origin, 403, { error: '허용되지 않은 페이지입니다.' });
    }

    if (request.method !== 'POST') {
      return json(origin, 405, { error: 'POST 만 됩니다.' });
    }

    const target = String(request.headers.get('X-Llm-Target') || '').trim();
    let uri;
    try {
      uri = new URL(target);
    } catch {
      return json(origin, 400, { error: '모델 주소가 올바르지 않습니다.' });
    }

    if (uri.protocol !== 'https:' || !isAllowedHost(uri.hostname)) {
      return json(origin, 400, { error: '이 모델 주소는 중계할 수 없습니다.' });
    }

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const auth = request.headers.get('Authorization');
    if (auth) {
      headers.Authorization = auth;
    }

    let upstream;
    try {
      upstream = await fetch(uri.toString(), {
        method: 'POST',
        headers: headers,
        body: await request.text(),
      });
    } catch {
      return json(origin, 502, { error: '모델 서버에 닿지 못했습니다.' });
    }

    const body = await upstream.text();
    const type = upstream.headers.get('Content-Type') || 'application/json; charset=utf-8';
    return new Response(body, {
      status: upstream.status,
      headers: Object.assign({ 'Content-Type': type }, corsHeaders(origin)),
    });
  },
};
