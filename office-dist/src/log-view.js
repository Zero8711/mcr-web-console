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
     * 장비에서 온 텍스트를 줄 단위로 색을 입혀 출력한다.
     * Tera Term 과 같이 \r 은 같은 줄을 덮고, \n 이 와야 다음 줄로 간다.
     * UBI/mdev 진행 로그는 \r 만 반복하므로, \n 기준으로 자르면 빈 줄과 찌꺼기가 생긴다.
     */
    writeIncoming(text) {
      if (!text) {
        return;
      }

      this.lineBuf += text;
      let output = '';

      while (true) {
        const crAt = this.lineBuf.indexOf('\r');
        const lfAt = this.lineBuf.indexOf('\n');
        if (crAt < 0 && lfAt < 0) {
          break;
        }

        if (lfAt >= 0 && (crAt < 0 || lfAt < crAt)) {
          const rawLine = this.lineBuf.slice(0, lfAt);
          this.lineBuf = this.lineBuf.slice(lfAt + 1);
          output += this.finishLine(rawLine);
          continue;
        }

        if (crAt >= 0 && lfAt === crAt + 1) {
          const rawLine = this.lineBuf.slice(0, crAt);
          this.lineBuf = this.lineBuf.slice(lfAt + 1);
          output += this.finishLine(rawLine);
          continue;
        }

        this.lineBuf = this.lineBuf.slice(crAt + 1);
        output += this.erasePaintedPartial();
      }

      output += this.paintPending(this.lineBuf);

      if (output) {
        this.term.write(output);
      }
    }

    finishLine(rawLine) {
      let output = this.erasePaintedPartial();
      output += colorizeLine(rawLine) + '\r\n';
      return output;
    }

    /**
     * 이미 그려 둔 미완성 줄을 지운다.
     * 칸이 좁아 줄이 접혀 있으면 \r 만으로는 윗줄 찌꺼기가 남는다.
     */
    erasePaintedPartial() {
      if (this.partialShown <= 0) {
        return '';
      }

      const cols = this.term.cols || 80;
      const rows = Math.max(1, Math.ceil(this.partialShown / cols));
      let output = '\r\x1b[2K';
      for (let i = 1; i < rows; i++) {
        output += '\x1b[A\r\x1b[2K';
      }
      this.partialShown = 0;
      return output;
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
