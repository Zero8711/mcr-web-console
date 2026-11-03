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
  const AFTER_CMD_KEY = 'llm-after-command';
  const PROBE_KEY = 'llm-probe-device';
  const MAX_LOG_LINES = 80;
  const CHROME_NEED_CLICK = 'CHROME_AI_NEED_CLICK';
  const CHROME_UNAVAILABLE = 'CHROME_AI_UNAVAILABLE';

  const SYSTEM_PROMPT =
    '당신은 AP/라우터 시리얼 콘솔을 보고 시험자를 돕는 조수입니다.\n' +
    '한국어로 3~8문장 설명하세요.\n' +
    '지금 화면이 무엇을 보여 주는지, 시험자가 어떤 값을 보면 되는지 말하세요.\n' +
    '화면에 있는 이름과 숫자만 쓰세요. 없는 값은 추측하지 마세요.\n' +
    '화면 출력을 그대로 다시 붙이지 마세요. 번호 목록을 비워 두지 마세요.\n' +
    '질문이 없으면 다른 명령을 제안하지 마세요.\n' +
    '질문이 있으면 그 질문에 먼저 답하고, 화면을 근거로 설명하세요.\n' +
    '아래에 붙은 화면만 이번 명령 결과입니다. 다른 명령 결과를 끌어오지 마세요.';

  let chromeSession = null;
  let chromeSessionWait = null;
  const chromeProgressListeners = [];

  function loadSettings() {
    return {
      endpoint: readStore(ENDPOINT_KEY) || '',
      model: readStore(MODEL_KEY) || '',
      apiKey: readStore(API_KEY_KEY) || '',
      afterCommand: readStore(AFTER_CMD_KEY) !== '0',
      probeDevice: readStore(PROBE_KEY) !== '0',
    };
  }

  function saveSettings(settings) {
    writeStore(ENDPOINT_KEY, settings.endpoint || '');
    writeStore(MODEL_KEY, settings.model || '');
    writeStore(API_KEY_KEY, settings.apiKey || '');
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
    let logText = pane.getRecentLog(MAX_LOG_LINES);
    if (!logText.trim()) {
      throw new Error('화면에 분석할 로그가 없습니다. 장비를 연결하고 셸 프롬프트에서 다시 누르세요.');
    }
    const command = pickCommand(pane, logText);
    logText = clipAnalysisLog(logText, command);
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
      '마지막 명령: ' + (cmd || '(화면에서 추정)') + '\n\n';
    if (question) {
      userText += formatProbeFacts(probeFacts, question);
    }
    userText += '화면:\n' + logText + '\n\n';
    if (question) {
      userText += '질문: ' + question + '\n';
      userText += '화면을 근거로 한국어로 답하세요. 화면을 그대로 복사하지 마세요.';
    } else {
      userText +=
        '아래는 이번 명령의 결과만입니다. 이전 명령은 없다고 생각하고 설명하세요.\n' +
        '- 이 출력이 무엇을 보여 주는지\n' +
        '- 지금 화면에서 확인할 수 있는 값(이름, IP, 링크, 포트, 에러 등)\n' +
        '화면 원문을 다시 붙이지 마세요. 고정된 매뉴얼 문장을 쓰지 마세요.';
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
    const shouldDestroy = session !== chromeSession;
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
      if (shouldDestroy && session && typeof session.destroy === 'function') {
        try {
          session.destroy();
        } catch {
          // session already gone
        }
      }
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
    return Boolean(chromeSession);
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
      chromeSessionWait = null;
      return session;
    }).catch(function (err) {
      chromeSessionWait = null;
      throw err;
    });

    return chromeSessionWait;
  }

  /**
   * 분석마다 새 대화를 연다. clone 은 이전 턴이 섞일 수 있어 쓰지 않는다.
   */
  async function openChromeTurn(options) {
    await getChromeSession(options);
    return LanguageModel.create({
      initialPrompts: [
        { role: 'system', content: SYSTEM_PROMPT },
      ],
    });
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
   * 이번 명령 출력만 남긴다. pwd/busybox 확인 출력과 이전 명령은 뺀다.
   */
  function clipAnalysisLog(logText, command) {
    const cleaned = stripProbeBlocks(String(logText || ''));
    const lines = cleaned.split(/\n/);
    const start = findLastCommandLine(lines, command);
    const from = start >= 0 ? start : Math.max(0, lines.length - 20);
    const clipped = lines.slice(from, from + 35);
    while (clipped.length && !clipped[clipped.length - 1]) {
      clipped.pop();
    }
    return clipped.join('\n');
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
    const text = String(line || '').replace(/\s+$/g, '');
    if (!text || text.length > 180) {
      return false;
    }
    if (/@/.test(text) && /[#\$]/.test(text)) {
      return true;
    }
    return /[#\$]\s*$/.test(text) && /[\/~:]/.test(text);
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
    prefetchChromeAi: prefetchChromeAi,
    isChromeSessionReady: isChromeSessionReady,
    isChromeDownloading: isChromeDownloading,
    maxLogLines: MAX_LOG_LINES,
  };
})(window);
