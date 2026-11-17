/**
 * GitHub Pages 에서 NVIDIA API 를 쓰기 위한 HTTPS 중계.
 * Cloudflare Workers 대시보드에 이 파일 내용을 붙여 넣고 Deploy 한다.
 *
 * 키는 페이지에 넣지 않는다. Worker 설정 → Variables and Secrets 에서
 * 이름 NVIDIA_API_KEY, 종류 Secret 으로 NVIDIA 키를 넣는다.
 *
 * 브라우저가 키를 보내면 그 키를 쓰고, 안 보내면 이 비밀값을 쓴다.
 */
function isAllowedHost(host) {
  const name = String(host || '').toLowerCase();
  return name === 'integrate.api.nvidia.com' ||
    name === 'api.nvidia.com' ||
    name.slice(-15) === '.api.nvidia.com';
}

function isAllowedOrigin(origin) {
  const text = String(origin || '').trim();
  if (!text) {
    return false;
  }
  try {
    const url = new URL(text);
    if (url.protocol === 'https:' && url.hostname === 'zero8711.github.io') {
      return true;
    }
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    return url.protocol === 'http:' && local && url.port === '8765';
  } catch {
    return false;
  }
}

function corsHeaders(origin, request) {
  const requested = request && request.headers.get('Access-Control-Request-Headers');
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': requested || '*',
    'Access-Control-Max-Age': '86400',
  };
}

function json(origin, status, obj, request) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
    }, corsHeaders(origin, request)),
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

function readProxyBody(raw, headerTarget) {
  const fallback = {
    target: String(headerTarget || '').trim(),
    payload: raw,
  };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.target && parsed.payload) {
      return {
        target: String(parsed.target || '').trim(),
        payload: JSON.stringify(parsed.payload),
      };
    }
  } catch {
    // 본문이 JSON 포장이 아니면 헤더의 주소를 쓴다.
  }
  return fallback;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, request),
      });
    }

    if (!isAllowedOrigin(origin)) {
      return json(origin, 403, {
        error: '허용되지 않은 페이지입니다.',
        origin: origin || '(없음)',
      }, request);
    }

    if (request.method !== 'POST') {
      return json(origin, 405, { error: 'POST 만 됩니다.' }, request);
    }

    const parsedBody = readProxyBody(
      await request.text(),
      request.headers.get('X-Llm-Target')
    );
    let uri;
    try {
      uri = new URL(parsedBody.target);
    } catch {
      return json(origin, 400, { error: '모델 주소가 올바르지 않습니다.' }, request);
    }

    if (uri.protocol !== 'https:' || !isAllowedHost(uri.hostname)) {
      return json(origin, 400, { error: '이 모델 주소는 중계할 수 없습니다.' }, request);
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
      }, request);
    }
    headers.Authorization = auth;

    let upstream;
    try {
      upstream = await fetch(uri.toString(), {
        method: 'POST',
        headers: headers,
        body: parsedBody.payload,
      });
    } catch {
      return json(origin, 502, { error: '모델 서버에 닿지 못했습니다.' }, request);
    }

    const body = await upstream.text();
    const type = upstream.headers.get('Content-Type') || 'application/json; charset=utf-8';
    return new Response(body, {
      status: upstream.status,
      headers: Object.assign({ 'Content-Type': type }, corsHeaders(origin, request)),
    });
  },
};
