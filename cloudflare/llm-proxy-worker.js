/**
 * 사내 HTTPS 중계 샘플. 공개 workers.dev 로 배포하지 않는다.
 *
 * GitHub Pages → Worker 로의 fetch 가 막히는 환경이 있어,
 * ?bridge=1 페이지를 iframe 으로 열고 같은 주소끼리 POST 한다.
 *
 * 키는 페이지에 넣지 않는다. 중계 서버 비밀값 NVIDIA_API_KEY 로 둔다.
 */
const PARENT_ORIGIN = 'https://zero8711.github.io';
const PAGES_ROOT = 'https://zero8711.github.io/mcr-web-console';

const BRIDGE_HTML =
  '<!DOCTYPE html>\n' +
  '<html lang="ko"><head><meta charset="utf-8"><title>mcr llm bridge</title></head>\n' +
  '<body><script>\n' +
  '(function () {\n' +
  '  function parentOk(origin) {\n' +
  '    if (origin === ' + JSON.stringify(PARENT_ORIGIN) + ') {\n' +
  '      return true;\n' +
  '    }\n' +
  '    try {\n' +
  '      var url = new URL(origin);\n' +
  '      var local = url.hostname === "127.0.0.1" || url.hostname === "localhost";\n' +
  '      return url.protocol === "http:" && local && url.port === "8765";\n' +
  '    } catch (err) {\n' +
  '      return false;\n' +
  '    }\n' +
  '  }\n' +
  '  window.addEventListener("message", function (event) {\n' +
  '    if (!parentOk(event.origin)) {\n' +
  '      return;\n' +
  '    }\n' +
  '    var msg = event.data || {};\n' +
  '    if (msg.type !== "llm-proxy") {\n' +
  '      return;\n' +
  '    }\n' +
  '    var replyTo = event.origin;\n' +
  '    fetch("/", {\n' +
  '      method: "POST",\n' +
  '      headers: { "Content-Type": "text/plain" },\n' +
  '      body: typeof msg.body === "string" ? msg.body : JSON.stringify(msg.body || {})\n' +
  '    }).then(function (res) {\n' +
  '      return res.text().then(function (text) {\n' +
  '        event.source.postMessage({ type: "llm-proxy-result", id: msg.id, status: res.status, text: text }, replyTo);\n' +
  '      });\n' +
  '    }).catch(function (err) {\n' +
  '      event.source.postMessage({ type: "llm-proxy-result", id: msg.id, error: String(err && err.message ? err.message : err) }, replyTo);\n' +
  '    });\n' +
  '  });\n' +
  '  if (window.parent) {\n' +
  '    window.parent.postMessage({ type: "llm-proxy-ready" }, "*");\n' +
  '  }\n' +
  '})();\n' +
  '</script></body></html>\n';

function isAllowedHost(host) {
  const name = String(host || '').toLowerCase();
  return name === 'integrate.api.nvidia.com' ||
    name === 'api.nvidia.com' ||
    name.slice(-15) === '.api.nvidia.com';
}

function isAllowedOrigin(origin, request) {
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
    if (url.protocol === 'http:' && local && url.port === '8765') {
      return true;
    }
    if (request) {
      const selfHost = new URL(request.url).hostname.toLowerCase();
      if (url.protocol === 'https:' && url.hostname.toLowerCase() === selfHost) {
        return true;
      }
    }
    return false;
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

function wantsBridgePage(request) {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get('bridge') === '1') {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function proxyGithubPages(request) {
  const url = new URL(request.url);
  let path = url.pathname || '/';
  if (path === '/') {
    path = '/index.html';
  }
  if (path.indexOf('..') >= 0) {
    return new Response('Not found', { status: 404 });
  }

  let upstream;
  try {
    upstream = await fetch(PAGES_ROOT + path + url.search, {
      method: 'GET',
      redirect: 'follow',
    });
  } catch {
    return new Response('GitHub Pages 에 닿지 못했습니다.', { status: 502 });
  }

  const headers = new Headers();
  const type = upstream.headers.get('Content-Type');
  if (type) {
    headers.set('Content-Type', type);
  }
  headers.set('Cache-Control', 'no-store');
  return new Response(upstream.body, {
    status: upstream.status,
    headers: headers,
  });
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

    if (request.method === 'GET' && wantsBridgePage(request)) {
      return new Response(BRIDGE_HTML, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Cross-Origin-Resource-Policy': 'cross-origin',
          'Content-Security-Policy':
            "frame-ancestors 'self' https://zero8711.github.io http://127.0.0.1:8765 http://localhost:8765",
        },
      });
    }

    if (request.method === 'GET') {
      return proxyGithubPages(request);
    }

    if (!isAllowedOrigin(origin, request)) {
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
