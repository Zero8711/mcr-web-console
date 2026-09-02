/**
 * 에이징 이상로그 감시.
 * 키워드가 나오면 발생 시각과 해당 줄을 앞에 두고,
 * 위 200줄·아래 200줄만 파일로 저장한다.
 */
(function (global) {
  const DEFAULT_KEYWORDS =
    'error, fail, panic, crash, exception, watchdog, assert, fatal, critical, oops';
  const BEFORE_LINE_LIMIT = 200;
  const AFTER_LINE_LIMIT = 200;
  const KEYWORD_STORAGE_KEY = 'aging-log-keywords';
  const FLUSH_INTERVAL_MS = 2000;

  class AgingLogWatcher {
    constructor(options) {
      this.paneId = String(options?.paneId || '1');
      this.consoleTitle = options?.consoleTitle || '';
      this.dirHandle = null;
      this.saveFileHandle = null;
      this.fileHandle = null;
      this.writable = null;
      this.fileName = '';
      this.recording = false;
      this.enabled = false;
      this.partialLine = '';
      this.recentLines = [];
      this.afterLineCount = 0;
      this.finishing = false;
      this.keywordText = loadSavedKeywords(this.paneId);
      this.keywords = parseKeywords(this.keywordText);
      this.writeChain = Promise.resolve();
      this.flushTimer = null;

      this.onStateChange = null;
      this.onTriggered = null;
      this.onFinished = null;
      this.onError = null;
    }

    static isSupported() {
      return typeof window.showSaveFilePicker === 'function';
    }

    static defaultKeywords() {
      return DEFAULT_KEYWORDS;
    }

    static storedKeywords(paneId) {
      return loadSavedKeywords(paneId);
    }

    getKeywordText() {
      return this.keywordText;
    }

    setConsoleTitle(title) {
      this.consoleTitle = String(title || '').trim();
    }

    setKeywords(text) {
      this.keywordText = String(text || '');
      this.keywords = parseKeywords(this.keywordText);
      try {
        localStorage.setItem(keywordStorageKey(this.paneId), this.keywordText);
      } catch {
        // 저장 공간이 없어도 감시는 계속
      }
    }

    setEnabled(enabled) {
      this.enabled = Boolean(enabled);

      if (!this.enabled && this.recording && !this.finishing) {
        this.stopCaptureByUser();
        return;
      }

      this.notify();
    }

    isCapturing() {
      return this.recording && !this.finishing;
    }

    /**
     * 아래 200줄이 차지 않아도 지금껏 모은 내용만 저장하고 감시를 재개한다.
     */
    stopCaptureByUser() {
      if (!this.recording || this.finishing) {
        return;
      }

      this.finishing = true;

      if (this.partialLine) {
        this.enqueueWrite(this.partialLine + '\r\n');
        this.partialLine = '';
      }

      this.finishCapture('user-stop');
    }

    hasSaveTarget() {
      return this.saveFileHandle !== null || this.dirHandle !== null;
    }

    /**
     * 바탕화면처럼 Chrome 이 폴더 통째 접근을 막는 위치는
     * 파일 지정(showSaveFilePicker)으로 저장한다.
     */
    async pickSaveFile(suggestedName) {
      this.saveFileHandle = await window.showSaveFilePicker({
        suggestedName: suggestedName || 'aging-error.log',
        types: [
          {
            description: 'Log file',
            accept: { 'text/plain': ['.log', '.txt'] },
          },
        ],
      });
      this.dirHandle = null;
      this.notify();
    }

    async pickDirectory() {
      this.dirHandle = await window.showDirectoryPicker({
        id: 'aging-log',
        mode: 'readwrite',
      });
      this.saveFileHandle = null;
      this.notify();
    }

    /**
     * 새 장비 연결 때 이전 기록 파일을 닫고 줄 버퍼만 비운다.
     * 저장 폴더와 감시 on/off 는 그대로 둔다.
     */
    async resetSession() {
      await this.flushAndStop();
      this.recentLines = [];
      this.partialLine = '';
      this.notify();
    }

    async flushAndStop() {
      if (this.recording && this.partialLine) {
        this.enqueueWrite(this.partialLine + '\r\n');
        this.partialLine = '';
      }

      try {
        await this.writeChain;
      } catch {
        // 마지막 쓰기 실패는 stop 에서 정리
      }

      await this.stopRecording();
      this.finishing = false;
    }

    /**
     * 기록은 유지한 채 .crswap 을 .log 로만 확정한다.
     * 탭을 숨기거나 잠시 다른 창을 볼 때 사용한다.
     */
    commitNow() {
      if (!this.recording) {
        return;
      }

      this.writeChain = this.writeChain
        .then(() => this.commitToDisk())
        .catch((err) => {
          this.onError?.(err);
        });
    }

    /**
     * 시리얼 수신 텍스트를 줄 단위로 모아 감시한다.
     * 화면 출력과는 별개로 호출한다.
     */
    ingest(text) {
      if (!text) {
        return;
      }

      this.partialLine += text;
      const pieces = this.partialLine.split(/\r\n|\n/);
      this.partialLine = pieces.pop() ?? '';

      for (const line of pieces) {
        this.handleCompleteLine(line.replace(/\r/g, ''));
      }
    }

    getState() {
      if (!AgingLogWatcher.isSupported()) {
        return {
          kind: 'unsupported',
          text: '이 브라우저는 폴더 저장을 지원하지 않습니다. Chrome/Edge 를 사용하세요.',
        };
      }

      if (!this.hasSaveTarget()) {
        return { kind: 'no-folder', text: '저장 위치 없음' };
      }

      const targetName = this.saveTargetName();

      if (!this.enabled) {
        return { kind: 'idle', text: `저장: ${targetName} / 감시 끔` };
      }

      if (this.recording) {
        return {
          kind: 'recording',
          text: `기록 중 ${this.fileName}  (${this.afterLineCount}/${AFTER_LINE_LIMIT})`,
        };
      }

      return { kind: 'watching', text: `감시 중 ${targetName}` };
    }

    saveTargetName() {
      if (this.saveFileHandle) {
        return this.saveFileHandle.name;
      }
      if (this.dirHandle) {
        return this.dirHandle.name;
      }
      return '';
    }

    handleCompleteLine(line) {
      this.pushRecent(line);

      if (this.finishing) {
        return;
      }

      if (this.recording) {
        this.afterLineCount += 1;
        this.enqueueWrite(line + '\r\n');
        this.notify();

        if (this.afterLineCount >= AFTER_LINE_LIMIT) {
          this.finishing = true;
          this.finishCapture('complete');
        }
        return;
      }

      if (!this.enabled || !this.hasSaveTarget()) {
        return;
      }

      const hit = findKeyword(line, this.keywords);
      if (!hit) {
        return;
      }

      this.startRecording(hit, line);
    }

    startRecording(keyword, triggerLine) {
      this.recording = true;
      this.afterLineCount = 0;
      this.fileName = this.saveFileHandle
        ? this.saveFileHandle.name
        : makeFileName();
      this.notify();
      this.onTriggered?.(keyword, this.fileName, triggerLine, formatNow());

      // recentLines 마지막이 방금 감지된 줄이므로, 그 앞이 위 200줄이다.
      const beforeLines = this.recentLines.slice(0, -1);

      const headerLines = ['===log detected==='];
      if (this.consoleTitle) {
        headerLines.push('console : ' + this.consoleTitle);
      }
      headerLines.push(
        `time : ${formatNow()}`,
        triggerLine,
        `----- before ${beforeLines.length} lines -----`,
        ...beforeLines,
        `----- after ${AFTER_LINE_LIMIT} lines -----`,
        ''
      );
      const header = headerLines.join('\r\n');

      this.writeChain = this.writeChain
        .then(() => this.openWritable(false))
        .then(async (writable) => {
          this.writable = writable;
          await writable.write(header);

          // Chrome 은 close 전까지 .crswap 임시 파일만 만든다.
          // 헤더를 쓰자마자 확정해야 탐색기에 .log 가 바로 보인다.
          await this.commitToDisk();
        })
        .catch((err) => {
          this.recording = false;
          this.writable = null;
          if (!this.saveFileHandle) {
            this.fileHandle = null;
          }
          this.onError?.(err);
          this.notify();
        });
    }

    enqueueWrite(text) {
      this.writeChain = this.writeChain
        .then(async () => {
          if (!this.writable) {
            return;
          }
          await this.writable.write(text);
          this.scheduleFlush();
        })
        .catch((err) => {
          this.onError?.(err);
        });
    }

    /**
     * 열려 있는 쓰기를 닫아 .log 로 확정한다.
     * 기록은 이어서 해야 하므로 같은 파일을 다시 연다.
     */
    async commitToDisk() {
      if (!this.fileHandle) {
        return;
      }

      const writable = this.writable;
      this.writable = null;

      if (writable) {
        await writable.close();
      }

      if (!this.recording) {
        return;
      }

      this.writable = await this.openWritable(true);
    }

    scheduleFlush() {
      if (this.flushTimer || !this.recording) {
        return;
      }

      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.writeChain = this.writeChain
          .then(() => this.commitToDisk())
          .catch((err) => {
            this.onError?.(err);
          });
      }, FLUSH_INTERVAL_MS);
    }

    async openWritable(append) {
      if (this.saveFileHandle) {
        const ok = await ensureWritePermission(this.saveFileHandle);
        if (!ok) {
          throw new Error('로그 파일 쓰기 권한이 없습니다.');
        }

        this.fileHandle = this.saveFileHandle;
        return openAppendWritable(this.fileHandle);
      }

      if (!this.dirHandle) {
        throw new Error('저장 위치가 없습니다.');
      }

      const ok = await ensureWritePermission(this.dirHandle);
      if (!ok) {
        throw new Error('로그 폴더 쓰기 권한이 없습니다.');
      }

      this.fileHandle = await this.dirHandle.getFileHandle(this.fileName, {
        create: true,
      });

      if (!append) {
        return this.fileHandle.createWritable();
      }

      return openAppendWritable(this.fileHandle);
    }

    async stopRecording() {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }

      const writable = this.writable;
      this.writable = null;
      if (!this.saveFileHandle) {
        this.fileHandle = null;
      }
      this.recording = false;
      this.afterLineCount = 0;
      this.fileName = '';
      this.writeChain = Promise.resolve();

      if (writable) {
        try {
          await writable.close();
        } catch {
          // 이미 닫힌 파일
        }
      }

      this.notify();
    }

    /**
     * 아래 200줄을 다 모으면 파일을 닫고 다시 감시 상태로 돌아간다.
     * 이후에 키워드가 또 나오면 새 파일을 만든다.
     */
    finishCapture(reason) {
      const fileName = this.fileName;
      const afterCount = this.afterLineCount;

      this.writeChain = this.writeChain
        .then(() => this.stopRecording())
        .then(() => {
          this.finishing = false;
          this.onFinished?.(fileName, reason || 'complete', afterCount);
        })
        .catch((err) => {
          this.finishing = false;
          this.onError?.(err);
        });
    }

    pushRecent(line) {
      this.recentLines.push(line);
      if (this.recentLines.length > BEFORE_LINE_LIMIT + 1) {
        this.recentLines.shift();
      }
    }

    notify() {
      this.onStateChange?.(this.getState());
    }
  }

  function keywordStorageKey(paneId) {
    return KEYWORD_STORAGE_KEY + ':' + String(paneId || '1');
  }

  function loadSavedKeywords(paneId) {
    try {
      const keyed = localStorage.getItem(keywordStorageKey(paneId));
      if (keyed && keyed.trim()) {
        return keyed;
      }
      if (String(paneId || '1') === '1') {
        const legacy = localStorage.getItem(KEYWORD_STORAGE_KEY);
        if (legacy && legacy.trim()) {
          return legacy;
        }
      }
    } catch {
      // private mode 등
    }
    return DEFAULT_KEYWORDS;
  }

  function parseKeywords(text) {
    return String(text)
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function findKeyword(line, keywords) {
    const lower = line.toLowerCase();
    return keywords.find((key) => lower.includes(key.toLowerCase())) || null;
  }

  async function ensureWritePermission(handle) {
    const current = await handle.queryPermission({ mode: 'readwrite' });
    if (current === 'granted') {
      return true;
    }

    const next = await handle.requestPermission({ mode: 'readwrite' });
    return next === 'granted';
  }

  async function openAppendWritable(fileHandle) {
    const writable = await fileHandle.createWritable({
      keepExistingData: true,
    });
    const file = await fileHandle.getFile();
    await writable.seek(file.size);
    return writable;
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function makeFileName() {
    const now = new Date();
    const stamp =
      `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-` +
      `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
    return `aging-error-${stamp}.log`;
  }

  function formatNow() {
    const now = new Date();
    return (
      `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
      `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
    );
  }

  global.AgingLogWatcher = AgingLogWatcher;
})(window);
