/**
 * 선택 칸의 최근 화면을 짧게 설명한다.
 * API 키가 없으면 Chrome 내장 AI(Gemini Nano)를 먼저 쓰고,
 * 그 브라우저/PC에서 못 쓰면 화면 읽기 시험으로 떨어진다.
 * 키를 넣으면 OpenAI 호환 chat/completions 을 부른다.
 * 질문·분석 때는 장비에 pwd 와 명령 목록만 보내 확인한다.
 */
(function (global) {
  const ENDPOINT_KEY = 'llm-endpoint';
  const MODEL_KEY = 'llm-model';
  const API_KEY_KEY = 'llm-api-key';
  const PROXY_URL_KEY = 'llm-proxy-url';
  const AFTER_CMD_KEY = 'llm-after-command';
  const PROBE_KEY = 'llm-probe-device';
  /**
   * Cloudflare Worker 주소. 끝에 / 없이.
   * 배포 후 나온 https://이름.workers.dev 를 여기 넣으면
   * GitHub Pages 에서도 NVIDIA 를 쓴다.
   */
  const LLM_PROXY_URL_DEFAULT = '';
  const MAX_LOG_LINES = 80;
  const MAX_SCAN_LINES = 400;
  const CHROME_NEED_CLICK = 'CHROME_AI_NEED_CLICK';
  const CHROME_UNAVAILABLE = 'CHROME_AI_UNAVAILABLE';

  const SYSTEM_PROMPT =
    '당신은 AP/라우터 시리얼 콘솔을 보고 시험자를 돕는 조수입니다.\n' +
    '한국어로 3~8문장 설명하세요.\n' +
    '이번 메시지에 붙은 명령과 출력만 설명하세요. 이전 대화는 없습니다.\n' +
    '화면에 있는 이름과 숫자만 쓰세요. 없는 값은 추측하지 마세요.\n' +
    '화면 출력을 그대로 다시 붙이지 마세요. 번호 목록을 비워 두지 마세요.\n' +
    '질문이 없으면 다른 명령을 제안하지 마세요.\n' +
    '질문이 있으면 그 질문에 먼저 답하고, 이번 출력만 근거로 쓰세요.';

  let chromeSession = null;
  let chromeSessionWait = null;
  let chromeModelReady = false;
  const chromeProgressListeners = [];

  function loadSettings() {
    return {
      endpoint: readStore(ENDPOINT_KEY) || '',
      model: readStore(MODEL_KEY) || '',
      apiKey: readStore(API_KEY_KEY) || '',
      proxyUrl: readStore(PROXY_URL_KEY) || LLM_PROXY_URL_DEFAULT,
      afterCommand: readStore(AFTER_CMD_KEY) !== '0',
      probeDevice: readStore(PROBE_KEY) !== '0',
    };
  }

  function saveSettings(settings) {
    writeStore(ENDPOINT_KEY, settings.endpoint || '');
    writeStore(MODEL_KEY, settings.model || '');
    writeStore(API_KEY_KEY, settings.apiKey || '');
    writeStore(PROXY_URL_KEY, settings.proxyUrl || '');
    writeStore(AFTER_CMD_KEY, settings.afterCommand ? '1' : '0');
    writeStore(PROBE_KEY, settings.probeDevice === false ? '0' : '1');
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
          message: '페이지를 한 번 클릭하면 Chrome 이 내장 모델을 받기 시작합니다. 용량이 커서 첫 1회만 깁니다. 그동안 COM 연결은 그대로 하세요.',
        };
      }
      if (state === 'downloading') {
        return {
          state: state,
          message: 'Chrome 이 내장 모델을 받는 중입니다. 그동안 COM 연결·명령은 그대로 하세요.',
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
    if (needsNvidiaProxy(settings.endpoint) && !nvidiaProxyUrl(settings)) {
      return 'NVIDIA 는 브라우저에서 직접 부를 수 없습니다. Cloudflare Worker 중계 주소를 넣거나, mcr_console.bat 으로 여세요.';
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

    const ask = String(question || '').trim();
    const hint = options || {};
    const rawLog = pane.getRecentLog(MAX_SCAN_LINES);
    if (!rawLog.trim()) {
      throw new Error('화면에 분석할 로그가 없습니다. 장비를 연결하고 셸 프롬프트에서 다시 누르세요.');
    }
    const sliced = sliceLastCommand(rawLog, pane.lastCommand);
    const command = sliced.command;
    const logText = sliced.text;
    const probeFacts = await maybeProbeDevice(pane, ask, hint);

    if (!isTrialMode(settings)) {
      const answer = await requestChat(settings, buildUserText(pane, logText, ask, probeFacts, command));
      if (!answer) {
        throw new Error('모델이 빈 답을 돌려줬습니다.');
      }
      return answer;
    }

    if (hasChromePromptApi()) {
      try {
        return await explainWithChromeAi(pane, logText, ask, hint, probeFacts, command);
      } catch (err) {
        const code = err && err.message;
        if (code === CHROME_UNAVAILABLE || code === CHROME_NEED_CLICK) {
          return explainFromScreen(pane, logText, ask, probeFacts);
        }
        throw new Error(toChromeError(err));
      }
    }

    return explainFromScreen(pane, logText, ask, probeFacts);
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

  function buildUserText(pane, logText, question, probeFacts, command) {
    const cmd = command || pickCommand(pane, logText);
    let userText =
      '장비: ' + (pane.title || '콘솔') + '\n' +
      '지금 설명할 명령: ' + (cmd || '(화면에서 추정)') + '\n' +
      '이 명령의 출력만 있습니다. 다른 명령은 실행되지 않았습니다.\n\n';
    if (question) {
      userText += formatProbeFacts(probeFacts, question);
    }
    userText += '출력:\n' + logText + '\n\n';
    if (question) {
      userText += '질문: ' + question + '\n';
      userText += '위 출력만 근거로 한국어로 답하세요. 출력을 그대로 복사하지 마세요.';
    } else {
      userText +=
        '위 명령과 출력만 한국어로 설명하세요.\n' +
        '- 이 출력이 무엇을 보여 주는지\n' +
        '- 지금 확인할 수 있는 값\n' +
        '출력 원문을 다시 붙이지 마세요. 고정된 매뉴얼 문장을 쓰지 마세요.';
    }
    return userText;
  }

  function formatProbeFacts(facts, question) {
    if (!facts) {
      return '';
    }
    if (facts.skipped) {
      const why = typeof DutProbe !== 'undefined' ? DutProbe.skipLabel(facts) : '';
      return '장비 확인: 못 함. ' + (why || facts.skipped) + ' 화면만 보고 답하세요.\n\n';
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

  async function explainWithChromeAi(pane, logText, question, options, probeFacts, command) {
    const session = await openChromeTurn(options);
    try {
      const answer = String(await session.prompt(buildUserText(pane, logText, question, probeFacts, command)) || '').trim();
      if (!answer) {
        throw new Error('Chrome 내장 AI 가 빈 답을 돌려줬습니다.');
      }
      const tag = probeFacts && !probeFacts.skipped
        ? '[Chrome 내장 AI · 장비 경로 확인]'
        : '[Chrome 내장 AI · Gemini Nano]';
      return tag + '\n\n' + answer;
    } finally {
      destroyChromeSession();
    }
  }

  function addChromeProgress(onProgress) {
    if (typeof onProgress !== 'function') {
      return;
    }
    if (chromeProgressListeners.indexOf(onProgress) >= 0) {
      return;
    }
    chromeProgressListeners.push(onProgress);
  }

  function notifyChromeProgress(loaded) {
    const value = Number(loaded) || 0;
    for (let i = 0; i < chromeProgressListeners.length; i += 1) {
      chromeProgressListeners[i](value);
    }
  }

  function isChromeSessionReady() {
    return Boolean(chromeSession) || chromeModelReady;
  }

  function isChromeDownloading() {
    return Boolean(chromeSessionWait) && !chromeSession;
  }

  /**
   * 첫 클릭에서 모델을 미리 받는다. 분석 버튼을 누를 때까지 기다리지 않는다.
   */
  function prefetchChromeAi(options) {
    if (!hasChromePromptApi()) {
      return Promise.resolve(null);
    }
    return getChromeSession({
      allowDownload: true,
      onProgress: options && options.onProgress,
    }).catch(function (err) {
      const code = err && err.message;
      if (code === CHROME_UNAVAILABLE || code === CHROME_NEED_CLICK) {
        return null;
      }
      throw err;
    });
  }

  async function getChromeSession(options) {
    const hint = options || {};
    addChromeProgress(hint.onProgress);

    if (chromeSession) {
      return chromeSession;
    }
    if (chromeSessionWait) {
      return chromeSessionWait;
    }

    const allowDownload = hint.allowDownload !== false;
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
        monitor.addEventListener('downloadprogress', function (event) {
          notifyChromeProgress(Number(event.loaded) || 0);
        });
      },
    }).then(function (session) {
      chromeSession = session;
      chromeModelReady = true;
      chromeSessionWait = null;
      return session;
    }).catch(function (err) {
      chromeSessionWait = null;
      throw err;
    });

    return chromeSessionWait;
  }

  function destroyChromeSession() {
    const session = chromeSession;
    chromeSession = null;
    if (session && typeof session.destroy === 'function') {
      try {
        session.destroy();
      } catch {
        // session already gone
      }
    }
  }

  /**
   * 분석마다 빈 대화를 연다. 이전 턴을 같은 세션에 남기면
   * cat 온도를 brctl 로 설명하는 일이 생긴다.
   */
  async function openChromeTurn(options) {
    addChromeProgress(options && options.onProgress);
    if (chromeSessionWait) {
      await chromeSessionWait;
    }
    if (!chromeModelReady) {
      await getChromeSession(options);
    }
    destroyChromeSession();
    const session = await LanguageModel.create({
      initialPrompts: [
        { role: 'system', content: SYSTEM_PROMPT },
      ],
    });
    chromeSession = session;
    chromeModelReady = true;
    return session;
  }

  function toChromeError(err) {
    const name = err && err.name ? String(err.name) : '';
    const message = err && err.message ? String(err.message) : String(err);
    if (name === 'NotAllowedError' || /user activation|NotAllowedError/i.test(message)) {
      return 'Chrome 내장 모델은 페이지를 한 번 클릭한 뒤에만 받을 수 있습니다. 아무 곳이나 다시 클릭하세요.';
    }
    if (name === 'NotSupportedError') {
      return '이 Chrome 은 지금 요청을 내장 AI 로 처리하지 못합니다. 공식 Chrome 148 이상인지 확인하세요.';
    }
    if (name === 'QuotaExceededError' || /quota exceeded/i.test(message)) {
      return 'Chrome 내장 AI 세션이 아직 남아 있습니다. 페이지를 새로고침한 뒤 다시 분석하세요.';
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
  function explainFromScreen(pane, logText, question, probeFacts) {
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

    if (probeFacts && !probeFacts.skipped) {
      lines.push('현재 경로: ' + (probeFacts.cwd || '(모름)'));
      if (probeFacts.commands && probeFacts.commands.length) {
        lines.push('이 장비에서 확인된 명령: ' + probeFacts.commands.join(', '));
      }
    } else if (probeFacts && probeFacts.skipped && typeof DutProbe !== 'undefined') {
      lines.push(DutProbe.skipLabel(probeFacts));
    }

    const screenFacts = facts.length ? facts : readScreenFacts(command, logText);
    if (screenFacts.length) {
      lines.push('3) 화면에서 읽은 값:');
      for (const fact of screenFacts) {
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

  function readScreenFacts(command, logText) {
    const name = String(command || '').toLowerCase().split(/\s+/)[0];
    if (name === 'ifconfig') {
      return readIfconfigFacts(logText);
    }
    if (name === 'brctl') {
      return readBrctlFacts(logText);
    }
    return [];
  }

  /**
   * brctl show 표에서 브리지 이름과 묶인 포트를 뽑는다.
   */
  function readBrctlFacts(logText) {
    const lines = String(logText || '').split(/\n/);
    const bridges = [];
    let current = null;

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const line = raw.replace(/\s+$/g, '');
      if (!line || /bridge name/i.test(line)) {
        continue;
      }
      if (/[#\$]\s*$/.test(line) && /@|[\/~:]/.test(line)) {
        continue;
      }

      if (/^\s+\S/.test(raw) && current) {
        const extra = line.trim().split(/\s+/);
        for (let j = 0; j < extra.length; j += 1) {
          if (extra[j] && current.ifaces.indexOf(extra[j]) < 0) {
            current.ifaces.push(extra[j]);
          }
        }
        continue;
      }

      const parts = line.trim().split(/\s+/);
      const name = parts[0];
      if (!name || name === 'bridge' || !/^[A-Za-z][A-Za-z0-9._-]*$/.test(name)) {
        continue;
      }

      current = { name: name, stp: '', ifaces: [] };
      for (let j = 1; j < parts.length; j += 1) {
        const part = parts[j];
        if (/^(yes|no)$/i.test(part)) {
          current.stp = part.toLowerCase();
          continue;
        }
        if (/^[0-9a-f]+\.[0-9a-f]+$/i.test(part)) {
          continue;
        }
        if (j >= 2) {
          current.ifaces.push(part);
        }
      }
      bridges.push(current);
    }

    const facts = [];
    for (let i = 0; i < bridges.length && facts.length < 8; i += 1) {
      const item = bridges[i];
      let text = item.name;
      if (item.stp) {
        text += ', STP ' + item.stp;
      }
      if (item.ifaces.length) {
        text += ', ports ' + item.ifaces.join(', ');
      }
      facts.push(text);
    }
    return facts;
  }

  /**
   * 마지막 사용자 명령 줄부터 다음 프롬프트 전까지.
   * 이전 ifconfig/brctl/ps 출력은 넣지 않는다.
   */
  function sliceLastCommand(logText, typedCommand) {
    const cleaned = stripProbeBlocks(String(logText || ''));
    const lines = cleaned.split(/\n/);
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
      const from = Math.max(0, lines.length - 8);
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

    const clipped = trimLogLines(lines.slice(start, Math.min(end, start + MAX_LOG_LINES)));
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

  async function requestChat(settings, userText) {
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
            { role: 'system', content: SYSTEM_PROMPT },
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
    if (canUseLocalProxy()) {
      return location.origin + '/api/llm-proxy';
    }
    const cloud = readCloudProxyUrl(settings);
    if (!cloud) {
      return '';
    }
    return cloud + '/api/llm-proxy';
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
    prefetchChromeAi: prefetchChromeAi,
    isChromeSessionReady: isChromeSessionReady,
    isChromeDownloading: isChromeDownloading,
    maxLogLines: MAX_LOG_LINES,
  };
})(window);
