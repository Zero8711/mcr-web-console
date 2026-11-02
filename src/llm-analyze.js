/**
 * 선택 칸의 최근 화면을 LLM 에 보내 짧게 설명한다.
 * 최소 시험용. 장비로는 명령을 보내지 않는다.
 * OpenAI 호환 chat/completions 만 사용한다.
 */
(function (global) {
  const ENDPOINT_KEY = 'llm-endpoint';
  const MODEL_KEY = 'llm-model';
  const API_KEY_KEY = 'llm-api-key';
  const AFTER_CMD_KEY = 'llm-after-command';
  const MAX_LOG_LINES = 80;

  const SYSTEM_PROMPT =
    '당신은 AP/라우터 시리얼 콘솔을 보는 시험 조수입니다. ' +
    '한국어로 짧게 답하세요. 목록은 3~6개면 됩니다.\n' +
    '반드시 아래를 포함하세요.\n' +
    '1) 마지막 명령이 무엇인지\n' +
    '2) 이 명령으로 무엇을 확인하는지\n' +
    '3) 출력에서 눈에 띄는 정보(인터페이스, IP, 링크, 에러 카운터 등)\n' +
    '화면에 없는 값은 추측이라고 밝히세요. ' +
    '장비에 보낼 명령은 제안만 하고, 실행했다고 말하지 마세요.';

  function loadSettings() {
    return {
      endpoint: readStore(ENDPOINT_KEY) || '',
      model: readStore(MODEL_KEY) || '',
      apiKey: readStore(API_KEY_KEY) || '',
      afterCommand: readStore(AFTER_CMD_KEY) !== '0',
    };
  }

  function saveSettings(settings) {
    writeStore(ENDPOINT_KEY, settings.endpoint || '');
    writeStore(MODEL_KEY, settings.model || '');
    writeStore(API_KEY_KEY, settings.apiKey || '');
    writeStore(AFTER_CMD_KEY, settings.afterCommand ? '1' : '0');
  }

  function hasEndpoint(settings) {
    return Boolean(String(settings?.endpoint || '').trim() && String(settings?.model || '').trim());
  }

  function configError(settings) {
    if (!String(settings?.endpoint || '').trim()) {
      return 'API 주소를 넣으세요. OpenAI 호환 chat/completions 주소입니다.';
    }
    if (!String(settings?.model || '').trim()) {
      return '모델 이름을 넣으세요.';
    }
    if (isHttpsPage() && isHttpLocal(settings.endpoint)) {
      return 'https 페이지에서는 http://127.0.0.1 Ollama 를 부를 수 없습니다. mcr_console.bat 으로 열거나 https API 를 쓰세요.';
    }
    return '';
  }

  async function analyzePane(pane, settings) {
    const readyError = configError(settings);
    if (readyError) {
      throw new Error(readyError);
    }
    if (!pane) {
      throw new Error('분석할 콘솔이 없습니다.');
    }

    const logText = pane.getRecentLog(MAX_LOG_LINES);
    if (!logText.trim()) {
      throw new Error('화면에 분석할 로그가 없습니다. 장비를 연결하고 ifconfig 를 먼저 치세요.');
    }

    const userText =
      '장비: ' + (pane.title || '콘솔') + '\n' +
      '마지막 명령: ' + (pane.lastCommand || '(화면에서 추정)') + '\n\n' +
      '화면:\n' +
      logText;

    const answer = await requestChat(settings, userText);
    if (!answer) {
      throw new Error('모델이 빈 답을 돌려줬습니다.');
    }
    return answer;
  }

  async function requestChat(settings, userText) {
    const endpoint = String(settings.endpoint || '').trim();
    const headers = {
      'Content-Type': 'application/json',
    };
    if (settings.apiKey) {
      headers.Authorization = 'Bearer ' + settings.apiKey;
    }

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          model: String(settings.model || '').trim(),
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userText },
          ],
        }),
      });
    } catch (err) {
      throw new Error(toNetworkError(err));
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(toHttpError(response.status, raw));
    }

    return readAssistantText(raw);
  }

  function readAssistantText(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error('모델 응답이 JSON 이 아닙니다.');
    }

    const text = data?.choices?.[0]?.message?.content;
    return String(text || '').trim();
  }

  function toNetworkError(err) {
    const message = err?.message || String(err);
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      return '모델 서버에 닿지 못했습니다. 주소, CORS, 그리고 https 페이지에서 http 를 쓰는지 확인하세요.';
    }
    return message;
  }

  function toHttpError(status, raw) {
    const hint = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    if (status === 401 || status === 403) {
      return 'API 키가 거부되었습니다. 키를 다시 넣으세요.';
    }
    if (hint) {
      return '모델 오류 ' + status + ': ' + hint;
    }
    return '모델 오류 ' + status;
  }

  function isHttpsPage() {
    return location.protocol === 'https:';
  }

  function isHttpLocal(endpoint) {
    try {
      const url = new URL(endpoint, location.href);
      return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    } catch {
      return false;
    }
  }

  function readStore(key) {
    try {
      return localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  }

  function writeStore(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // private mode
    }
  }

  global.LlmAnalyze = {
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    hasEndpoint: hasEndpoint,
    configError: configError,
    analyzePane: analyzePane,
    maxLogLines: MAX_LOG_LINES,
  };
})(window);
