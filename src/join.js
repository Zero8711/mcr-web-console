/**
 * 개발팀(guest) 화면.
 * COM 은 열지 않고, 시험팀 탭이 중계로 보내 준 로그만 보여 준다.
 * 명령·키 입력은 HTTP 로 시험팀 PC 에 전달한다.
 * 시험팀이 콘솔을 여러 칸 열면 같은 링크에 칸이 같이 생긴다.
 */
const room = ShareUtil.roomFromLocation();

const els = {
  name: document.getElementById('txt-guest-name'),
  join: document.getElementById('btn-join'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  peers: document.getElementById('share-peers'),
  perm: document.getElementById('guest-perm'),
  warning: document.getElementById('browser-warning'),
  consoleStack: document.getElementById('console-stack'),
  quickCommands: document.getElementById('quick-commands'),
  customCommand: document.getElementById('txt-custom-command'),
  sendCommand: document.getElementById('btn-send-command'),
  chatLog: document.getElementById('chat-log'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('txt-chat'),
  cmdLog: document.getElementById('cmd-log'),
  cmdHeader: document.getElementById('cmd-header'),
  cmdForm: document.getElementById('cmd-form'),
  panelCmd: document.getElementById('txt-panel-cmd'),
  panelCmdSend: document.getElementById('btn-panel-cmd'),
  clear: document.getElementById('btn-clear'),
};

const panes = [];
let selectedPane = null;
let shareClient = null;
let joined = false;
let canCmd = false;

function currentPane() {
  return selectedPane || panes[0] || null;
}

function findPane(slot) {
  if (slot == null || slot === '') {
    return currentPane();
  }
  return panes.find((pane) => pane.id === String(slot)) || null;
}

function writeGuide(text, color) {
  const pane = currentPane();
  if (!pane) {
    return;
  }
  const code = color === 'red' ? '31' : color === 'green' ? '32' : '33';
  pane.term.writeln('\x1b[' + code + 'm' + text + '\x1b[0m');
}

function paneHooks() {
  return {
    isPasteShortcut,
    onSelect: (pane, options) => selectPane(pane, options),
    onPaste: (pane) => pasteFromClipboard(pane),
    onGuestKeys: (pane, data) => {
      if (!joined || !canCmd) {
        return;
      }
      shareClient?.sendKeys(data, pane.id);
      pane.collectTyped(data);
    },
    onShareCmdLog: (pane, text) => {
      if (!joined || !canCmd) {
        return;
      }
      shareClient?.sendCmdLog(text, pane.id);
    },
    onMetaChange: (pane) => {
      if (!joined) {
        return;
      }
      shareClient?.sendRename(pane.id, pane.title);
    },
  };
}

function ensurePane(id, title) {
  const slot = String(id || '1');
  let pane = panes.find((item) => item.id === slot);
  if (pane) {
    if (title) {
      pane.setTitle(title);
    }
    return pane;
  }

  pane = new ConsolePane({
    id: slot,
    title: title || ('장비 ' + slot),
    mode: 'guest',
    container: els.consoleStack,
    hooks: paneHooks(),
  });
  panes.push(pane);
  pane.setInputEnabled(joined && canCmd);
  if (!selectedPane) {
    selectPane(pane);
  }
  return pane;
}

function selectPane(pane, options) {
  if (!pane) {
    return;
  }
  selectedPane = pane;
  for (const item of panes) {
    item.setSelected(item === pane);
  }
  if (!options?.keepFocus && document.activeElement !== pane.titleInput) {
    pane.focus();
  }
}

function syncConsoles(text) {
  const list = ShareUtil.decodeConsoles(text);
  if (!list.length) {
    return;
  }

  const keep = {};
  for (const item of list) {
    const pane = ensurePane(item.id, item.title);
    pane.setStatus(item.open ? '연결됨' : '연결 안 됨');
    keep[item.id] = true;
  }

  for (let i = panes.length - 1; i >= 0; i -= 1) {
    if (keep[panes[i].id]) {
      continue;
    }
    const gone = panes[i];
    gone.destroy();
    panes.splice(i, 1);
    if (selectedPane === gone) {
      selectedPane = null;
    }
  }

  if (!selectedPane || panes.indexOf(selectedPane) < 0) {
    selectPane(panes[0] || null);
  }

  for (const pane of panes) {
    pane.fit();
  }
}

ensurePane('1', '장비 1');

function fitAllPanes() {
  for (const pane of panes) {
    pane.fit();
  }
}

window.addEventListener('resize', fitAllPanes);
window.visualViewport?.addEventListener('resize', fitAllPanes);

bindQuickCommands();
applyGuestPerm(false);
restoreGuestName();

if (!room) {
  els.warning.hidden = false;
  els.warning.textContent = '공유 링크에 방 토큰이 없습니다. 시험팀이 복사한 URL 로 열어 주세요.';
  els.statusText.textContent = '방 없음';
  els.join.disabled = true;
  writeGuide('[안내] join.html?room=... 형식의 링크로 접속하세요.');
} else {
  setStatus(false, '이름을 입력하고 접속하세요');
  writeGuide('[안내] 위쪽 이름칸에 본인 이름을 적은 뒤 [접속] 을 누르세요. 같은 링크로 여러 명이 들어올 수 있습니다.');
  writeGuide('[안내] 처음에는 화면 보기와 채팅만 됩니다. 명령은 시험팀이 허용하면 열립니다.');
}

els.join.addEventListener('click', () => {
  connectShare();
});

els.name.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') {
    return;
  }
  event.preventDefault();
  connectShare();
});

