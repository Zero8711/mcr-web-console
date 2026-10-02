/**
 * Tera Term 식 세션 로그.
 * [로그 저장] 부터 [중지] 까지 들어온 줄을 파일에 남긴다.
 * 각 줄 앞에 시각을 붙인다. 이상로그 감시와는 별개다.
 */
(function (global) {
  const FLUSH_INTERVAL_MS = 2000;

  class SessionLogRecorder {
    constructor() {
      this.fileHandle = null;
      this.writable = null;
      this.fileName = '';
      this.recording = false;
      this.partialLine = '';
      this.writeChain = Promise.resolve();
      this.flushTimer = null;
      this.onStateChange = null;
      this.onError = null;
    }

    static isSupported() {
      return typeof window.showSaveFilePicker === 'function';
    }

    get isRecording() {
      return this.recording;
    }

    async start(suggestedName, consoleTitle) {
      if (!SessionLogRecorder.isSupported()) {
        throw new Error('이 브라우저는 파일 저장을 지원하지 않습니다. Chrome/Edge 를 사용하세요.');
      }
      if (this.recording) {
        return;
      }

      const handle = await window.showSaveFilePicker({
        suggestedName: suggestedName || suggestedLogName('log'),
        types: [
          {
            description: 'Log file',
            accept: { 'text/plain': ['.log', '.txt'] },
          },
        ],
      });

      await this.stop();

      this.fileHandle = handle;
      this.fileName = handle.name;
      this.partialLine = '';
      this.recording = true;
      this.writeChain = Promise.resolve();

      const header =
        '=== log start ' + formatNow() + ' ===\r\n' +
        (consoleTitle ? 'console : ' + consoleTitle + '\r\n' : '');

      this.writeChain = this.writeChain
        .then(() => this.openWritable(false))
        .then(async (writable) => {
          this.writable = writable;
          await writable.write(header);
          await this.commitToDisk();
        })
        .catch((err) => {
          this.recording = false;
          this.writable = null;
          this.fileHandle = null;
          this.fileName = '';
          this.onError?.(err);
          this.notify();
        });

      this.notify();
      await this.writeChain;
    }

    ingest(text) {
      if (!this.recording || !text) {
        return;
      }

      this.partialLine += text;
      const pieces = this.partialLine.split(/\r\n|\n/);
      this.partialLine = pieces.pop() ?? '';

      let block = '';
      for (const piece of pieces) {
        const line = stripAnsi(piece.replace(/\r/g, ''));
        block += formatNow() + '  ' + line + '\r\n';
      }
      if (block) {
        this.enqueueWrite(block);
      }
    }

    async stop() {
      if (!this.recording && !this.writable) {
        return this.fileName;
      }

      if (this.partialLine) {
        const leftover = stripAnsi(this.partialLine.replace(/\r/g, ''));
        this.partialLine = '';
        this.enqueueWrite(formatNow() + '  ' + leftover + '\r\n');
      }

      this.enqueueWrite('=== log stop ' + formatNow() + ' ===\r\n');

      const savedName = this.fileName;
      this.recording = false;

      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }

      try {
        await this.writeChain;
      } catch {
        // 마지막 쓰기는 close 에서 정리
      }

      const writable = this.writable;
      this.writable = null;
      this.fileHandle = null;
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
      return savedName;
    }

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
      const ok = await ensureWritePermission(this.fileHandle);
      if (!ok) {
        throw new Error('로그 파일 쓰기 권한이 없습니다.');
      }
      if (!append) {
        return this.fileHandle.createWritable();
      }
      return openAppendWritable(this.fileHandle);
    }

    notify() {
      this.onStateChange?.(this.isRecording, this.fileName);
    }
  }

  function stripAnsi(text) {
    return String(text || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatNow() {
    const now = new Date();
    return (
      now.getFullYear() +
      '-' +
      pad2(now.getMonth() + 1) +
      '-' +
      pad2(now.getDate()) +
      ' ' +
      pad2(now.getHours()) +
      ':' +
      pad2(now.getMinutes()) +
      ':' +
      pad2(now.getSeconds())
    );
  }

  function suggestedLogName(title) {
    const safe = String(title || 'log')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .slice(0, 20) || 'log';
    const now = new Date();
    const stamp =
      now.getFullYear() +
      pad2(now.getMonth() + 1) +
      pad2(now.getDate()) +
      '-' +
      pad2(now.getHours()) +
      pad2(now.getMinutes()) +
      pad2(now.getSeconds());
    return safe + '-' + stamp + '.log';
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

  global.SessionLogRecorder = SessionLogRecorder;
  global.suggestedLogName = suggestedLogName;
})(window);
