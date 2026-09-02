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
     * 완성되지 않은 마지막 줄은 그대로 보여 주고, 개행이 오면 색을 다시 입힌다.
     *
     * Linux 콘솔은 Enter 에 \r\n 을 보낸다. 끝의 \r 은 줄바꿈의 일부이지
     * 줄을 비우라는 뜻이 아니다. 잘못 자르면 프롬프트가 지워지고 빈 줄만 남는다.
     */
    writeIncoming(text) {
      if (!text) {
        return;
      }

      this.lineBuf += text;
      let output = '';

      while (true) {
        const breakAt = this.lineBuf.indexOf('\n');
        if (breakAt < 0) {
          break;
        }

        const rawLine = this.lineBuf.slice(0, breakAt);
        this.lineBuf = this.lineBuf.slice(breakAt + 1);
        const line = commitLineText(rawLine);

        if (this.partialShown > 0) {
          output += '\r\x1b[2K';
          this.partialShown = 0;
        }

        output += colorizeLine(line) + '\r\n';
      }

      const pending = holdTrailingCr(this.lineBuf);
      if (pending.length > this.partialShown) {
        output += pending.slice(this.partialShown);
        this.partialShown = pending.length;
      } else if (pending.length < this.partialShown) {
        this.partialShown = pending.length;
      }

      if (output) {
        this.term.write(output);
      }
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

  /**
   * \r\n 의 CR 은 떼고, 줄 가운데 \r 만 덮어쓰기로 본다.
   */
  function commitLineText(rawLine) {
    const withoutCrlf = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const lastCr = withoutCrlf.lastIndexOf('\r');
    if (lastCr < 0) {
      return withoutCrlf;
    }
    return withoutCrlf.slice(lastCr + 1);
  }

  /**
   * 다음에 \n 이 올지 모르므로 끝의 \r 은 아직 화면에 내지 않는다.
   */
  function holdTrailingCr(text) {
    if (text.endsWith('\r')) {
      return text.slice(0, -1);
    }
    return text;
  }

  global.TerminalLogView = TerminalLogView;
})(window);
