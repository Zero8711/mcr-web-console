/**
 * 터미널 출력 보조.
 * 줄 단위로 로그 레벨 색을 입히고, 맨 아래가 아닐 때는 자동 스크롤을 멈춘다.
 */
(function (global) {
  const RESET = '\x1b[0m';

  const LEVELS = [
    {
      name: 'error',
      color: '\x1b[91m',
      pattern:
        /\b(error|errors|fatal|panic|critical|crit|alert|emerg|emergency|exception|oops|assert|watchdog|fail|failed|failure)\b/i,
    },
    {
      name: 'warn',
      color: '\x1b[93m',
      pattern: /\b(warn|warning|caution)\b/i,
    },
    {
      name: 'info',
      color: '\x1b[96m',
      pattern: /\b(info|notice|informational)\b/i,
    },
    {
      name: 'debug',
      color: '\x1b[90m',
      pattern: /\b(debug|dbg|trace|verbose)\b/i,
    },
  ];

  class TerminalLogView {
    constructor(term) {
      this.term = term;
      this.autoScroll = true;
      this.ignoreScroll = 0;
      this.lineBuf = '';
      this.partialShown = 0;
      this.onAutoScrollChange = null;
      this.viewport = null;

      this.syncUserScroll = () => {
        if (this.ignoreScroll > 0) {
          return;
        }
        this.setAutoScroll(this.isAtBottom());
      };

      term.onScroll(this.syncUserScroll);
      this.bindViewport();
      this.guardWrites();
    }

    bindViewport() {
      const vp = this.term.element && this.term.element.querySelector('.xterm-viewport');
      if (!vp) {
        window.setTimeout(() => this.bindViewport(), 50);
        return;
      }

      this.viewport = vp;
      vp.addEventListener(
        'wheel',
        (event) => {
          if (event.deltaY < 0) {
            this.setAutoScroll(false);
          }
          window.requestAnimationFrame(this.syncUserScroll);
        },
        { passive: true }
      );
      vp.addEventListener('scroll', this.syncUserScroll, { passive: true });
    }

    setAutoScroll(enabled) {
      const next = Boolean(enabled);
      if (this.autoScroll === next) {
        return;
      }
      this.autoScroll = next;
      this.onAutoScrollChange?.(next);
    }

    isAtBottom() {
      const vp = this.viewport;
      if (vp) {
        return vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 8;
      }
      const buf = this.term.buffer.active;
      return buf.viewportY >= buf.baseY;
    }

    resumeAutoScroll() {
      this.setAutoScroll(true);
      this.term.scrollToBottom();
    }

    /**
     * xterm write 가 화면을 맨 아래로 끌어내려도,
     * 사용자가 위로 올려 둔 위치는 그대로 둔다.
     */
    guardWrites() {
      const term = this.term;
      const originalWrite = term.write.bind(term);
      const view = this;

      term.write = function writeKeepingScroll(data, callback) {
        const follow = view.autoScroll;
        const vp = view.viewport;
        const savedTop = vp ? vp.scrollTop : term.buffer.active.viewportY;

        view.ignoreScroll += 1;
        return originalWrite(data, () => {
          try {
            if (follow) {
              term.scrollToBottom();
            } else if (vp) {
              vp.scrollTop = savedTop;
            }
          } finally {
            view.ignoreScroll = Math.max(0, view.ignoreScroll - 1);
            if (typeof callback === 'function') {
              callback();
            }
          }
        });
      };
    }

    /**
     * Tera Term CRReceive=LF 와 같게 받는다.
     * \n 만 다음 줄(CR+LF)로 바꾸고, \r 은 그 줄 맨 앞(덮어쓰기)만 한다.
     * \r 을 개행으로 보면 엔터·부팅 로그에 빈 줄이 생긴다.
     */
    writeIncoming(text) {
      if (!text) {
        return;
      }

      let output = '';

      for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (ch === '\n') {
          output += this.finishLine(this.lineBuf);
          this.lineBuf = '';
          continue;
        }

        if (ch === '\r') {
          output += this.paintPending(this.lineBuf);
          output += '\r';
          this.lineBuf = '';
          this.partialShown = 0;
          continue;
        }

        this.lineBuf += ch;
      }

      output += this.paintPending(this.lineBuf);

      if (output) {
        this.term.write(output);
      }
    }

    /**
     * 이미 화면에 있는 줄은 다시 그리지 않고, 남은 글자만 이어서 쓴 뒤 개행한다.
     */
    finishLine(rawLine) {
      const output = this.paintPending(rawLine);
      this.partialShown = 0;
      return output + '\r\n';
    }

    erasePaintedPartial() {
      if (this.partialShown <= 0) {
        return '';
      }
      this.partialShown = 0;
      return '\r\x1b[2K';
    }

    paintPending(pending) {
      if (!pending) {
        return '';
      }

      if (this.partialShown === 0) {
        this.partialShown = pending.length;
        return colorizeLine(pending);
      }

      if (pending.length > this.partialShown) {
        const extra = pending.slice(this.partialShown);
        this.partialShown = pending.length;
        return extra;
      }

      if (pending.length < this.partialShown) {
        const output = this.erasePaintedPartial() + colorizeLine(pending);
        this.partialShown = pending.length;
        return output;
      }

      return '';
    }
  }

  function colorizeLine(line) {
    if (!line || /\x1b\[/.test(line)) {
      return line;
    }

    for (const level of LEVELS) {
      if (level.pattern.test(line)) {
        return level.color + line + RESET;
      }
    }

    return line;
  }

  global.TerminalLogView = TerminalLogView;
})(window);