els.sendCommand.addEventListener('click', () => {
  sendConsoleCommand(els.customCommand.value);
});

els.customCommand.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') {
    return;
  }
  event.preventDefault();
  sendConsoleCommand(els.customCommand.value);
});

els.clear.addEventListener('click', () => {
  currentPane()?.clear();
});

els.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.chatInput.value;
  els.chatInput.value = '';
  sendGuestText(text);
});

els.cmdForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.panelCmd.value;
  els.panelCmd.value = '';
  sendConsoleCommand(text);
});

window.addEventListener('beforeunload', () => {
  for (const pane of panes) {
    pane.sessionLog?.stop();
  }
  shareClient?.disconnect();
});

function connectShare() {
  if (!room) {
    return;
  }

  const name = readGuestName();
  if (!name) {
    setStatus(false, '이름을 입력하고 접속하세요');
    writeGuide('[안내] 이름을 입력한 뒤 [접속] 을 누르세요.');
    els.name.focus();
    return;
  }

  saveGuestName(name);
  joined = false;
  canCmd = false;
  applyGuestPerm(false);
  els.join.disabled = true;
  shareClient?.disconnect();
  shareClient = new ShareClient({
    role: 'guest',
    room,
    name,
  });

  shareClient.onOpen = () => {
    setStatus(false, '방 입장 중…');
    writeGuide('[공유] 시험팀 방에 들어가는 중입니다.');
  };

  shareClient.onReady = () => {
    joined = true;
    applyGuestPerm(shareClient.canCmd);
    els.join.disabled = false;
    els.join.textContent = '다시 접속';
    els.name.value = shareClient.name;
    setStatus(true, shareClient.name + ' · 공유 접속됨');
    writeGuide('[공유] ' + shareClient.name + ' 으로 들어왔습니다. 콘솔 보기와 채팅은 바로 됩니다.', 'green');
    if (!shareClient.canCmd) {
      writeGuide('[공유] 장비 명령은 시험팀이 허용하면 이 화면에 열립니다.');
    }
    fitAllPanes();
    setTimeout(fitAllPanes, 200);
  };

  shareClient.onConsoles = (text) => {
    syncConsoles(text);
  };

  shareClient.onRename = (title, slot) => {
    findPane(slot)?.setTitle(title);
  };

  shareClient.onLog = (text, slot) => {
    const pane = findPane(slot);
    if (!pane) {
      return;
    }
    pane.writeIncoming(text);
  };

  shareClient.onHistory = (text, slot) => {
    const pane = findPane(slot);
    if (!pane) {
      return;
    }
    pane.writeIncoming(text);
    for (const pane of panes) {
      pane.fit();
    }
  };

  shareClient.onChat = (text, from) => {
    ShareUtil.appendChatLine(els.chatLog, from, text, shareClient.name);
  };

  shareClient.onCmdLog = (text, from, slot) => {
    const title = findPane(slot)?.title || ('장비 ' + slot);
    ShareUtil.appendCmdLine(els.cmdLog, from, '[' + title + '] ' + text, shareClient.name);
  };

  shareClient.onPeers = (info) => {
    els.peers.textContent = ShareUtil.peerSummary(info);
  };

  shareClient.onPerm = (allowed) => {
    const changed = allowed !== canCmd;
    applyGuestPerm(allowed);
    if (!joined || !changed) {
      return;
    }
    if (allowed) {
      writeGuide('[공유] 시험팀이 명령 입력을 허용했습니다. 콘솔 칸을 선택한 뒤 보내세요.', 'green');
    } else {
      writeGuide('[공유] 명령 입력이 해제되었습니다. 화면 보기와 채팅만 됩니다.');
    }
  };

  shareClient.onError = (message) => {
    joined = false;
    canCmd = false;
    applyGuestPerm(false);
    els.join.disabled = false;
    els.join.textContent = '접속';
    setStatus(false, '접속 실패');
    writeGuide('[공유] ' + message, 'red');
  };

  shareClient.onClosed = (message) => {
    joined = false;
    canCmd = false;
    applyGuestPerm(false);
    els.join.disabled = false;
    els.join.textContent = '접속';
    setStatus(false, '공유 종료');
    els.peers.textContent = '접속 0명';
    writeGuide('[공유] ' + message);
  };

  shareClient.connect();
}

