/**
 * GitHub Pages 에서 NVIDIA API 를 쓰기 위한 HTTPS 중계.
 * Cloudflare Workers 대시보드에 이 파일 내용을 붙여 넣고 Deploy 한다.
 *
 * 키는 페이지에 넣지 않는다. Worker 설정 → Variables and Secrets 에서
 * 이름 NVIDIA_API_KEY, 종류 Secret 으로 NVIDIA 키를 넣는다.
 *
 * 브라우저가 키를 보내면 그 키를 쓰고, 안 보내면 이 비밀값을 쓴다.
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
  if (ALLOW_ORIGINS.indexOf(origin) >= 0) {
    return true;
  }
  try {
    const url = new URL(origin);
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    return url.protocol === 'http:' && local && url.port === '8765';
  } catch {
    return false;
  }
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

function bearer(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  if (/^Bearer\s+/i.test(text)) {
    return text;
  }
  return 'Bearer ' + text;
}

export default {
  async fetch(request, env) {
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
    const auth = bearer(request.headers.get('Authorization')) ||
      bearer(env && env.NVIDIA_API_KEY);
    if (!auth) {
      return json(origin, 401, {
        error: 'API 키가 없습니다. Worker 비밀값 NVIDIA_API_KEY 를 넣으세요.',
      });
    }
    headers.Authorization = auth;

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
