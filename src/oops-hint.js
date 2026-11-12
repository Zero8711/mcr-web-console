/**
 * 시리얼에 찍힌 Call Trace / kernel panic 에서
 * 마지막으로 보이는 함수+주소를 골라, 소스에서 찾아 보라고 안내한다.
 * Chrome AI 에 맡기지 않고 화면 문자열만 읽는다.
 */
(function (global) {
  const SKIP_NAME = {
    panic: true,
    die: true,
    oops_exit: true,
    dump_stack: true,
    show_stack: true,
    unwind_backtrace: true,
    dump_backtrace: true,
    show_regs: true,
    die_nmi: true,
    nmi_panic: true,
    ret_from_exception: true,
    ret_from_fork: true,
    kthread: true,
    kernel_thread: true,
  };

  const BLOCK_MARK =
    /Call Trace:|Kernel panic|Oops:|Internal error:|Unable to handle kernel|pc is at |PC is at |EIP is at |\bRIP:|\bIP:/i;

  const SYMBOL = /([A-Za-z_][A-Za-z0-9_]*)\+0x[0-9a-fA-F]+\/0x[0-9a-fA-F]+/g;

  function parse(logText) {
    const lines = String(logText || '').replace(/\r/g, '').split(/\n/);
    const start = findBlockStart(lines);
    if (start < 0) {
      return null;
    }

    const slice = lines.slice(start, Math.min(lines.length, start + 80));
    const text = slice.join('\n');
    const symbol = readPcSymbol(text) || firstUsefulSymbol(text);
    if (!symbol) {
      return null;
    }
    return makeResult(symbol);
  }

  function looksLikeOopsLine(line) {
    return BLOCK_MARK.test(String(line || ''));
  }

  function findBlockStart(lines) {
    let last = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (BLOCK_MARK.test(lines[i])) {
        last = i;
        break;
      }
    }
    if (last < 0) {
      return -1;
    }

    let start = last;
    const from = Math.max(0, last - 40);
    for (let i = last - 1; i >= from; i -= 1) {
      if (!isDumpLine(lines[i])) {
        break;
      }
      start = i;
    }
    return start;
  }

  function isDumpLine(line) {
    const text = String(line || '');
    if (!text.trim()) {
      return true;
    }
    if (BLOCK_MARK.test(text)) {
      return true;
    }
    if (/LR is at |PC is at |EIP is at |sp :|fp :|Flags:|Process |Stack:|Backtrace:/.test(text)) {
      return true;
    }
    if (/\[<[0-9a-fA-F]+>\]/.test(text)) {
      return true;
    }
    SYMBOL.lastIndex = 0;
    const hasSymbol = SYMBOL.test(text);
    SYMBOL.lastIndex = 0;
    return hasSymbol;
  }

  function readPcSymbol(text) {
    const patterns = [
      /pc is at\s+(\S+\+0x[0-9a-fA-F]+\/0x[0-9a-fA-F]+)/i,
      /PC is at\s+(\S+\+0x[0-9a-fA-F]+\/0x[0-9a-fA-F]+)/i,
      /EIP is at\s+(\S+\+0x[0-9a-fA-F]+\/0x[0-9a-fA-F]+)/i,
      /\bIP:\s+(\S+\+0x[0-9a-fA-F]+\/0x[0-9a-fA-F]+)/,
      /RIP:\s+\S+:(\S+\+0x[0-9a-fA-F]+\/0x[0-9a-fA-F]+)/,
      /pc\s*:\s*\[<[0-9a-fA-F]+>\]\s+(\S+\+0x[0-9a-fA-F]+\/0x[0-9a-fA-F]+)/i,
    ];
    for (let i = 0; i < patterns.length; i += 1) {
      const match = text.match(patterns[i]);
      if (match && isNamedSymbol(match[1])) {
        return match[1];
      }
    }
    return '';
  }

  function firstUsefulSymbol(text) {
    const lower = String(text || '').toLowerCase();
    const mark = lower.indexOf('call trace:');
    const region = mark >= 0 ? text.slice(mark) : text;
    const found = [];
    SYMBOL.lastIndex = 0;
    let match = SYMBOL.exec(region);
    while (match) {
      found.push(match[0]);
      match = SYMBOL.exec(region);
    }

    for (let i = 0; i < found.length; i += 1) {
      if (!SKIP_NAME[symbolName(found[i])]) {
        return found[i];
      }
    }
    return found.length ? found[0] : '';
  }

  function isNamedSymbol(symbol) {
    const name = symbolName(symbol);
    return Boolean(name && /[A-Za-z_]/.test(name[0]));
  }

  function symbolName(symbol) {
    return String(symbol || '').split('+')[0];
  }

  function makeResult(symbol) {
    const name = symbolName(symbol);
    const text =
      '마지막 함수: ' + symbol + '\n' +
      '소스에서 ' + name + ' 함수를 찾아 보세요.';
    return {
      symbol: symbol,
      name: name,
      text: text,
    };
  }

  /**
   * COM 없이 안내가 뜨는지 볼 때 쓰는 가짜 panic.
   * pc is at 의 mcr_watchdog_kick 이 마지막 함수로 잡혀야 한다.
   */
  const SAMPLE =
    '\r\n' +
    'Unable to handle kernel NULL pointer dereference at virtual address 00000000\r\n' +
    'Internal error: Oops: 5 [#1] PREEMPT SMP ARM\r\n' +
    'pc is at mcr_watchdog_kick+0x2c/0x80\r\n' +
    'LR is at mcr_watchdog_thread+0x54/0xc0\r\n' +
    'Call Trace:\r\n' +
    ' [<c0183a2c>] mcr_watchdog_kick+0x2c/0x80\r\n' +
    ' [<c0183b54>] mcr_watchdog_thread+0x54/0xc0\r\n' +
    ' [<c0048f10>] kthread+0xec/0x100\r\n' +
    ' [<c000e7c8>] ret_from_fork+0x14/0x20\r\n' +
    'Kernel panic - not syncing: Fatal exception\r\n';

  global.OopsHint = {
    parse: parse,
    looksLikeOopsLine: looksLikeOopsLine,
    SAMPLE: SAMPLE,
  };
})(window);