function bindQuickCommands() {
  for (const item of QUICK_COMMANDS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-cmd';
    button.textContent = item.label;
    button.disabled = true;
    button.addEventListener('click', () => {
      sendConsoleCommand(item.command);
    });
    els.quickCommands.appendChild(button);
  }
}

function sendConsoleCommand(command) {
  const text = String(command || '').trim();
  if (!text) {
    return;
  }

  const pane = currentPane();
  if (!shareClient || !shareClient.connected) {
    writeGuide('[안내] 아직 시험팀 방에 들어가지 못했습니다. 상태가 초록이 된 뒤 보내세요.');
    return;
  }
  if (!canCmd) {
    writeGuide('[안내] 지금은 채팅만 됩니다. 명령은 시험팀이 허용해야 합니다.');
    return;
  }
  if (!pane) {
    return;
  }

  shareClient.sendCmd(text, pane.id);
  pane.term.writeln('\x1b[33m> ' + text + '\x1b[0m');
  els.customCommand.value = '';
  pane.focus();
}

function sendGuestText(text) {
  const body = String(text || '').trim();
  if (!body || !shareClient) {
    return;
  }
  if (!shareClient.connected) {
    writeGuide('[안내] 아직 시험팀 방에 들어가지 못했습니다. 상태가 초록이 된 뒤 보내세요.');
    return;
  }
  shareClient.sendChat(body);
}

function setCommandEnabled(enabled) {
  els.sendCommand.disabled = !enabled;
  els.customCommand.disabled = !enabled;
  if (els.panelCmd) {
    els.panelCmd.disabled = !enabled;
  }
  if (els.panelCmdSend) {
    els.panelCmdSend.disabled = !enabled;
  }
  const commandButtons = els.quickCommands.querySelectorAll('button');
  for (const button of commandButtons) {
    button.disabled = !enabled;
  }
}

function applyGuestPerm(allowed) {
  canCmd = Boolean(allowed);
  document.getElementById('app')?.classList.toggle('guest-readonly', !canCmd);
  setCommandEnabled(joined && canCmd);
  for (const pane of panes) {
    pane.setInputEnabled(joined && canCmd);
  }
  if (els.perm) {
    els.perm.textContent = canCmd ? '명령 가능' : '채팅만';
    els.perm.classList.toggle('allowed', canCmd);
  }
  if (els.cmdHeader) {
    els.cmdHeader.textContent = canCmd ? '명령 기록' : '명령 기록 (입력 잠김)';
  }
  if (joined) {
    fitAllPanes();
  }
}

function setStatus(ok, text) {
  els.statusDot.classList.toggle('connected', ok);
  els.statusText.textContent = text;
}

function readGuestName() {
  return String(els.name.value || '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

function restoreGuestName() {
  const fromUrl = new URLSearchParams(location.search).get('name');
  if (fromUrl && fromUrl.trim()) {
    els.name.value = fromUrl.trim().slice(0, 20);
    return;
  }
  try {
    const saved = localStorage.getItem('share-guest-name');
    if (saved) {
      els.name.value = saved.slice(0, 20);
    }
  } catch {
    // 저장소를 쓰지 못하면 빈 칸으로 둔다
  }
}

function saveGuestName(name) {
  try {
    localStorage.setItem('share-guest-name', name);
  } catch {
    // 저장 실패는 접속에 영향 없다
  }
}

document.addEventListener(
  'keydown',
  (event) => {
    if (isFindShortcut(event)) {
      event.preventDefault();
      currentPane()?.openFind();
      return;
    }
    if (event.key !== 'F3') {
      return;
    }
    event.preventDefault();
    if (event.shiftKey) {
      currentPane()?.findPrev();
    } else {
      currentPane()?.findNext();
    }
  },
  true
);

function isPasteShortcut(event) {
  if (event.type !== 'keydown') {
    return false;
  }
  const withModifier = event.ctrlKey || event.metaKey;
  if (withModifier && event.code === 'KeyV') {
    return true;
  }
  return event.shiftKey && event.code === 'Insert';
}

function pasteFromClipboard(pane) {
  const target = pane || currentPane();
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    writeGuide('[안내] 이 브라우저는 클립보드 붙여넣기를 지원하지 않습니다.');
    return;
  }
  navigator.clipboard.readText().then((text) => {
    if (!text || !joined || !canCmd || !target) {
      return;
    }
    shareClient.sendKeys(text, target.id);
    target.collectTyped(text);
  }).catch((err) => {
    writeGuide('[붙여넣기 실패] ' + err.message, 'red');
  });
}
