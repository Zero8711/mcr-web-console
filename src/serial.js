/**
 * Web Serial API 래퍼.
 * 포트 open/close, 읽기 루프, 쓰기만 담당한다. UI는 콜백으로 받는다.
 */
(function (global) {
  class SerialConnection {
    constructor() {
      this.port = null;
      this.reader = null;
      this.writer = null;
      this.keepReading = false;
      this.readLoopPromise = null;
      this.decoder = null;

      this.onData = null;
      this.onDisconnect = null;
      this.onError = null;

      this._onPortDisconnect = () => {
        this.onDisconnect?.();
      };
    }

    static isSupported() {
      return 'serial' in navigator;
    }

    get isOpen() {
      return this.port !== null && this.writer !== null;
    }

    getPort() {
      return this.port;
    }

    async requestPort() {
      return navigator.serial.requestPort();
    }

    /**
     * @param {SerialPort} port
     * @param {{
     *   baudRate: number,
     *   dataBits: number,
     *   stopBits: number,
     *   parity: 'none' | 'even' | 'odd',
     * }} options
     */
    async open(port, options) {
      await this.close();

      // Windows FTDI 는 직전 close 직후 바로 open 하면
      // Failed to open serial port 가 나는 경우가 있다.
      await openPortWithRetry(port, {
        baudRate: options.baudRate,
        dataBits: options.dataBits,
        stopBits: options.stopBits,
        parity: options.parity,
        flowControl: 'none',
        bufferSize: 8192,
      });

      this.port = port;
      this.port.addEventListener('disconnect', this._onPortDisconnect);

      if (!this.port.writable) {
        throw new Error('시리얼 포트를 열었지만 쓰기를 사용할 수 없습니다.');
      }

      this.writer = this.port.writable.getWriter();

      // 스위치/AP USB 콘솔(FTDI)은 DTR/RTS 가 있어야 응답하는 경우가 많다.
      // Tera Term 은 기본으로 켜 두고, Web Serial 은 직접 켜야 한다.
      try {
        await this.port.setSignals({
          dataTerminalReady: true,
          requestToSend: true,
        });
      } catch {
        // 제어 신호를 지원하지 않는 변환기는 무시
      }

      this.decoder = new TextDecoder('utf-8', { fatal: false });
      this.keepReading = true;
      this.readLoopPromise = this._readLoop();
    }

    async write(text) {
      if (!this.writer) {
        throw new Error('시리얼 포트가 열려 있지 않습니다.');
      }

      const bytes = new TextEncoder().encode(text);
      await this.writer.write(bytes);
    }

    async close() {
      this.keepReading = false;

      if (this.reader) {
        try {
          await this.reader.cancel();
        } catch {
          // 이미 닫힌 reader 는 무시
        }
      }

      if (this.readLoopPromise) {
        try {
          await this.readLoopPromise;
        } catch {
          // 읽기 루프 종료 오류는 무시
        }
        this.readLoopPromise = null;
      }

      if (this.writer) {
        try {
          this.writer.releaseLock();
        } catch {
          // writer lock 이 이미 풀린 경우
        }
        this.writer = null;
      }

      if (this.port) {
        this.port.removeEventListener('disconnect', this._onPortDisconnect);
        try {
          await this.port.close();
        } catch {
          // 케이블 제거 등으로 이미 닫힌 경우
        }
        this.port = null;
      }

      this.decoder = null;
    }

    getPortLabel() {
      if (!this.port) {
        return '';
      }

      const info = this.port.getInfo();
      if (info.usbVendorId != null) {
        const vid = toHex4(info.usbVendorId);
        const pid = toHex4(info.usbProductId ?? 0);
        return `USB ${vid}:${pid}`;
      }

      return 'Serial Port';
    }

    async _readLoop() {
      while (this.port?.readable && this.keepReading) {
        this.reader = this.port.readable.getReader();

        try {
          while (true) {
            const { value, done } = await this.reader.read();
            if (done) {
              break;
            }
            if (!value || value.length === 0) {
              continue;
            }

            const text = this._decodeChunk(value);
            if (text) {
              this.onData?.(text);
            }
          }
        } catch (err) {
          if (this.keepReading) {
            this.onError?.(err);
          }
          break;
        } finally {
          try {
            this.reader.releaseLock();
          } catch {
            // already released
          }
          this.reader = null;
        }
      }
    }

    /**
     * UTF-8 스트림으로 디코드한다.
     * 패킷 경계에 잘린 한글은 TextDecoder 가 버퍼링했다가 다음 청크에서 이어 붙인다.
     */
    _decodeChunk(bytes) {
      return this.decoder.decode(bytes, { stream: true });
    }
  }

  function toHex4(value) {
    return value.toString(16).toUpperCase().padStart(4, '0');
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * Windows 에서 포트 핸들이 늦게 풀리면 한두 번 재시도한다.
   * 이미 열린 포트(InvalidStateError)는 재시도하지 않는다.
   */
  async function openPortWithRetry(port, openOptions) {
    const waitMs = [0, 250, 500];
    let lastError = null;

    for (const delay of waitMs) {
      if (delay > 0) {
        await sleep(delay);
      }

      try {
        await port.open(openOptions);
        return;
      } catch (err) {
        lastError = err;

        if (err?.name === 'InvalidStateError') {
          throw err;
        }

        try {
          if (port.readable || port.writable) {
            await port.close();
          }
        } catch {
          // 재시도를 위해 닫기 실패는 무시
        }
      }
    }

    throw lastError;
  }

  global.SerialConnection = SerialConnection;
})(window);
