/**
 * 시리얼 수신을 화면과 같은 줄로 만든다.
 * CR 은 줄 앞, Backspace 는 한 칸 뒤, ESC[K / ESC[J 는 커서 뒤를 지운다.
 * 색·히스토리용 ANSI 는 파일에 남기지 않는다.
 */
(function (global) {
  function createTermLineState() {
    return {
      cells: [],
      col: 0,
      pending: '',
    };
  }

  function currentTermLine(state) {
    if (!state || !state.cells || !state.cells.length) {
      return '';
    }
    return state.cells.join('').replace(/[ \t]+$/g, '');
  }

  function flattenTerminalChunk(text, state) {
    const lineState = state || createTermLineState();
    const raw = String(lineState.pending || '') + String(text || '');
    lineState.pending = '';

    const lines = [];
    let index = 0;

    while (index < raw.length) {
      if (isIncompleteEscape(raw, index)) {
        lineState.pending = raw.slice(index);
        break;
      }

      const ch = raw.charAt(index);
      const code = raw.charCodeAt(index);

      if (ch === '\n') {
        finishLine(lineState, lines);
        index += 1;
        continue;
      }

      if (ch === '\r') {
        if (raw.charAt(index + 1) === '\n') {
          finishLine(lineState, lines);
          index += 2;
          continue;
        }
        lineState.col = 0;
        index += 1;
        continue;
      }

      if (ch === '\b' || code === 0x7f) {
        if (lineState.col > 0) {
          lineState.col -= 1;
        }
        index += 1;
        continue;
      }

      if (ch === '\x1b') {
        index = applyEscape(raw, index, lineState);
        continue;
      }

      if (ch === '\t') {
        writeChar(lineState, '\t');
        index += 1;
        continue;
      }

      if (code < 32) {
        index += 1;
        continue;
      }

      writeChar(lineState, ch);
      index += 1;
    }

    return {
      lines: lines,
      state: lineState,
    };
  }

  function writeChar(state, ch) {
    while (state.cells.length < state.col) {
      state.cells.push(' ');
    }
    if (state.col < state.cells.length) {
      state.cells[state.col] = ch;
    } else {
      state.cells.push(ch);
    }
    state.col += 1;
  }

  function finishLine(state, lines) {
    lines.push(currentTermLine(state));
    state.cells = [];
    state.col = 0;
  }

  function eraseToEnd(state) {
    if (state.col < state.cells.length) {
      state.cells.length = state.col;
    }
  }

  function eraseToStart(state) {
    for (let i = 0; i < state.col && i < state.cells.length; i += 1) {
      state.cells[i] = ' ';
    }
  }

  function eraseLine(state) {
    state.cells = [];
    state.col = 0;
  }

  function applyEscape(raw, index, state) {
    const next = raw.charAt(index + 1);

    if (next === '[') {
      return applyCsi(raw, index, state);
    }

    if (next === ']') {
      return skipOsc(raw, index);
    }

    return next ? index + 2 : index + 1;
  }

  function applyCsi(raw, index, state) {
    const parsed = parseCsi(raw, index + 2);
    const command = parsed.final;
    const count = firstParam(parsed.params, 1);

    if (command === 'K' || command === 'J') {
      const mode = firstParam(parsed.params, 0);
      if (mode <= 0) {
        eraseToEnd(state);
      } else if (mode === 1) {
        eraseToStart(state);
      } else {
        eraseLine(state);
      }
      return parsed.nextIndex;
    }

    if (command === 'C') {
      state.col += count;
      return parsed.nextIndex;
    }

    if (command === 'D') {
      state.col = Math.max(0, state.col - count);
      return parsed.nextIndex;
    }

    if (command === 'G') {
      state.col = Math.max(0, count - 1);
      return parsed.nextIndex;
    }

    return parsed.nextIndex;
  }

  function parseCsi(raw, start) {
    let index = start;
    if (raw.charAt(index) === '?') {
      index += 1;
    }

    const paramStart = index;
    while (index < raw.length && /[0-9;]/.test(raw.charAt(index))) {
      index += 1;
    }

    const params = raw.slice(paramStart, index).split(';');

    while (index < raw.length) {
      const code = raw.charCodeAt(index);
      if (code >= 0x20 && code <= 0x2f) {
        index += 1;
        continue;
      }
      break;
    }

    const final = raw.charAt(index) || '';
    return {
      params: params,
      final: final,
      nextIndex: final ? index + 1 : index,
    };
  }

  function firstParam(params, fallback) {
    const raw = params && params.length ? params[0] : '';
    if (raw === '' || raw == null) {
      return fallback;
    }
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  function skipOsc(raw, index) {
    for (let i = index + 2; i < raw.length; i += 1) {
      if (raw.charCodeAt(i) === 7) {
        return i + 1;
      }
      if (raw.charAt(i) === '\x1b' && raw.charAt(i + 1) === '\\') {
        return i + 2;
      }
    }
    return raw.length;
  }

  function isIncompleteEscape(raw, index) {
    if (raw.charAt(index) !== '\x1b') {
      return false;
    }
    if (index === raw.length - 1) {
      return true;
    }

    const next = raw.charAt(index + 1);
    if (next === '[') {
      let i = index + 2;
      if (raw.charAt(i) === '?') {
        i += 1;
      }
      while (i < raw.length && /[0-9;]/.test(raw.charAt(i))) {
        i += 1;
      }
      while (i < raw.length) {
        const code = raw.charCodeAt(i);
        if (code >= 0x20 && code <= 0x2f) {
          i += 1;
          continue;
        }
        break;
      }
      return i >= raw.length;
    }

    if (next === ']') {
      for (let i = index + 2; i < raw.length; i += 1) {
        if (raw.charCodeAt(i) === 7) {
          return false;
        }
        if (raw.charAt(i) === '\x1b' && raw.charAt(i + 1) === '\\') {
          return false;
        }
      }
      return true;
    }

    return false;
  }

  global.createTermLineState = createTermLineState;
  global.flattenTerminalChunk = flattenTerminalChunk;
  global.currentTermLine = currentTermLine;
})(window);
