/**
 * 한 COM(또는 원격으로 보는 한 장비)의 터미널 칸.
 * 시험팀은 serial 을 열고, 개발팀은 로그만 받는다.
 */
(function (global) {
  const TERM_OPTIONS = {
    cursorBlink: true,
    fontFamily: 'Consolas, "Courier New", monospace',
    fontSize: 14,
    theme: {
      background: '#000000',
      foreground: '#d8d8d8',
      cursor: '#d8d8d8',
      selectionBackground: '#3a5f8a',
    },
    scrollback: 5000,
    rightClickSelectsWord: false,
  };

  class ConsolePane {
    constructor(options) {
      this.id = String(options.id || '1');
      this.title = options.title || ('장비 ' + this.id);
      this.mode = options.mode === 'guest' ? 'guest' : 'host';
      this.hooks = options.hooks || {};

      this.serial = this.mode === 'host' ? new SerialConnection() : null;
      this.agingLog =
        this.mode === 'host'
          ? new AgingLogWatcher({ paneId: this.id, consoleTitle: this.title })
          : null;
      this.sessionLog = new SessionLogRecorder();
      this.typedLines = new ShareUtil.TypedLineBuffer();

      this.root = document.createElement('section');
      this.root.className = 'console-pane';
      this.root.dataset.slot = this.id;

      this.bar = document.createElement('div');
      this.bar.className = 'console-pane-bar';

      this.titleInput = document.createElement('input');
      this.titleInput.type = 'text';
      this.titleInput.className = 'console-pane-title';
      this.titleInput.maxLength = 20;
      this.titleInput.spellcheck = false;
      this.titleInput.value = this.title;
      this.titleInput.title = '이 장비 이름. 공유 화면에 그대로 보입니다.';

      this.statusEl = document.createElement('span');
      this.statusEl.className = 'console-pane-status';
      this.statusEl.textContent = this.mode === 'host' ? '연결 안 됨' : '대기';

      this.bar.appendChild(this.titleInput);

      this.findBtn = document.createElement('button');
      this.findBtn.type = 'button';
      this.findBtn.className = 'btn console-pane-find-btn';
      this.findBtn.textContent = '찾기';
      this.findBtn.title = 'Ctrl+F';

      this.logStartBtn = document.createElement('button');
      this.logStartBtn.type = 'button';
      this.logStartBtn.className = 'btn console-pane-log-btn';
      this.logStartBtn.textContent = '로그 저장';
      this.logStartBtn.title = '이 시점부터 이 칸 로그를 파일로 저장합니다.';

      this.logStopBtn = document.createElement('button');
      this.logStopBtn.type = 'button';
      this.logStopBtn.className = 'btn console-pane-log-btn';
      this.logStopBtn.textContent = '중지';
      this.logStopBtn.title = '로그 저장을 끝내고 파일을 확정합니다.';
      this.logStopBtn.disabled = true;

      this.bar.appendChild(this.statusEl);
      this.bar.appendChild(this.findBtn);
      this.bar.appendChild(this.logStartBtn);
      this.bar.appendChild(this.logStopBtn);
      this.root.appendChild(this.bar);

      this.termEl = document.createElement('div');
      this.termEl.className = 'terminal';
      this.root.appendChild(this.termEl);

      options.container.appendChild(this.root);

      this.term = new global.Terminal(TERM_OPTIONS);
      this.fitAddon = new global.FitAddon.FitAddon();
      this.term.loadAddon(this.fitAddon);
      this.term.open(this.termEl);
      this.logView = new TerminalLogView(this.term);
      this.find = new ConsoleFind(this.term);
      this.root.insertBefore(this.find.root, this.termEl);

      this.bind();
      this.fit();
    }

    get isOpen() {
      return Boolean(this.serial && this.serial.isOpen);
    }

    setSelected(yes) {
      this.root.classList.toggle('selected', yes);
    }

    isBarField(el) {
      return el === this.titleInput || el === this.find?.input;
    }

    openFind() {
      this.find.open();
    }

    findNext() {
      if (!this.find.isOpen) {
        this.find.open();
        return;
      }
      this.find.next();
    }

    findPrev() {
      if (!this.find.isOpen) {
        this.find.open();
        return;
      }
      this.find.prev();
    }

    syncLogButtons() {
      const supported = SessionLogRecorder.isSupported();
      const rec = this.sessionLog.isRecording;
      this.logStartBtn.disabled = !supported || rec;
      this.logStopBtn.disabled = !rec;
      this.logStartBtn.classList.toggle('recording', rec);
      this.logStartBtn.textContent = rec ? '기록 중' : '로그 저장';
    }

    async startSessionLog() {
      await this.sessionLog.start(suggestedLogName(this.title), this.title);
      if (!this.sessionLog.isRecording) {
        return;
      }
      this.term.writeln('');
      this.term.writeln(
        `\x1b[32m[로그] ${this.sessionLog.fileName} 에 이 시점부터 저장합니다. [중지] 를 누르면 파일을 닫습니다.\x1b[0m`
      );
    }

    async stopSessionLog() {
      const name = await this.sessionLog.stop();
      if (!name) {
        return;
      }
      this.term.writeln('');
      this.term.writeln(`\x1b[32m[로그] ${name} 저장을 마쳤습니다.\x1b[0m`);
    }

    fit() {
      try {
        this.fitAddon.fit();
      } catch {
        // 칸 크기가 아직 안 잡힌 경우는 다음 resize 에서 맞춘다
      }
    }

    focus() {
      this.term.focus();
    }

    clear() {
      this.term.clear();
      this.logView.resumeAutoScroll();
      this.focus();
    }

    setTitle(title) {
      const next = String(title || '').replace(/[\t\n\r]/g, '').trim() || ('장비 ' + this.id);
      this.title = next;
      this.agingLog?.setConsoleTitle(next);
      if (document.activeElement === this.titleInput) {
        return;
      }
      if (this.titleInput.value !== next) {
        this.titleInput.value = next;
      }
    }

    setStatus(text) {
      this.statusEl.textContent = text || '';
    }

    writeIncoming(text) {
      this.logView.writeIncoming(text);
      this.sessionLog.ingest(text);
    }

    copySelection() {
      const text = this.term.getSelection();
      if (!text) {
        return;
      }
      copyToClipboard(text);
    }

    bind() {
      this.root.addEventListener('mousedown', (event) => {
        this.hooks.onSelect?.(this, { keepFocus: this.isBarField(event.target) });
      });
      this.root.addEventListener('focusin', (event) => {
        this.hooks.onSelect?.(this, { keepFocus: this.isBarField(event.target) });
      });

      this.titleInput.addEventListener('change', () => {
        this.setTitle(this.titleInput.value);
        this.hooks.onMetaChange?.(this);
      });

      this.titleInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') {
          return;
        }
        event.preventDefault();
        this.titleInput.blur();
        this.focus();
      });

      this.findBtn.addEventListener('click', () => {
        this.hooks.onSelect?.(this, { keepFocus: true });
        this.openFind();
      });

      this.logStartBtn.addEventListener('click', () => {
        this.startSessionLog().catch((err) => {
          if (isUserCancelError(err)) {
            return;
          }
          this.term.writeln(`\x1b[31m[로그 저장 실패] ${err.message}\x1b[0m`);
        });
      });

      this.logStopBtn.addEventListener('click', () => {
        this.stopSessionLog().catch((err) => {
          this.term.writeln(`\x1b[31m[로그 중지 실패] ${err.message}\x1b[0m`);
        });
      });

      this.sessionLog.onError = (err) => {
        this.term.writeln('');
        this.term.writeln(`\x1b[31m[로그 저장 실패] ${err.message}\x1b[0m`);
        this.syncLogButtons();
      };
      this.sessionLog.onStateChange = () => {
        this.syncLogButtons();
      };
      this.syncLogButtons();

      this.term.attachCustomKeyEventHandler((event) => {
        if (global.isFindShortcut?.(event)) {
          event.preventDefault();
          this.openFind();
          return false;
        }
        if (event.key === 'F3') {
          event.preventDefault();
          if (event.shiftKey) {
            this.findPrev();
          } else {
            this.findNext();
          }
          return false;
        }
        if (event.key === 'Escape' && this.find.isOpen) {
          event.preventDefault();
          this.find.close();
          return false;
        }
        if (!this.hooks.isPasteShortcut?.(event)) {
          return true;
        }
        event.preventDefault();
        this.hooks.onPaste?.(this);
        return false;
      });

      this.pendingCopy = false;
      this.termEl.addEventListener('mousedown', (event) => {
        if (event.button !== 0) {
          return;
        }
        this.pendingCopy = true;
      });

      this.onWindowMouseUp = () => {
        if (!this.pendingCopy) {
          return;
        }
        this.pendingCopy = false;
        window.setTimeout(() => {
          this.copySelection();
        }, 0);
      };
      window.addEventListener('mouseup', this.onWindowMouseUp);

      this.termEl.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.hooks.onSelect?.(this);
        this.hooks.onPaste?.(this);
      });

      this.resizeObserver = new ResizeObserver(() => {
        this.fit();
      });
      this.resizeObserver.observe(this.termEl);

      if (this.mode === 'guest') {
        this.term.onData((data) => {
          this.hooks.onGuestKeys?.(this, data);
        });
        return;
      }

      this.serial.onData = (text) => {
        this.writeIncoming(text);
        this.agingLog.ingest(text);
        this.hooks.onShareLog?.(this, text);
      };

      this.serial.onError = (err) => {
        this.term.writeln('');
        this.term.writeln(`\x1b[31m[시리얼 오류] ${err.message}\x1b[0m`);
      };

      this.serial.onDisconnect = () => {
        this.hooks.onPortGone?.(this);
      };

      this.term.onData((data) => {
        if (!this.isOpen) {
          return;
        }
        this.writeRaw(data);
        this.collectTyped(data);
      });

      this.bindAging();
    }

    bindAging() {
      if (!this.agingLog) {
        return;
      }

      this.agingLog.onStateChange = (state) => {
        this.hooks.onAgingState?.(this, state);
      };
      this.agingLog.onTriggered = (keyword, fileName, triggerLine, timeText) => {
        this.term.writeln('');
        this.term.writeln(
          `\x1b[33m[이상로그] '${keyword}' 감지. ${fileName} 에 위 200줄·아래 200줄을 저장합니다.\x1b[0m`
        );
        this.hooks.onAgingTriggered?.(this, keyword, fileName, triggerLine, timeText);
      };
      this.agingLog.onFinished = (fileName, reason, afterCount) => {
        this.term.writeln('');
        if (reason === 'user-stop') {
          this.term.writeln(
            `\x1b[33m[이상로그] 수집을 중단했습니다. ${fileName} 에 아래 ${afterCount}줄을 저장했습니다.\x1b[0m`
          );
          return;
        }
        this.term.writeln(`\x1b[32m[이상로그] ${fileName} 저장을 마쳤습니다. 다시 감시합니다.\x1b[0m`);
      };
      this.agingLog.onError = (err) => {
        this.term.writeln('');
        this.term.writeln(`\x1b[31m[이상로그 저장 실패] ${err.message}\x1b[0m`);
      };
    }

    writeRaw(data) {
      const applyNewline = this.hooks.applyNewline;
      const payload = applyNewline(data, this.hooks.getNewline());
      if (this.hooks.getEcho()) {
        this.hooks.echoLocal(this, payload);
      }
      this.serial.write(payload).catch((err) => {
        this.term.writeln(`\x1b[31m[송신 실패] ${err.message}\x1b[0m`);
      });
    }

    writeLine(text) {
      this.writeRaw(`${text}\n`);
      this.agingLog?.ingest(this.hooks.applyNewline(`${text}\n`, this.hooks.getNewline()));
    }

    writeKeys(text) {
      if (!text || !this.isOpen) {
        return;
      }
      const payload = this.hooks.applyNewline(text, this.hooks.getNewline());
      this.serial.write(payload).catch((err) => {
        this.term.writeln(`\x1b[31m[원격 송신 실패] ${err.message}\x1b[0m`);
      });
      this.agingLog?.ingest(payload);
    }

    collectTyped(chunk) {
      const lines = this.typedLines.push(chunk);
      for (const line of lines) {
        this.agingLog?.ingest(`${line}\n`);
        this.hooks.onShareCmdLog?.(this, line);
      }
    }

    async connect() {
      const port = await this.serial.requestPort();
      await this.agingLog.resetSession();
      await this.serial.open(port, this.hooks.getSerialOptions());
      this.setStatus(this.portLabel());
      this.term.writeln('');
      this.term.writeln(`\x1b[32m[연결됨] ${this.portLabel()}\x1b[0m`);
      if (this.agingLog.enabled && this.agingLog.hasSaveTarget()) {
        this.term.writeln(
          '\x1b[33m[이상로그] 키워드가 나오면 위 200줄·아래 200줄을 파일로 저장합니다. 이 페이지를 닫지 마세요.\x1b[0m'
        );
      }
      this.focus();
      this.hooks.onOpenChange?.(this);
    }

    async disconnect() {
      if (this.agingLog) {
        await this.agingLog.flushAndStop();
      }
      if (this.serial) {
        await this.serial.close();
      }
      this.setStatus('연결 안 됨');
      this.term.writeln('');
      this.term.writeln('\x1b[33m[연결 해제]\x1b[0m');
      this.hooks.onOpenChange?.(this);
    }

    async reconnect() {
      const port = this.serial.getPort();
      if (!port) {
        return;
      }
      await this.serial.close();
      await this.serial.open(port, this.hooks.getSerialOptions());
      this.setStatus(this.portLabel());
      this.term.writeln('');
      this.term.writeln(`\x1b[32m[설정 변경 후 재연결] ${this.portLabel()}\x1b[0m`);
      this.hooks.onOpenChange?.(this);
    }

    async handleUnplug(reason) {
      try {
        await this.agingLog?.flushAndStop();
      } catch {
        // 파일 정리는 연결 해제와 별개
      }
      try {
        await this.serial?.close();
      } catch {
        // already closed
      }
      this.setStatus('연결 안 됨');
      this.term.writeln('');
      this.term.writeln(`\x1b[33m[${reason}]\x1b[0m`);
      this.hooks.onOpenChange?.(this);
    }

    portLabel() {
      const opt = this.hooks.getSerialOptions();
      const parityShort = opt.parity === 'none' ? 'N' : opt.parity === 'even' ? 'E' : 'O';
      const portName = this.serial ? this.serial.getPortLabel() : this.title;
      return `${portName}  ${opt.baudRate} ${opt.dataBits}${parityShort}${opt.stopBits}`;
    }

    destroy() {
      try {
        this.sessionLog?.stop();
      } catch {
        // ignore
      }
      try {
        window.removeEventListener('mouseup', this.onWindowMouseUp);
      } catch {
        // ignore
      }
      try {
        this.resizeObserver?.disconnect();
      } catch {
        // ignore
      }
      try {
        this.term.dispose();
      } catch {
        // ignore
      }
      if (this.root.parentNode) {
        this.root.parentNode.removeChild(this.root);
      }
    }
  }

  function isUserCancelError(err) {
    return err?.name === 'NotFoundError' || err?.name === 'AbortError';
  }

  function copyToClipboard(text) {
    const value = String(text || '');
    if (!value) {
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).catch(() => {
        copyToClipboardFallback(value);
      });
      return;
    }
    copyToClipboardFallback(value);
  }

  function copyToClipboardFallback(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
    } catch {
      // 다음 선택에서 다시 시도한다
    }
    document.body.removeChild(area);
  }

  global.ConsolePane = ConsolePane;
})(window);
