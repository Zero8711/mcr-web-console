/**
 * 선택 칸의 최근 화면을 짧게 설명한다.
 * 기본은 NVIDIA. 주소·모델은 코드 기본값, 키는 Cloudflare Worker 비밀값.
 * [이 칸 분석] 은 마지막 명령 출력만 본다.
 * [묻기] 는 이번 질문에만 답한다. 이전 LLM 답은 보내지 않는다.
 * 다른 명령을 묻는 질문에는 화면 로그를 붙이지 않는다.
 * Worker 가 없으면 분석을 시작하지 않는다.
 * 질문·분석 때는 장비에 pwd 와 명령 목록만 보내 확인한다.
 */
(function (global) {
  const ENDPOINT_KEY = 'llm-endpoint';
  const MODEL_KEY = 'llm-model';
  const API_KEY_KEY = 'llm-api-key';
  const PROXY_URL_KEY = 'llm-proxy-url';
  const PROBE_KEY = 'llm-probe-device';
  const DEFAULT_ENDPOINT = 'https://integrate.api.nvidia.com/v1/chat/completions';
  const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
  /**
   * Cloudflare Worker 주소. 끝에 / 없이.
   * 예: https://mcr-llm-proxy.계정.workers.dev
   * 여기 넣으면 시험자는 중계 칸을 채우지 않는다.
   */
  const LLM_PROXY_URL_DEFAULT = '';
  const MAX_LOG_LINES = 80;
  const MAX_SCAN_LINES = 400;
  const MAX_ASK_LOG_LINES = 1200;
  const MAX_ASK_SCAN_LINES = 5000;

  const SYSTEM_ANALYZE =
    '당신은 AP/라우터 시리얼 콘솔을 보고 시험자를 돕는 조수입니다.\n' +
    '한국어로 3~8문장 설명하세요.\n' +
    '이번 메시지에 붙은 명령과 출력만 설명하세요. 이전 대화는 없습니다.\n' +
    '화면에 있는 이름과 숫자만 쓰세요. 없는 값은 추측하지 마세요.\n' +
    '화면 출력을 그대로 다시 붙이지 마세요. 번호 목록을 비워 두지 마세요.\n' +
    '다른 명령을 제안하지 마세요.';

  const SYSTEM_ASK =
    '당신은 AP/라우터 시리얼 콘솔 시험자를 돕는 조수입니다.\n' +
    '한국어로 짧게 답하세요.\n' +
    '이번 사용자 질문에만 답하세요. 이전 질문과 답은 없습니다.\n' +
    '질문이 다른 확인 방법을 물으면 마지막 콘솔 명령을 설명하지 마세요.\n' +
    '화면에 없는 항목을 물을 때는 화면을 이유로 거절하지 말고, 확인에 쓰는 명령을 알려 주세요.\n' +
    '없는 값은 추측하지 마세요. 화면 원문을 다시 붙이지 마세요.';

  function withDefaults(settings) {
    const s = settings || {};
    return {
      endpoint: String(s.endpoint || '').trim() || DEFAULT_ENDPOINT,
      model: String(s.model || '').trim() || DEFAULT_MODEL,
      apiKey: String(s.apiKey || '').trim(),
      proxyUrl: String(s.proxyUrl || '').trim() || LLM_PROXY_URL_DEFAULT,
      probeDevice: s.probeDevice !== false,
    };
  }

  function loadSettings() {
    return withDefaults({
      endpoint: readStore(ENDPOINT_KEY),
      model: readStore(MODEL_KEY),
      apiKey: readStore(API_KEY_KEY),
      proxyUrl: readStore(PROXY_URL_KEY),
      probeDevice: readStore(PROBE_KEY) !== '0',
    });
  }

  function saveSettings(settings) {
    writeStore(ENDPOINT_KEY, settings.endpoint || '');
    writeStore(MODEL_KEY, settings.model || '');
    writeStore(API_KEY_KEY, settings.apiKey || '');
    writeStore(PROXY_URL_KEY, settings.proxyUrl || '');
    writeStore(PROBE_KEY, settings.probeDevice === false ? '0' : '1');
  }

  function hasEndpoint(settings) {
    return Boolean(String(settings?.endpoint || '').trim() && String(settings?.model || '').trim());
  }

  function canUseRemoteLlm(settings) {
    const s = withDefaults(settings);
    if (!s.endpoint || !s.model) {
      return false;
    }
    if (needsNvidiaProxy(s.endpoint)) {
      return Boolean(nvidiaProxyUrl(s));
    }
    return Boolean(s.apiKey);
  }

  function configError(settings) {
    const s = withDefaults(settings);
    if (!s.endpoint) {
      return 'API 주소를 넣으세요.';
    }
    if (!s.model) {
      return '모델 이름을 넣으세요.';
    }
    if (isHttpsPage() && isHttpLocal(s.endpoint)) {
      return 'https 페이지에서는 http://127.0.0.1 Ollama 를 부를 수 없습니다. mcr_console.bat 으로 열거나 https API 를 쓰세요.';
    }
    if (needsNvidiaProxy(s.endpoint) && !nvidiaProxyUrl(s)) {
      return 'NVIDIA 중계가 없습니다. Cloudflare Worker 를 배포하고 중계 주소를 넣으세요.';
    }
    if (!canUseRemoteLlm(s)) {
      return '콘솔 LLM 은 NVIDIA 중계 또는 API 키가 필요합니다.';
    }
    return '';
  }

  async function analyzePane(pane, settings, question, options) {
    settings = withDefaults(settings);
    const readyError = configError(settings);
    if (readyError) {
      throw new Error(readyError);
    }
    if (!pane) {
      throw new Error('분석할 콘솔이 없습니다.');
    }

    const ask = String(question || '').trim();
    const hint = options || {};
    const howTo = Boolean(ask) && isHowToQuestion(ask);
    let command = String(pane.lastCommand || '').trim();
    let logText = '';

    if (!howTo) {
      const scanLimit = ask ? MAX_ASK_SCAN_LINES : MAX_SCAN_LINES;
      const rawLog = pane.getRecentLog(scanLimit);
      if (!rawLog.trim()) {
        throw new Error('화면에 분석할 로그가 없습니다. 장비를 연결하고 셸 프롬프트에서 다시 누르세요.');
      }
      const sliced = sliceLastCommand(rawLog, pane.lastCommand, logLineLimit(ask));
      command = sliced.command;
      logText = sliced.text;
    }

    const probeFacts = await maybeProbeDevice(pane, ask, hint);
    const userText = buildUserText(pane, logText, ask, probeFacts, command, howTo);
    const answer = await requestChat(
      settings,
      userText,
      ask ? SYSTEM_ASK : SYSTEM_ANALYZE
    );
    if (!answer) {
      throw new Error('모델이 빈 답을 돌려줬습니다.');
    }
    return answer;
  }

  async function maybeProbeDevice(pane, question, options) {
    if (!options || !options.probe || typeof DutProbe === 'undefined') {
      return null;
    }
    if (typeof options.onStatus === 'function') {
      options.onStatus('장비에서 경로와 명령을 확인하는 중…');
    }
    try {
      return await DutProbe.probe(pane, { question: question });
    } catch (err) {
      return { skipped: 'error', message: err && err.message ? err.message : String(err) };
    }
  }

  function buildUserText(pane, logText, question, probeFacts, command, howTo) {
    const cmd = command || pickCommand(pane, logText);
    if (!question) {
      return (
        '장비: ' + (pane.title || '콘솔') + '\n' +
        '지금 설명할 명령: ' + (cmd || '(화면에서 추정)') + '\n' +
        '이 명령의 출력만 있습니다. 다른 명령은 실행되지 않았습니다.\n\n' +
        '출력:\n' + logText + '\n\n' +
        '위 명령과 출력만 한국어로 설명하세요.\n' +
        '- 이 출력이 무엇을 보여 주는지\n' +
        '- 지금 확인할 수 있는 값\n' +
        '출력 원문을 다시 붙이지 마세요. 고정된 매뉴얼 문장을 쓰지 마세요.'
      );
    }

    let userText = '장비: ' + (pane.title || '콘솔') + '\n';
    userText += formatProbeFacts(probeFacts, question);
    userText += '질문: ' + question + '\n\n';
    if (howTo) {
      userText +=
        '이번 질문에만 답하세요.\n' +
        '마지막 콘솔 화면과 이전 명령은 질문과 무관합니다. 언급하지 마세요.\n' +
        '확인에 쓰는 명령을 알려 주세요.';
      return userText;
    }

    userText +=
      '참고용 마지막 화면입니다. 질문이 이 출력에 대한 것일 때만 쓰세요. 아니면 무시하세요.\n' +
      '마지막 명령: ' + (cmd || '(모름)') + '\n' +
      '출력:\n' + logText + '\n\n' +
      '이번 질문에만 한국어로 답하세요. 출력을 그대로 복사하지 마세요.';
    return userText;
  }

  /**
   * 화면에 없는 값을 어떤 명령으로 볼지 묻는 질문.
   * 이런 질문에는 마지막 콘솔 출력을 붙이지 않는다.
   */
  function isHowToQuestion(question) {
    const ask = String(question || '');
    if (!ask) {
      return false;
    }
    return /어떤\s*명령|무슨\s*명령|어떤\s*커맨드|어떤\s*걸로|어떻게\s*(확인|보|알|하)|보려면|알려면|명령을\s*(사용|쓰|알려|치)|쓰면\s*되|사용하면\s*되|치면\s*되|which\s+command|how\s+to|how\s+do\s+i/i.test(ask);
  }

  function formatProbeFacts(facts, question) {
    if (!facts) {
      return '';
    }
    if (facts.skipped) {
      const why = typeof DutProbe !== 'undefined' ? DutProbe.skipLabel(facts) : '';
      const fallback = question
        ? '이번 질문에만 답하세요.'
        : '화면만 보고 답하세요.';
      return '장비 확인: 못 함. ' + (why || facts.skipped) + ' ' + fallback + '\n\n';
    }

    const lines = ['장비에서 직접 확인한 값:'];
    lines.push('현재 경로: ' + (facts.cwd || '(모름)'));
    if (facts.path) {
      lines.push('PATH: ' + facts.path);
    }
    if (facts.files && facts.files.length) {
      lines.push('이 경로의 이름: ' + facts.files.join(', '));
    }
    if (facts.commands && facts.commands.length) {
      lines.push('이 장비에서 확인된 명령: ' + facts.commands.join(', '));
    }
    if (question) {
      lines.push('명령을 추천할 때는 위 목록에 있는 것만 쓰세요. Cisco 스타일 명령은 쓰지 마세요.');
    } else {
      lines.push('지금은 명령을 추천하지 마세요. 화면 출력만 설명하세요.');
    }
    lines.push('');
    return lines.join('\n') + '\n';
  }

  function pickCommand(pane, logText) {
    const seen = guessCommand(logText);
    if (seen) {
      return seen;
    }
    return String(pane.lastCommand || '').trim();
  }

  /**
   * 화면에 보이는 마지막 프롬프트 명령을 쓴다.
   * 칸이 좁아 나뉜 줄은 getRecentLog 에서 이미 붙여 둔다.
   */
  function guessCommand(logText) {
    const lines = String(logText || '').split(/\n/);
    const index = findLastPromptCommandIndex(lines);
    if (index < 0) {
      return '';
    }
    const parsed = parsePromptCommand(lines[index]);
    return parsed ? parsed.command : '';
  }

  function logLineLimit(ask) {
    if (!ask) {
      return MAX_LOG_LINES;
    }
    return MAX_ASK_LOG_LINES;
  }

  /**
   * 마지막 사용자 명령 줄부터 다음 프롬프트 전까지.
   * 이전 ifconfig/brctl/ps 출력은 넣지 않는다.
   * dmesg 처럼 긴 출력은 maxLines 만큼 명령 앞부분부터 보낸다.
   */
  function sliceLastCommand(logText, typedCommand, maxLines) {
    const cleaned = stripProbeBlocks(String(logText || ''));
    const lines = cleaned.split(/\n/);
    const limit = Math.max(8, Number(maxLines) || MAX_LOG_LINES);
    let start = findLastPromptCommandIndex(lines);
    let command = '';

    if (start >= 0) {
      const parsed = parsePromptCommand(lines[start]);
      command = parsed ? parsed.command : '';
    } else {
      start = findLastCommandLine(lines, typedCommand);
      command = String(typedCommand || '').trim();
    }

    if (start < 0) {
      const from = Math.max(0, lines.length - limit);
      return {
        command: command,
        text: trimLogLines(lines.slice(from)).join('\n'),
      };
    }

    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (parsePromptCommand(lines[i]) || isIdlePrompt(lines[i])) {
        end = i;
        break;
      }
    }

    const clipped = trimLogLines(lines.slice(start, Math.min(end, start + limit)));
    return {
      command: command,
      text: clipped.join('\n'),
    };
  }

  function trimLogLines(lines) {
    const out = lines.slice();
    while (out.length && !String(out[out.length - 1] || '').trim()) {
      out.pop();
    }
    return out;
  }

  function findLastPromptCommandIndex(lines) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (isProbeLine(lines[i])) {
        continue;
      }
      const parsed = parsePromptCommand(lines[i]);
      if (parsed && parsed.command) {
        return i;
      }
    }
    return -1;
  }

  /**
   * root@host:~# ifconfig 처럼 셸 프롬프트 뒤 명령을 읽는다.
   * PATH=/usr/bin:$PATH 같은 일반 줄은 건너뛴다.
   */
  function parsePromptCommand(line) {
    const text = String(line || '').replace(/\s+$/g, '');
    if (!text || text.length > 240) {
      return null;
    }
    const match = text.match(/^(.*)([#\$])\s*(\S.*)$/);
    if (!match) {
      return null;
    }
    if (!isPromptPrefix(match[1])) {
      return null;
    }
    return { command: match[3].trim() };
  }

  function isIdlePrompt(line) {
    const text = String(line || '').replace(/\s+$/g, '');
    if (!text || text.length > 180) {
      return false;
    }
    const match = text.match(/^(.*)([#\$])\s*$/);
    return Boolean(match && isPromptPrefix(match[1]));
  }

  function isPromptPrefix(prefix) {
    const text = String(prefix || '').trim();
    if (!text) {
      return true;
    }
    if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+/.test(text)) {
      return true;
    }
    if (/^[\/~][\w./-]*$/.test(text)) {
      return true;
    }
    return false;
  }

  function isProbeLine(line) {
    const text = String(line || '');
    const probeCmd = typeof DutProbe !== 'undefined' ? String(DutProbe.command || '') : '';
    if (probeCmd && text.indexOf(probeCmd) >= 0) {
      return true;
    }
    return text.indexOf('echo --PATH--') >= 0
      || text.indexOf('echo --LS--') >= 0
      || text.indexOf('echo --BB--') >= 0;
  }

  function stripProbeBlocks(logText) {
    const lines = String(logText || '').split(/\n/);
    const kept = [];
    let skipping = false;
    const probeCmd = typeof DutProbe !== 'undefined' ? String(DutProbe.command || '') : '';

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const isProbeStart = (probeCmd && line.indexOf(probeCmd) >= 0)
        || (line.indexOf('--PATH--') >= 0 && line.indexOf('pwd') >= 0)
        || (line.indexOf('echo --PATH--') >= 0);

      if (!skipping && isProbeStart) {
        skipping = true;
        continue;
      }
      if (skipping) {
        if (isUserPromptLine(line) && line.indexOf('--PATH--') < 0 && line.indexOf('busybox --list') < 0) {
          skipping = false;
          kept.push(line);
        }
        continue;
      }
      kept.push(line);
    }
    return kept.join('\n');
  }

  function findLastCommandLine(lines, command) {
    const needle = String(command || '').trim();
    if (!needle) {
      return -1;
    }
    const compact = needle.replace(/\s+/g, ' ');
    const tail = compact.length > 40 ? compact.slice(-40) : compact;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = String(lines[i] || '').replace(/\s+/g, ' ');
      if (line.indexOf(compact) >= 0 || (tail && line.indexOf(tail) >= 0)) {
        return i;
      }
    }
    return -1;
  }

  function isUserPromptLine(line) {
    return Boolean(parsePromptCommand(line) || isIdlePrompt(line));
  }

  async function requestChat(settings, userText, systemPrompt) {
    settings = withDefaults(settings);
    const endpoint = String(settings.endpoint || '').trim();
    const headers = {
      'Content-Type': 'application/json',
    };
    if (settings.apiKey) {
      headers.Authorization = 'Bearer ' + settings.apiKey;
    }

    let fetchUrl = endpoint;
    if (needsNvidiaProxy(endpoint)) {
      const proxy = nvidiaProxyUrl(settings);
      if (!proxy) {
        throw new Error(
          'NVIDIA 는 브라우저에서 직접 부를 수 없습니다. Cloudflare Worker 중계 주소를 넣거나, mcr_console.bat 으로 여세요.'
        );
      }
      fetchUrl = proxy;
      headers['X-Llm-Target'] = endpoint;
    }

    let response;
    try {
      response = await fetch(fetchUrl, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          model: String(settings.model || '').trim(),
          temperature: 0.2,
          max_tokens: 1024,
          messages: [
            { role: 'system', content: systemPrompt || SYSTEM_ANALYZE },
            { role: 'user', content: userText },
          ],
        }),
      });
    } catch (err) {
      throw new Error(toNetworkError(err, endpoint));
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

    const message = data?.choices?.[0]?.message || {};
    let text = message.content;
    if (Array.isArray(text)) {
      text = text.map((part) => (part && part.text) || part || '').join('');
    }
    if (!String(text || '').trim() && message.reasoning_content) {
      text = message.reasoning_content;
    }
    return String(text || '').trim();
  }

  function toNetworkError(err, endpoint) {
    const message = err?.message || String(err);
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      if (needsNvidiaProxy(endpoint) && !canUseLocalProxy()) {
        return 'NVIDIA 중계에 닿지 못했습니다. 중계 주소가 https://이름.workers.dev 인지, Cloudflare Worker 가 배포됐는지 확인하세요.';
      }
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

  function needsNvidiaProxy(endpoint) {
    try {
      const host = new URL(endpoint, location.href).hostname.toLowerCase();
      return host === 'integrate.api.nvidia.com' ||
        host === 'api.nvidia.com' ||
        host.slice(-15) === '.api.nvidia.com';
    } catch {
      return false;
    }
  }

  function canUseLocalProxy() {
    return location.protocol === 'http:';
  }

  function readCloudProxyUrl(settings) {
    const fromForm = String(settings?.proxyUrl || '').trim();
    const fallback = String(LLM_PROXY_URL_DEFAULT || '').trim();
    return (fromForm || fallback).replace(/\/+$/, '');
  }

  function nvidiaProxyUrl(settings) {
    const cloud = readCloudProxyUrl(settings);
    if (cloud) {
      return cloud.replace(/\/+$/, '') + '/api/llm-proxy';
    }
    if (canUseLocalProxy()) {
      return location.origin + '/api/llm-proxy';
    }
    return '';
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
    canUseRemoteLlm: canUseRemoteLlm,
    configError: configError,
    analyzePane: analyzePane,
    maxLogLines: MAX_LOG_LINES,
    defaultEndpoint: DEFAULT_ENDPOINT,
    defaultModel: DEFAULT_MODEL,
    defaultProxyUrl: LLM_PROXY_URL_DEFAULT,
  };
})(window);
