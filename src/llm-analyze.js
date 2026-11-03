/**
 * 선택 칸의 최근 화면을 짧게 설명한다.
 * API 키가 없으면 Chrome 내장 AI(Gemini Nano)를 먼저 쓰고,
 * 그 브라우저/PC에서 못 쓰면 화면 읽기 시험으로 떨어진다.
 * 키를 넣으면 OpenAI 호환 chat/completions 을 부른다.
 * 장비로는 명령을 보내지 않는다.
 */
(function (global) {
  const ENDPOINT_KEY = 'llm-endpoint';
  const MODEL_KEY = 'llm-model';
  const API_KEY_KEY = 'llm-api-key';
  const AFTER_CMD_KEY = 'llm-after-command';
  const MAX_LOG_LINES = 80;
  const CHROME_NEED_CLICK = 'CHROME_AI_NEED_CLICK';
  const CHROME_UNAVAILABLE = 'CHROME_AI_UNAVAILABLE';

  const SYSTEM_PROMPT =
    '당신은 AP/라우터 시리얼 콘솔을 보는 시험 조수입니다. ' +
    '한국어로 짧게 답하세요. 목록은 3~6개면 됩니다.\n' +
    '반드시 아래를 포함하세요.\n' +
    '1) 마지막 명령이 무엇인지\n' +
    '2) 이 명령으로 무엇을 확인하는지\n' +
    '3) 출력에서 눈에 띄는 정보(인터페이스, IP, 링크, 에러 카운터 등)\n' +
    '화면에 없는 값은 추측이라고 밝히세요. ' +
    '시험자 질문이 있으면 그 질문에 먼저 답하세요. ' +
    '장비에 보낼 명령은 제안만 하고, 실행했다고 말하지 마세요. ' +
    '영어 로그 값(인터페이스 이름, IP, 카운터)은 그대로 두세요.';

  let chromeSession = null;
  let chromeSessionWait = null;

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

  function isTrialMode(settings) {
    return !String(settings?.apiKey || '').trim();
  }

  function hasChromePromptApi() {
    return typeof LanguageModel !== 'undefined'
      && typeof LanguageModel.availability === 'function'
      && typeof LanguageModel.create === 'function';
  }

  /**
   * 버튼 안내문용. 모델은 받지 않는다.
   */
  async function probeChromeAi() {
    if (!hasChromePromptApi()) {
      return {
        state: 'no-api',
        message: '이 브라우저는 Chrome 내장 AI 가 없습니다. 공식 Chrome 148 이상으로 이 주소를 여세요. Edge 는 안 됩니다.',
      };
    }

    try {
      const state = await LanguageModel.availability();
      if (state === 'available') {
        return {
          state: state,
          message: 'Chrome 내장 AI(Gemini Nano)를 이 칸에서 씁니다. API 키는 필요 없습니다.',
        };
      }
      if (state === 'downloadable') {
        return {
          state: state,
          message: '[이 칸 분석] 또는 [묻기]를 누르면 Chrome 이 내장 모델을 받습니다. 첫 1회만 내려받습니다.',
        };
      }
      if (state === 'downloading') {
        return {
          state: state,
          message: 'Chrome 이 내장 모델을 받는 중입니다. 잠시 뒤 [이 칸 분석]을 다시 누르세요.',
        };
      }
      return {
        state: 'unavailable',
        message: '이 PC 는 Chrome 내장 AI 조건을 못 맞춥니다. 지금은 화면 읽기 시험으로 동작합니다.',
      };
    } catch (err) {
      return {
        state: 'unavailable',
        message: 'Chrome 내장 AI 상태를 못 읽었습니다. 지금은 화면 읽기 시험으로 동작합니다.',
      };
    }
  }

  function configError(settings) {
    if (isTrialMode(settings)) {
      return '';
    }
    if (!String(settings?.endpoint || '').trim()) {
      return '유료 API 를 쓰려면 주소를 넣으세요.';
    }
    if (!String(settings?.model || '').trim()) {
      return '모델 이름을 넣으세요.';
    }
    if (isHttpsPage() && isHttpLocal(settings.endpoint)) {
      return 'https 페이지에서는 http://127.0.0.1 Ollama 를 부를 수 없습니다. mcr_console.bat 으로 열거나 https API 를 쓰세요.';
    }
    return '';
  }

  async function analyzePane(pane, settings, question, options) {
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

    const ask = String(question || '').trim();
    const hint = options || {};

    if (!isTrialMode(settings)) {
      const answer = await requestChat(settings, buildUserText(pane, logText, ask));
      if (!answer) {
        throw new Error('모델이 빈 답을 돌려줬습니다.');
      }
      return answer;
    }

    if (hasChromePromptApi()) {
      try {
        return await explainWithChromeAi(pane, logText, ask, hint);
      } catch (err) {
        const code = err && err.message;
        if (code === CHROME_UNAVAILABLE || code === CHROME_NEED_CLICK) {
          return explainFromScreen(pane, logText, ask);
        }
        throw new Error(toChromeError(err));
      }
    }

    return explainFromScreen(pane, logText, ask);
  }

  function buildUserText(pane, logText, question) {
    let userText =
      '장비: ' + (pane.title || '콘솔') + '\n' +
      '마지막 명령: ' + (pane.lastCommand || '(화면에서 추정)') + '\n\n' +
      '화면:\n' +
      logText;
    if (question) {
      userText += '\n\n시험자 질문:\n' + question;
    }
    return userText;
  }

  async function explainWithChromeAi(pane, logText, question, options) {
    const session = await getChromeSession(options);
    const answer = String(await session.prompt(buildUserText(pane, logText, question)) || '').trim();
    if (!answer) {
      throw new Error('Chrome 내장 AI 가 빈 답을 돌려줬습니다.');
    }
    return '[Chrome 내장 AI · Gemini Nano]\n\n' + answer;
  }

  async function getChromeSession(options) {
    if (chromeSession) {
      return chromeSession;
    }
    if (chromeSessionWait) {
      return chromeSessionWait;
    }

    const allowDownload = options.allowDownload !== false;
    const onProgress = options.onProgress;
    let state = 'unavailable';

    try {
      state = await LanguageModel.availability();
    } catch {
      throw new Error(CHROME_UNAVAILABLE);
    }

    if (state === 'unavailable') {
      throw new Error(CHROME_UNAVAILABLE);
    }
    if ((state === 'downloadable' || state === 'downloading') && !allowDownload) {
      throw new Error(CHROME_NEED_CLICK);
    }

    chromeSessionWait = LanguageModel.create({
      initialPrompts: [
        { role: 'system', content: SYSTEM_PROMPT },
      ],
      monitor: function (monitor) {
        if (!onProgress) {
          return;
        }
        monitor.addEventListener('downloadprogress', function (event) {
          onProgress(Number(event.loaded) || 0);
        });
      },
    }).then(function (session) {
      chromeSession = session;
      chromeSessionWait = null;
      return session;
    }).catch(function (err) {
      chromeSessionWait = null;
      throw err;
    });

    return chromeSessionWait;
  }

  function toChromeError(err) {
    const name = err && err.name ? String(err.name) : '';
    const message = err && err.message ? String(err.message) : String(err);
    if (name === 'NotAllowedError' || /user activation|NotAllowedError/i.test(message)) {
      return 'Chrome 내장 모델은 버튼을 누른 뒤에만 받을 수 있습니다. [이 칸 분석]을 다시 누르세요.';
    }
    if (name === 'NotSupportedError') {
      return '이 Chrome 은 지금 요청을 내장 AI 로 처리하지 못합니다. 공식 Chrome 148 이상인지 확인하세요.';
    }
    if (/failed to fetch|networkerror|load failed/i.test(message)) {
      return 'Chrome 내장 모델을 받지 못했습니다. 네트워크와 디스크 여유 공간을 확인하세요.';
    }
    return 'Chrome 내장 AI 오류: ' + message;
  }

  /**
   * 유료 API / Chrome 내장 AI 없이, 화면 텍스트를 읽었는지만 확인한다.
   * ifconfig 출력에서 IP·인터페이스는 실제로 뽑아 보여 준다.
   */
  function explainFromScreen(pane, logText, question) {
    const command = pickCommand(pane, logText);
    const help = commandHelp(command);
    const facts = command.toLowerCase().indexOf('ifconfig') >= 0
      ? readIfconfigFacts(logText)
      : [];
    const ask = String(question || '').trim();

    const lines = [
      '[화면 읽기 시험 · Chrome 내장 AI 없음]',
      '장비: ' + (pane.title || '콘솔'),
      '',
      '1) 마지막 명령: ' + (command || '(화면에서 명령을 찾지 못했습니다)'),
      '2) ' + help,
    ];

    if (facts.length) {
      lines.push('3) 화면에서 읽은 값:');
      for (const fact of facts) {
        lines.push('   - ' + fact);
      }
    } else {
      lines.push('3) 화면에서 ' + logText.split(/\n/).filter(Boolean).length + '줄을 읽었습니다.');
    }

    lines.push('');
    if (ask) {
      lines.push('질문: ' + ask);
      lines.push('답: (지금은 Chrome 내장 AI / 유료 API 가 없어 답을 쓰지 않습니다. 질문과 화면은 같이 묶였습니다.)');
    } else {
      lines.push('이 칸이 뜨면 콘솔 → 분석 칸 연결은 된 것입니다. Chrome 내장 AI 는 이 브라우저에서 쓰지 못했습니다.');
    }
    return lines.join('\n');
  }

  function commandHelp(command) {
    const name = String(command || '').toLowerCase().split(/\s+/)[0];
    if (name === 'ifconfig') {
      return '이 명령으로 무엇을 확인하는지: 인터페이스 이름, IP, MAC, 링크 UP/DOWN, RX/TX 에러.';
    }
    if (name === 'ethtool') {
      return '이 명령으로 무엇을 확인하는지: NIC 속도, 링크, 오프로드, 도움말(-h).';
    }
    if (name === 'ps') {
      return '이 명령으로 무엇을 확인하는지: 떠 있는 프로세스와 데몬.';
    }
    if (name === 'logread' || name === 'dmesg') {
      return '이 명령으로 무엇을 확인하는지: 커널/시스템 로그.';
    }
    if (name === 'brctl') {
      return '이 명령으로 무엇을 확인하는지: 브리지와 묶인 포트.';
    }
    if (name === 'uptime' || name === 'free' || name === 'df') {
      return '이 명령으로 무엇을 확인하는지: 부하, 메모리, 디스크.';
    }
    if (command) {
      return '이 명령으로 무엇을 확인하는지: (시험 모드라 일반 설명만 합니다. Chrome 내장 AI 또는 유료 API 를 쓰면 출력을 해석합니다.)';
    }
    return '이 명령으로 무엇을 확인하는지: 명령을 찾지 못했습니다. ifconfig 버튼을 눌러 보세요.';
  }

  function pickCommand(pane, logText) {
    const typed = String(pane.lastCommand || '').trim();
    const seen = guessCommand(logText);
    if (seen && typed && seen !== typed && seen.endsWith(typed)) {
      return seen;
    }
    return typed || seen || '';
  }

  /**
   * 프롬프트 뒤의 명령을 통째로 가져온다. -h 같은 옵션도 포함.
   * 칸이 좁아 나뉜 줄은 getRecentLog 에서 이미 붙여 둔다.
   */
  function guessCommand(logText) {
    const lines = String(logText || '').split(/\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!/@/.test(line) || !/[#\$]/.test(line)) {
        continue;
      }
      const hashed = line.match(/[#\$]\s+(\S.*)$/);
      if (hashed) {
        return hashed[1].trim();
      }
    }
    return '';
  }

  function readIfconfigFacts(logText) {
    const facts = [];
    const blocks = String(logText || '').split(/\n(?=\S+\s+Link encap)/);
    for (const block of blocks) {
      const nameMatch = block.match(/^(\S+)\s+Link encap/m);
      if (!nameMatch) {
        continue;
      }
      const name = nameMatch[1];
      const ipMatch = block.match(/inet addr:(\d+\.\d+\.\d+\.\d+)/);
      const rxErr = block.match(/RX packets:\d+\s+errors:(\d+)/);
      const up = /\bUP\b/.test(block);
      const parts = [name];
      parts.push(up ? 'UP' : 'DOWN/미확인');
      if (ipMatch) {
        parts.push('IP ' + ipMatch[1]);
      }
      if (rxErr) {
        parts.push('RX errors ' + rxErr[1]);
      }
      facts.push(parts.join(', '));
    }
    return facts.slice(0, 8);
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
    isTrialMode: isTrialMode,
    hasChromePromptApi: hasChromePromptApi,
    probeChromeAi: probeChromeAi,
    maxLogLines: MAX_LOG_LINES,
  };
})(window);
