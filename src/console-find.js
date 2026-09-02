/**
 * 선택한 콘솔 칸에서 로그를 찾는다.
 * Ctrl+F 로 열고, Enter / F3 다음, Shift+Enter / Shift+F3 이전, Esc 닫기.
 */
(function (global) {
  class ConsoleFind {
    constructor(term) {
      this.term = term;
      this.matches = [];
      this.index = -1;
      this.query = '';

      this.root = document.createElement('div');
      this.root.className = 'console-find';
      this.root.hidden = true;

      this.input = document.createElement('input');
      this.input.type = 'text';
      this.input.className = 'console-find-input';
      this.input.spellcheck = false;
      this.input.placeholder = '찾을 내용';
      this.input.title = 'Ctrl+F 로 찾기. Enter 다음, Shift+Enter 이전, Esc 닫기';

      this.prevBtn = document.createElement('button');
      this.prevBtn.type = 'button';
      this.prevBtn.className = 'btn console-find-btn';
      this.prevBtn.textContent = '이전';

      this.nextBtn = document.createElement('button');
      this.nextBtn.type = 'button';
      this.nextBtn.className = 'btn console-find-btn';
      this.nextBtn.textContent = '다음';

      this.countEl = document.createElement('span');
      this.countEl.className = 'console-find-count';
      this.countEl.textContent = '';

      this.closeBtn = document.createElement('button');
      this.closeBtn.type = 'button';
      this.closeBtn.className = 'btn console-find-btn';
      this.closeBtn.textContent = '닫기';

      this.root.appendChild(this.input);
      this.root.appendChild(this.prevBtn);
      this.root.appendChild(this.nextBtn);
      this.root.appendChild(this.countEl);
      this.root.appendChild(this.closeBtn);

      this.input.addEventListener('input', () => {
        this.search(this.input.value);
      });
      this.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) {
            this.prev();
          } else {
            this.next();
          }
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          this.close();
        }
      });
      this.prevBtn.addEventListener('click', () => this.prev());
      this.nextBtn.addEventListener('click', () => this.next());
      this.closeBtn.addEventListener('click', () => this.close());
    }

    get isOpen() {
      return !this.root.hidden;
    }

    open() {
      this.root.hidden = false;
      this.input.focus();
      this.input.select();
      if (this.input.value.trim()) {
        this.search(this.input.value, { keepIndex: true });
      }
    }

    close() {
      this.root.hidden = true;
      this.clearMatches();
      this.term.focus();
    }

    search(text, options) {
      const query = String(text || '');
      const keepIndex = Boolean(options?.keepIndex);
      const prevRow = keepIndex ? this.matches[this.index]?.row : -1;
      const prevCol = keepIndex ? this.matches[this.index]?.col : -1;

      this.query = query;
      this.matches = collectMatches(this.term, query);

      if (!this.matches.length) {
        this.index = -1;
        this.term.clearSelection();
        this.countEl.textContent = query.trim() ? '없음' : '';
        this.countEl.classList.toggle('miss', Boolean(query.trim()));
        return;
      }

      this.index = 0;
      if (keepIndex && prevRow >= 0) {
        const found = this.matches.findIndex((item) => item.row > prevRow || (item.row === prevRow && item.col >= prevCol));
        this.index = found >= 0 ? found : 0;
      }

      this.countEl.classList.remove('miss');
      this.reveal();
    }

    next() {
      if (!this.query.trim()) {
        this.search(this.input.value);
        return;
      }
      if (!this.matches.length) {
        this.search(this.query);
        return;
      }
      this.index = (this.index + 1) % this.matches.length;
      this.reveal();
    }

    prev() {
      if (!this.query.trim()) {
        this.search(this.input.value);
        return;
      }
      if (!this.matches.length) {
        this.search(this.query);
        return;
      }
      this.index = (this.index - 1 + this.matches.length) % this.matches.length;
      this.reveal();
    }

    reveal() {
      const hit = this.matches[this.index];
      if (!hit) {
        this.term.clearSelection();
        return;
      }

      this.countEl.textContent = this.index + 1 + ' / ' + this.matches.length;
      this.term.scrollToLine(hit.row);
      this.term.select(hit.col, hit.row, hit.len);
    }

    clearMatches() {
      this.matches = [];
      this.index = -1;
      this.countEl.textContent = '';
      this.countEl.classList.remove('miss');
      this.term.clearSelection();
    }
  }

  function collectMatches(term, text) {
    const needle = String(text || '').toLowerCase();
    const list = [];
    if (!needle) {
      return list;
    }

    const buf = term.buffer.active;
    const height = buf.length;
    for (let row = 0; row < height; row += 1) {
      const line = buf.getLine(row);
      if (!line) {
        continue;
      }
      const raw = line.translateToString(true);
      const lower = raw.toLowerCase();
      let from = 0;
      while (from < lower.length) {
        const at = lower.indexOf(needle, from);
        if (at < 0) {
          break;
        }
        list.push({ row, col: at, len: needle.length });
        from = at + needle.length;
      }
    }
    return list;
  }

  function isFindShortcut(event) {
    if (event.type !== 'keydown') {
      return false;
    }
    if (event.altKey) {
      return false;
    }
    return (event.ctrlKey || event.metaKey) && event.code === 'KeyF';
  }

  global.ConsoleFind = ConsoleFind;
  global.isFindShortcut = isFindShortcut;
})(window);
