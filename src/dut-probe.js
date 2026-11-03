/**
 * 분석 칸이 화면만 보지 않고, 장비 셸에서 경로와 명령을 확인한다.
 * pwd / PATH / ls / busybox --list 만 보내며, 설정을 바꾸거나 재부팅하지 않는다.
 */
(function (global) {
  const PROBE_COMMAND =
    'pwd; echo --PATH--; echo $PATH; echo --LS--; ls; echo --BB--; busybox --list';
  const CACHE_MS = 60 * 1000;
  const TIMEOUT_MS = 8000;
  const PATH_MARK = '--PATH--';
  const LS_MARK = '--LS--';
  const BB_MARK = '--BB--';

  const USEFUL_COMMANDS = [
    'ifconfig', 'ip', 'brctl', 'iwconfig', 'iw', 'iwinfo', 'ethtool',
    'route', 'ping', 'traceroute', 'nslookup', 'netstat', 'ss',
    'logread', 'dmesg', 'ps', 'top', 'free', 'df', 'du', 'uptime', 'uname',
    'cat', 'ls', 'cd', 'pwd', 'cp', 'mv', 'rm', 'mkdir', 'chmod',
    'kill', 'killall', 'grep', 'head', 'tail', 'hexdump', 'md5sum',
    'uci', 'ubus', 'fw_printenv', 'mtd', 'nvram', 'swconfig',
    'iptables', 'ebtables', 'sysctl', 'mount', 'wget', 'which',
    'ash', 'sh', 'busybox', 'wifi', 'ifup', 'ifdown', 'logread',
  ];

  const SHELL_BUILTINS = ['cd', 'echo', 'export', 'pwd', 'type', 'alias'];

  function probe(pane, options) {
    const hint = options || {};
    if (!pane) {
      return Promise.resolve({ skipped: 'no-pane' });
    }
    if (!pane.isOpen) {
      return Promise.resolve({ skipped: 'closed' });
    }
    if (!isIdlePrompt(pane.getRecentLog(20))) {
      return Promise.resolve({ skipped: 'no-prompt', cwd: cwdFromPrompt(pane.getRecentLog(30)) });
    }

    const cached = readCache(pane);
    if (cached) {
      return Promise.resolve(filterFacts(cached, hint.question));
    }

    if (pane.probeBusy) {
      return pane.probeBusy.then(function (facts) {
        return filterFacts(facts, hint.question);
      });
    }

    pane.probeBusy = runProbe(pane).then(function (facts) {
      pane.commandFacts = facts;
      pane.probeBusy = null;
      return filterFacts(facts, hint.question);
    }).catch(function (err) {
      pane.probeBusy = null;
      return { skipped: 'error', message: err && err.message ? err.message : String(err) };
    });

    return pane.probeBusy;
  }

  function runProbe(pane) {
    return collectCommandOutput(pane, PROBE_COMMAND, TIMEOUT_MS).then(function (result) {
      const facts = parseProbeOutput(result.text, PROBE_COMMAND);
      facts.timedOut = Boolean(result.timedOut);
      facts.at = Date.now();
      if (!facts.cwd) {
        facts.cwd = cwdFromPrompt(pane.getRecentLog(40)) || facts.cwd;
      }
      return facts;
    });
  }

  function collectCommandOutput(pane, command, timeoutMs) {
    return new Promise(function (resolve) {
      const lineState = createTermLineState();
      const lines = [];
      let settled = false;

      function finish(timedOut) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        pane.removeRxListener(onChunk);
        const leftover = currentTermLine(lineState);
        if (leftover) {
          lines.push(leftover);
        }
        resolve({ text: lines.join('\n'), timedOut: Boolean(timedOut) });
      }

      function onChunk(chunk) {
        const flattened = flattenTerminalChunk(chunk, lineState);
        for (let i = 0; i < flattened.lines.length; i += 1) {
          lines.push(flattened.lines[i]);
        }
        if (hasProbeFinished(lines, currentTermLine(lineState))) {
          finish(false);
        }
      }

      const timer = setTimeout(function () {
        finish(true);
      }, timeoutMs);

      pane.addRxListener(onChunk);
      pane.writeLine(command, { quiet: true });
    });
  }

  function hasProbeFinished(lines, current) {
    const joined = lines.concat(current || '').join('\n');
    if (joined.indexOf(BB_MARK) < 0 && joined.indexOf(PATH_MARK) < 0) {
      return false;
    }
    return isShellPromptLine(current) || isShellPromptLine(lines[lines.length - 1]);
  }

  function parseProbeOutput(raw, command) {
    const text = String(raw || '');
    const pathBlock = sliceMark(text, PATH_MARK, LS_MARK);
    const lsBlock = sliceMark(text, LS_MARK, BB_MARK);
    const bbBlock = sliceMark(text, BB_MARK, '');
    const pwdBlock = text.split(PATH_MARK)[0] || '';

    const cwd = pickCwd(dropNoise(pwdBlock, command));
    const path = pickPath(dropNoise(pathBlock, command));
    const files = pickFiles(dropNoise(lsBlock, command));
    const allCommands = pickBusybox(bbBlock);

    for (let i = 0; i < SHELL_BUILTINS.length; i += 1) {
      if (allCommands.indexOf(SHELL_BUILTINS[i]) < 0) {
        allCommands.push(SHELL_BUILTINS[i]);
      }
    }

    return {
      cwd: cwd,
      path: path,
      files: files,
      allCommands: allCommands,
      commands: [],
      timedOut: false,
      at: 0,
    };
  }

  function filterFacts(facts, question) {
    if (!facts || facts.skipped) {
      return facts;
    }
    const names = {};
    const all = facts.allCommands || [];
    for (let i = 0; i < all.length; i += 1) {
      names[all[i]] = true;
    }

    const chosen = [];
    const ask = String(question || '').toLowerCase();
    const words = ask.split(/[^a-z0-9_\-]+/);
    for (let i = 0; i < words.length; i += 1) {
      const word = words[i];
      if (word && names[word] && chosen.indexOf(word) < 0) {
        chosen.push(word);
      }
    }
    for (let i = 0; i < USEFUL_COMMANDS.length; i += 1) {
      const name = USEFUL_COMMANDS[i];
      if (names[name] && chosen.indexOf(name) < 0) {
        chosen.push(name);
      }
    }

    return {
      cwd: facts.cwd || '',
      path: facts.path || '',
      files: (facts.files || []).slice(0, 30),
      commands: chosen.slice(0, 40),
      allCount: all.length,
      timedOut: Boolean(facts.timedOut),
      at: facts.at,
    };
  }

  function sliceMark(text, startMark, endMark) {
    const start = text.indexOf(startMark);
    if (start < 0) {
      return '';
    }
    const from = start + startMark.length;
    if (!endMark) {
      return text.slice(from);
    }
    const end = text.indexOf(endMark, from);
    return end < 0 ? text.slice(from) : text.slice(from, end);
  }

  function dropNoise(block, command) {
    const lines = String(block || '').split(/\n/);
    const cleaned = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].replace(/\s+$/g, '').trim();
      if (!line) {
        continue;
      }
      if (line === command) {
        continue;
      }
      if (line.indexOf(PATH_MARK) >= 0 || line.indexOf(LS_MARK) >= 0 || line.indexOf(BB_MARK) >= 0) {
        continue;
      }
      if (isShellPromptLine(line)) {
        continue;
      }
      if (/not found|can't|cannot|permission denied/i.test(line)) {
        continue;
      }
      cleaned.push(line);
    }
    return cleaned;
  }

  function pickCwd(lines) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.charAt(0) === '/' || line.charAt(0) === '~') {
        return line.split(/\s+/)[0];
      }
    }
    return '';
  }

  function pickPath(lines) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.indexOf('/') >= 0 && line.indexOf(':') >= 0) {
        return line;
      }
    }
    return lines[0] || '';
  }

  function pickFiles(lines) {
    const files = [];
    for (let i = 0; i < lines.length && files.length < 30; i += 1) {
      const line = lines[i];
      if (/^total\s/i.test(line)) {
        continue;
      }
      const names = line.split(/\s+/);
      for (let j = 0; j < names.length; j += 1) {
        const name = names[j];
        if (!name || name === '.' || name === '..') {
          continue;
        }
        if (files.indexOf(name) < 0) {
          files.push(name);
        }
        if (files.length >= 30) {
          break;
        }
      }
    }
    return files;
  }

  function pickBusybox(block) {
    const names = [];
    const parts = String(block || '').split(/[^A-Za-z0-9_\[\]\-]+/);
    for (let i = 0; i < parts.length; i += 1) {
      const name = parts[i];
      if (!name || name.length > 32) {
        continue;
      }
      if (!/^[A-Za-z\[\]\-]/.test(name)) {
        continue;
      }
      if (name === PATH_MARK || name === LS_MARK || name === BB_MARK) {
        continue;
      }
      if (names.indexOf(name) < 0) {
        names.push(name);
      }
    }
    return names;
  }

  function isIdlePrompt(logText) {
    const lines = String(logText || '').split(/\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].replace(/\s+$/g, '');
      if (!line) {
        continue;
      }
      return isShellPromptLine(line);
    }
    return false;
  }

  function isShellPromptLine(line) {
    const text = String(line || '').replace(/\s+$/g, '');
    if (!text || text.length > 160) {
      return false;
    }
    if (!/[#\$]$/.test(text)) {
      return false;
    }
    if (text === '#' || text === '$') {
      return true;
    }
    if (/@/.test(text)) {
      return true;
    }
    if (/[\/~:]/.test(text)) {
      return true;
    }
    return false;
  }

  function cwdFromPrompt(logText) {
    const lines = String(logText || '').split(/\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].replace(/\s+$/g, '');
      const match = line.match(/:([\/~][^#\$\s]*)\s*[#\$]\s*$/);
      if (match) {
        return match[1];
      }
    }
    return '';
  }

  function readCache(pane) {
    const facts = pane.commandFacts;
    if (!facts || facts.skipped || !facts.at) {
      return null;
    }
    if (Date.now() - facts.at > CACHE_MS) {
      return null;
    }
    return facts;
  }

  function skipLabel(facts) {
    const code = facts && facts.skipped;
    if (code === 'closed') {
      return '장비가 연결되지 않았습니다.';
    }
    if (code === 'no-prompt') {
      return '셸 프롬프트가 아니라 장비 명령을 보내지 않았습니다. 프롬프트에서 다시 누르세요.';
    }
    if (code === 'error') {
      return facts.message || '장비 확인에 실패했습니다.';
    }
    if (code === 'no-pane') {
      return '분석할 콘솔이 없습니다.';
    }
    return '';
  }

  global.DutProbe = {
    probe: probe,
    skipLabel: skipLabel,
    command: PROBE_COMMAND,
  };
})(window);
