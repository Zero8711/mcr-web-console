const els = {
  connect: document.getElementById('btn-connect'),
  disconnect: document.getElementById('btn-disconnect'),
  addConsole: document.getElementById('btn-add-console'),
  removeConsole: document.getElementById('btn-remove-console'),
  clear: document.getElementById('btn-clear'),
  baud: document.getElementById('sel-baud'),
  dataBits: document.getElementById('sel-data-bits'),
  parity: document.getElementById('sel-parity'),
  stopBits: document.getElementById('sel-stop-bits'),
  newline: document.getElementById('sel-newline'),
  echo: document.getElementById('chk-echo'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  warning: document.getElementById('browser-warning'),
  consoleStack: document.getElementById('console-stack'),
  logFile: document.getElementById('btn-log-file'),
  logFolder: document.getElementById('btn-log-folder'),
  logWatch: document.getElementById('chk-log-watch'),
  logStop: document.getElementById('btn-log-stop'),
  logKeywords: document.getElementById('txt-log-keywords'),
  agingTarget: document.getElementById('aging-target'),
  agingHitList: document.getElementById('aging-hit-list'),
  agingHitClear: document.getElementById('btn-aging-hit-clear'),
  logStatusDot: document.getElementById('log-status-dot'),
  logStatusText: document.getElementById('log-status-text'),
  quickCommands: document.getElementById('quick-commands'),
  customCommand: document.getElementById('txt-custom-command'),
  sendCommand: document.getElementById('btn-send-command'),
  shareStart: document.getElementById('btn-share-start'),
  shareStop: document.getElementById('btn-share-stop'),
  shareCopy: document.getElementById('btn-share-copy'),
  shareName: document.getElementById('txt-share-name'),
  sharePass: document.getElementById('txt-share-pass'),
  sharePassShow: document.getElementById('chk-share-pass-show'),
  sharePassHint: document.getElementById('share-pass-hint'),
  shareWan: document.getElementById('txt-share-wan'),
  shareUrl: document.getElementById('txt-share-url'),
  sharePeers: document.getElementById('share-peers'),
  shareGuestBar: document.getElementById('share-guest-bar'),
  shareGuestList: document.getElementById('share-guest-list'),
  pagesHint: document.getElementById('pages-hint'),
  chatPanel: document.getElementById('chat-panel'),
  chatLog: document.getElementById('chat-log'),
  chatForm: document.getElementById('chat-form'),
  chatInput: document.getElementById('txt-chat'),
  cmdPanel: document.getElementById('cmd-panel'),
  cmdLog: document.getElementById('cmd-log'),
  cmdForm: document.getElementById('cmd-form'),
  panelCmd: document.getElementById('txt-panel-cmd'),
  panelCmdSend: document.getElementById('btn-panel-cmd'),
  alertModal: document.getElementById('alert-modal'),
  alertConsole: document.getElementById('alert-modal-console'),
  alertTime: document.getElementById('alert-modal-time'),
  alertLine: document.getElementById('alert-modal-line'),
  alertFile: document.getElementById('alert-modal-file'),
  alertOk: document.getElementById('btn-alert-ok'),
};

const PAGE_TITLE = document.title;
const MAX_PANES = 4;
const panes = [];
let selectedPane = null;
let nextPaneId = 1;
let titleBlinkTimer = null;
let shareClient = null;
let shareUrl = '';
const SHARE_WAN_KEY = 'share-wan-host';
const SHARE_NAME_KEY = 'share-host-name';

if (els.shareWan) {
  els.shareWan.value = localStorage.getItem(SHARE_WAN_KEY) || '';
  els.shareWan.addEventListener('change', () => {
    localStorage.setItem(SHARE_WAN_KEY, els.shareWan.value.trim());
  });
}

if (els.shareName) {
  els.shareName.value = localStorage.getItem(SHARE_NAME_KEY) || '';
}

if (els.sharePass) {
  els.sharePass.addEventListener('input', () => {
    updateSharePasswordHint();
    setButtonState(currentPane()?.isOpen);
  });
}

if (els.sharePassShow && els.sharePass) {
  els.sharePassShow.addEventListener('change', () => {
    els.sharePass.type = els.sharePassShow.checked ? 'text' : 'password';
  });
}

function currentPane() {
  return selectedPane || panes[0] || null;
}

function anyOpen() {
  return panes.some((pane) => pane.isOpen);
}

function findPane(slot) {
  if (slot == null || slot === '') {
    return currentPane();
  }
  return panes.find((pane) => pane.id === String(slot)) || null;
}

function paneHooks() {
  return {
    getSerialOptions: readSerialOptions,
    getNewline: () => els.newline.value,
    getEcho: () => els.echo.checked,
    applyNewline,
    echoLocal,
    isPasteShortcut,
    onSelect: (pane, options) => selectPane(pane, options),
    onPaste: (pane) => pasteFromClipboard(pane),
    onShareLog: (pane, text) => shareClient?.sendLog(text, pane.id),
    onShareCmdLog: (pane, text) => shareClient?.sendCmdLog(text, pane.id),
    onMetaChange: (pane) => {
      broadcastConsoles();
      if (pane === currentPane()) {
        syncAgingToolbar(pane);
      }
    },
    onOpenChange: (pane) => {
      if (pane === currentPane()) {
        setConnectedUi(pane);
      } else {
        refreshShareButtons();
      }
      broadcastConsoles();
      if (shareClient && !anyOpen()) {
        stopShare('모든 COM 이 끊어져 공유를 종료했습니다.');
      }
    },
    onPortGone: (pane) => {
      handleDisconnected(pane, '케이블이 분리되었습니다.');
    },
    onAgingState: (pane, state) => {
      if (pane === currentPane()) {
        applyAgingState(state);
      }
    },
    onAgingTriggered: (pane, keyword, fileName, triggerLine, timeText) => {
      showAbnormalAlert(pane, keyword, fileName, triggerLine, timeText);
      if (!shareClient) {
        return;
      }
      shareClient.sendAging(
        'alert',
        pane.id,
        JSON.stringify({
          keyword: keyword,
          fileName: fileName,
          triggerLine: triggerLine,
          timeText: timeText,
          title: pane.title,
        })
      );
    },
    onAgingHits: (pane, list) => {
      if (pane === currentPane()) {
        renderAgingHits(list);
      }
      scheduleAgingHitsShare(pane);
    },
  };
}

function addPane(title) {
  if (panes.length >= MAX_PANES) {
    currentPane()?.term.writeln('\x1b[33m[안내] 콘솔은 한 화면에 4대까지입니다.\x1b[0m');
    return null;
  }

  const pane = new ConsolePane({
    id: String(nextPaneId),
    title: title || ('장비 ' + nextPaneId),
    mode: 'host',
    container: els.consoleStack,
    hooks: paneHooks(),
  });
  nextPaneId += 1;
  panes.push(pane);
  selectPane(pane);
  broadcastConsoles();
  return pane;
}

function removePane(pane) {
  if (panes.length <= 1) {
    return;
  }
  const target = pane || currentPane();
  if (!target || target.isOpen) {
    target?.term.writeln('\x1b[33m[안내] 연결된 콘솔은 먼저 해제하세요.\x1b[0m');
    return;
  }

  const index = panes.indexOf(target);
  target.destroy();
  panes.splice(index, 1);
  selectPane(panes[Math.max(0, index - 1)]);
  broadcastConsoles();
}

function selectPane(pane, options) {
  if (!pane) {
    return;
  }
  selectedPane = pane;
  for (const item of panes) {
    item.setSelected(item === pane);
  }
  syncAgingToolbar(pane);
  setConnectedUi(pane);
  if (!options?.keepFocus && !pane.isBarField(document.activeElement)) {
    pane.focus();
  }
}

function broadcastConsoles() {
  if (!shareClient) {
    return;
  }
  shareClient.sendConsoles(
    ShareUtil.encodeConsoles(
      panes.map((pane) => ({
        id: pane.id,
        title: pane.title,
        open: pane.isOpen,
      }))
    )
  );
}

function syncAgingToolbar(pane) {
  const target = pane || currentPane();
  if (!target) {
    return;
  }
  if (els.agingTarget) {
    els.agingTarget.textContent = '대상: ' + target.title;
  }
  if (!target.agingLog) {
    return;
  }
  if (els.logKeywords) {
    const editingThisPane =
      document.activeElement === els.logKeywords && selectedPane === target;
    if (!editingThisPane) {
      els.logKeywords.value = target.agingLog.getKeywordText();
    }
  }
  els.logWatch.checked = target.agingLog.enabled;
  applyAgingState(target.agingLog.getState());
  renderAgingHits(target.agingLog.getHitList());
}

function applyAgingState(state) {
  els.logStatusText.textContent = state.text;
  els.logStatusDot.classList.toggle('watching', state.kind === 'watching');
  els.logStatusDot.classList.toggle('recording', state.kind === 'recording');
  els.logStatusDot.classList.toggle('connected', state.kind === 'recording');
  els.logStop.disabled = state.kind !== 'recording';
}

function renderAgingHits(list) {
  ShareUtil.renderAgingHitList(els.agingHitList, list, {
    clearButton: els.agingHitClear,
    emptyText: '키워드를 입력하면 발견 횟수가 여기에 쌓입니다.',
  });
}

const agingHitShareTimers = {};

function scheduleAgingHitsShare(pane) {
  if (!shareClient || !pane || !pane.agingLog) {
    return;
  }
  const id = pane.id;
  if (agingHitShareTimers[id]) {
    return;
  }
  agingHitShareTimers[id] = setTimeout(() => {
    agingHitShareTimers[id] = null;
    broadcastAgingHits(pane);
  }, 400);
}

function broadcastAgingHits(pane) {
  if (!shareClient || !pane || !pane.agingLog) {
    return;
  }
  shareClient.sendAging('hits', pane.id, JSON.stringify(pane.agingLog.getHitList()));
}

function broadcastAllAgingHits() {
  for (const pane of panes) {
    broadcastAgingHits(pane);
  }
}

function refreshShareButtons() {
  const pane = currentPane();
  setButtonState(Boolean(pane && pane.isOpen));
}

window.addEventListener('resize', () => {
  for (const pane of panes) {
    pane.fit();
  }
});

if (!ShareUtil.isLocalRelayOrigin()) {
  if (els.pagesHint) {
    els.pagesHint.hidden = false;
  }
  const wanGroup = els.shareWan?.closest('.toolbar-group');
  if (wanGroup) {
    wanGroup.hidden = true;
  }
}

const serialBlockReason = getSerialBlockReason();
if (serialBlockReason) {
  els.warning.hidden = false;
  els.warning.textContent = serialBlockReason;
  els.connect.disabled = true;
}

addPane('장비 1');
if (serialBlockReason) {
  currentPane()?.term.writeln(serialBlockReason);
}

if (!AgingLogWatcher.isSupported()) {
  els.logFile.disabled = true;
  els.logFolder.disabled = true;
  els.logWatch.disabled = true;
  els.logStop.disabled = true;
  if (els.logKeywords) {
    els.logKeywords.disabled = true;
  }
}

syncAgingToolbar(currentPane());

els.logFile.addEventListener('click', () => {
  pickLogFile().catch((err) => {
    if (isUserCancel(err)) {
      return;
    }
    currentPane()?.term.writeln(`\x1b[31m[파일 지정 실패] ${toSaveLocationError(err)}\x1b[0m`);
  });
});

els.logFolder.addEventListener('click', () => {
  pickLogFolder().catch((err) => {
    if (isUserCancel(err)) {
      return;
    }
    currentPane()?.term.writeln(`\x1b[31m[폴더 지정 실패] ${toSaveLocationError(err)}\x1b[0m`);
  });
});

els.logWatch.addEventListener('change', () => {
  toggleLogWatch().catch((err) => {
    const pane = currentPane();
    if (isUserCancel(err)) {
      els.logWatch.checked = false;
      pane?.agingLog.setEnabled(false);
      return;
    }
    els.logWatch.checked = false;
    pane?.agingLog.setEnabled(false);
    pane?.term.writeln(`\x1b[31m[감시 시작 실패] ${toSaveLocationError(err)}\x1b[0m`);
  });
});

els.logStop.addEventListener('click', () => {
  currentPane()?.agingLog.stopCaptureByUser();
});

if (els.agingHitClear) {
  els.agingHitClear.addEventListener('click', () => {
    currentPane()?.agingLog?.clearHits();
  });
}

if (els.logKeywords) {
  const applySelectedKeywords = () => {
    const pane = currentPane();
    pane?.agingLog?.setKeywords(els.logKeywords.value);
  };
  els.logKeywords.addEventListener('input', applySelectedKeywords);
  els.logKeywords.addEventListener('change', applySelectedKeywords);
  els.logKeywords.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    applySelectedKeywords();
    currentPane()?.focus();
  });
}

els.alertOk.addEventListener('click', () => {
  hideAbnormalAlert();
  currentPane()?.focus();
});

window.addEventListener('beforeunload', () => {
  for (const pane of panes) {
    pane.agingLog?.flushAndStop();
    pane.sessionLog?.stop();
  }
  shareClient?.disconnect();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') {
    return;
  }
  for (const pane of panes) {
    pane.agingLog?.commitNow();
    pane.sessionLog?.commitNow();
  }
});

els.connect.addEventListener('click', () => {
  connect().catch((err) => {
    const pane = currentPane();
    if (isUserCancel(err)) {
      pane?.term.writeln('');
      pane?.term.writeln('\x1b[33m[안내] 포트를 선택하지 않았거나, 브라우저가 COM 을 찾지 못했습니다.\x1b[0m');
      pane?.term.writeln('\x1b[33m       Chrome/Edge 의 https:// 로 열고, Tera Term 이 같은 COM 을 잡고 있으면 종료하세요.\x1b[0m');
      return;
    }
    pane?.term.writeln(`\x1b[31m[연결 실패] ${toErrorMessage(err)}\x1b[0m`);
    setStatus(false, '연결 실패');
  });
});

els.disconnect.addEventListener('click', () => {
  disconnect().catch((err) => {
    currentPane()?.term.writeln(`\x1b[31m[해제 실패] ${err.message}\x1b[0m`);
  });
});

els.addConsole.addEventListener('click', () => {
  addPane();
});

els.removeConsole.addEventListener('click', () => {
  removePane();
});

els.clear.addEventListener('click', () => {
  currentPane()?.clear();
});

bindQuickCommands();
updateSharePasswordHint();

els.shareStart.addEventListener('click', () => {
  startShare().catch((err) => {
    currentPane()?.term.writeln(`\x1b[31m[공유 실패] ${err.message}\x1b[0m`);
  });
});

els.shareStop.addEventListener('click', () => {
  stopShare('공유를 종료했습니다.');
});

els.shareCopy.addEventListener('click', () => {
  copyShareUrl();
});

els.chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.chatInput.value;
  els.chatInput.value = '';
  sendHostChat(text);
});

ShareUtil.bindChatFileDrop(els.chatPanel, (fileName, text, error) => {
  if (error) {
    ShareUtil.appendChatLine(els.chatLog, '안내', error, '');
    return;
  }
  if (!shareClient) {
    ShareUtil.appendChatLine(els.chatLog, '안내', '공유가 켜진 뒤에 파일을 놓으세요.', '');
    return;
  }
  const sendError = shareClient.sendFile(fileName, text);
  if (sendError) {
    ShareUtil.appendChatLine(els.chatLog, '안내', sendError, '');
  }
});

if (els.cmdForm) {
  els.cmdForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = els.panelCmd.value;
    els.panelCmd.value = '';
    sendConsoleCommand(text);
  });
}

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

for (const select of [els.baud, els.dataBits, els.parity, els.stopBits]) {
  select.addEventListener('change', () => {
    const pane = currentPane();
    if (!pane || !pane.isOpen) {
      return;
    }
    pane.reconnect().catch((err) => {
      pane.term.writeln(`\x1b[31m[재연결 실패] ${toErrorMessage(err)}\x1b[0m`);
    });
  });
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
    target?.term.writeln('\x1b[33m[안내] 이 브라우저는 클립보드 붙여넣기를 지원하지 않습니다.\x1b[0m');
    return;
  }

  navigator.clipboard.readText().then((text) => {
    sendPastedText(text, target);
  }).catch((err) => {
    target?.term.writeln(`\x1b[31m[붙여넣기 실패] ${err.message}\x1b[0m`);
  });
}

function sendPastedText(text, pane) {
  const target = pane || currentPane();
  if (!text || !target) {
    return;
  }
  if (!target.isOpen) {
    target.term.writeln('\x1b[33m[안내] 먼저 장비를 연결하세요.\x1b[0m');
    return;
  }
  target.writeRaw(text);
  target.collectTyped(text);
}

async function connect() {
  await currentPane().connect();
}

async function disconnect() {
  const pane = currentPane();
  if (!pane) {
    return;
  }
  if (shareClient && panes.filter((item) => item.isOpen).length <= 1) {
    stopShare();
  }
  await pane.disconnect();
}

async function handleDisconnected(pane, reason) {
  await pane.handleUnplug(reason);
}

async function pickLogFile() {
  const pane = currentPane();
  const suggested = safeAgingFileName(pane.title);
  await pane.agingLog.pickSaveFile(suggested);
  pane.term.writeln('');
  pane.term.writeln(
    `\x1b[32m[이상로그] ${pane.title} 저장 파일: ${pane.agingLog.saveTargetName()}. 바탕화면에도 지정할 수 있습니다.\x1b[0m`
  );
}

async function pickLogFolder() {
  const pane = currentPane();
  await pane.agingLog.pickDirectory();
  pane.term.writeln('');
  pane.term.writeln(
    `\x1b[32m[이상로그] ${pane.title} 저장 폴더: ${pane.agingLog.saveTargetName()}. 바탕화면/문서/다운로드 폴더 자체는 Chrome이 막습니다.\x1b[0m`
  );
}

async function toggleLogWatch() {
  const pane = currentPane();
  if (!els.logWatch.checked) {
    pane.agingLog.setEnabled(false);
    return;
  }

  pane.agingLog.setKeywords(els.logKeywords ? els.logKeywords.value : pane.agingLog.getKeywordText());
  if (!pane.agingLog.hasSaveTarget()) {
    await pane.agingLog.pickSaveFile(safeAgingFileName(pane.title));
  }
  pane.agingLog.setEnabled(true);
  await requestNotifyPermission();
  pane.term.writeln('');
  pane.term.writeln(`\x1b[33m[이상로그] ${pane.title} 감시 중입니다. 페이지를 열어 둔 채로 두세요.\x1b[0m`);
}

async function requestNotifyPermission() {
  if (typeof Notification === 'undefined') {
    return;
  }
  if (Notification.permission !== 'default') {
    return;
  }
  try {
    await Notification.requestPermission();
  } catch {
    // 권한 요청을 막은 브라우저는 페이지 팝업만 사용
  }
}

function showAbnormalAlert(pane, keyword, fileName, triggerLine, timeText) {
  const title = pane?.title || '장비';
  if (els.alertConsole) {
    els.alertConsole.textContent = title;
  }
  els.alertTime.textContent = `time : ${timeText || ''}`;
  els.alertLine.textContent = triggerLine || keyword;
  els.alertFile.textContent = fileName ? `저장: ${fileName}` : '';
  els.alertModal.hidden = false;
  startTitleBlink();

  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return;
  }

  try {
    const notify = new Notification('이상로그 감지 · ' + title, {
      body: `${timeText || ''}\n${triggerLine || keyword}`,
      requireInteraction: true,
    });
    notify.onclick = () => {
      window.focus();
      notify.close();
    };
  } catch {
    // 일부 환경은 Notification 생성만 실패할 수 있다
  }
}

function safeAgingFileName(title) {
  const name = String(title || '장비')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 20);
  return 'aging-' + (name || 'log') + '.log';
}

function hideAbnormalAlert() {
  els.alertModal.hidden = true;
  stopTitleBlink();
}

function startTitleBlink() {
  stopTitleBlink();
  let mark = false;
  titleBlinkTimer = setInterval(() => {
    document.title = mark ? PAGE_TITLE : '【이상로그】 ' + PAGE_TITLE;
    mark = !mark;
  }, 800);
}

function stopTitleBlink() {
  if (titleBlinkTimer) {
    clearInterval(titleBlinkTimer);
    titleBlinkTimer = null;
  }
  document.title = PAGE_TITLE;
}

function readSerialOptions() {
  return {
    baudRate: Number(els.baud.value),
    dataBits: Number(els.dataBits.value),
    stopBits: Number(els.stopBits.value),
    parity: els.parity.value,
  };
}

function setConnectedUi(pane) {
  const target = pane || currentPane();
  if (!target) {
    return;
  }
  if (target.isOpen) {
    setStatus(true, target.portLabel());
  } else {
    setStatus(false, '연결 안 됨');
  }
  setButtonState(target.isOpen);
}

function setButtonState(connected) {
  els.connect.disabled = connected || Boolean(getSerialBlockReason());
  els.disconnect.disabled = !connected;
  els.sendCommand.disabled = !connected;
  els.customCommand.disabled = !connected;
  if (els.panelCmd) {
    els.panelCmd.disabled = !connected;
  }
  if (els.panelCmdSend) {
    els.panelCmdSend.disabled = !connected;
  }
  const canShare = anyOpen() && !shareClient && isSharePasswordReady();
  els.shareStart.disabled = !canShare;
  els.shareStop.disabled = !shareClient;
  els.shareCopy.disabled = !shareClient || !shareUrl;
  if (els.shareName) {
    els.shareName.disabled = Boolean(shareClient);
  }
  if (els.sharePass) {
    els.sharePass.readOnly = Boolean(shareClient);
    els.sharePass.disabled = false;
  }
  if (els.sharePassShow) {
    els.sharePassShow.disabled = false;
  }
  if (els.addConsole) {
    els.addConsole.disabled = panes.length >= MAX_PANES;
  }
  if (els.removeConsole) {
    els.removeConsole.disabled = panes.length <= 1 || Boolean(currentPane()?.isOpen);
  }

  const commandButtons = els.quickCommands.querySelectorAll('button');
  for (const button of commandButtons) {
    button.disabled = !connected;
  }
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

/**
 * 터미널에서 Enter 를 친 것과 같이 명령을 보낸다.
 * 개행은 툴바에서 고른 CR / LF / CR+LF 를 따른다.
 */
function sendConsoleCommand(command, options) {
  const text = String(command || '').trim();
  if (!text) {
    return;
  }

  const pane = options?.pane || (options && options.slot ? findPane(options.slot) : null) || currentPane();
  if (!pane || !pane.isOpen) {
    currentPane()?.term.writeln('\x1b[33m[안내] 먼저 보낼 콘솔을 선택하고 장비를 연결하세요.\x1b[0m');
    return;
  }

  pane.writeLine(text);
  if (shareClient && !options?.fromRemote) {
    shareClient.sendCmdLog(text, pane.id);
  }
  if (els.customCommand && els.customCommand.value.trim() === text) {
    els.customCommand.value = '';
  }
  pane.focus();
}

function sendHostChat(text) {
  const body = String(text || '').trim();
  if (!body) {
    return;
  }
  shareClient?.sendChat(body);
}

async function startShare() {
  if (!anyOpen()) {
    currentPane()?.term.writeln('\x1b[33m[안내] 먼저 장비를 연결하세요.\x1b[0m');
    return;
  }
  if (shareClient) {
    return;
  }

  const name = readHostName();
  if (!name) {
    currentPane()?.term.writeln('\x1b[33m[안내] 공유 전에 이름을 입력하세요.\x1b[0m');
    els.shareName?.focus();
    return;
  }
  saveHostName(name);

  const password = readSharePassword();
  const passwordError = ShareUtil.validateSharePassword(password);
  if (passwordError) {
    currentPane()?.term.writeln('\x1b[33m[안내] ' + passwordError + '\x1b[0m');
    els.sharePass?.focus();
    return;
  }

  const room = ShareUtil.makeRoomToken();
  let info = null;
  let shareUrls;

  if (ShareUtil.isLocalRelayOrigin()) {
    try {
      info = await fetchShareInfo();
    } catch (err) {
      currentPane()?.term.writeln('');
      currentPane()?.term.writeln(`\x1b[31m[공유] ${err.message}\x1b[0m`);
      return;
    }

    if (els.shareWan && !String(els.shareWan.value || '').trim()) {
      const autoWanHost = wanHostFromInfo(info);
      if (autoWanHost) {
        els.shareWan.value = autoWanHost;
      }
    }
    shareUrls = allShareUrls(room, info);
  } else {
    shareUrls = [ShareUtil.joinUrlForRoom(room)];
  }

  shareUrl = shareUrls[0];
  els.shareUrl.value = shareUrl;
  if (els.shareGuestBar) {
    els.shareGuestBar.hidden = false;
  }
  renderShareGuests({ guests: [] });
  els.chatPanel.hidden = false;
  els.cmdPanel.hidden = false;
  els.chatLog.textContent = '';
  els.cmdLog.textContent = '';

  shareClient = new ShareClient({
    role: 'host',
    room,
    name,
    password,
  });

  shareClient.onReady = () => {
    const pane = currentPane();
    pane?.term.writeln('');
    pane?.term.writeln('\x1b[32m[공유] 개발팀에 아래 링크와 비밀번호를 같이 보내세요. 이 탭을 닫으면 공유가 끊깁니다.\x1b[0m');
    for (const url of shareUrls) {
      pane?.term.writeln(`\x1b[32m       ${url}\x1b[0m`);
    }
    if (!ShareUtil.isLocalRelayOrigin()) {
      pane?.term.writeln('\x1b[33m[공유] 이 주소만 보내면 됩니다. 이 탭을 닫으면 끊깁니다. 회사망이 P2P 를 막으면 접속이 실패할 수 있습니다.\x1b[0m');
    } else if (info?.wan) {
      pane?.term.writeln('\x1b[33m[공유] UPnP 맨 위 링크는 공유기 밖(다른 자리 사내망) PC 용입니다.\x1b[0m');
      pane?.term.writeln('\x1b[33m       같은 공유기 Wi-Fi/유선에 있는 PC 는 노트북 IP(192.168.…) 링크를 쓰세요. UPnP 주소는 안에서 안 열리는 경우가 많습니다.\x1b[0m');
    } else if (readWanBase(info?.port)) {
      pane?.term.writeln('\x1b[33m[공유] 공유기 사내 IP 링크를 맨 위에 넣었습니다. ipTIME 에서 TCP 8765 를 이 노트북으로 포트포워드 하세요.\x1b[0m');
    } else {
      pane?.term.writeln('\x1b[33m[공유] ipTIME 공유기 뒤라면, 노트북 IP 링크는 같은 허브에서만 열립니다. 공유기 사내 IP 칸에 사내망이 공유기에 준 주소를 적으세요.\x1b[0m');
    }
    if (shareUrls.length === 1 && shareUrls[0].indexOf('127.0.0.1') >= 0) {
      pane?.term.writeln('\x1b[33m[공유] LAN IP 를 찾지 못했습니다. 다른 PC 는 접속하지 못할 수 있습니다.\x1b[0m');
    }
    broadcastConsoles();
    broadcastAllAgingHits();
  };

  shareClient.onCmd = (text, from, slot) => {
    if (!shareClient.guestMayCmd(from)) {
      return;
    }
    const pane = panes.find((item) => item.id === String(slot || '1'));
    if (!pane || !pane.isOpen) {
      return;
    }
    pane.term.writeln('');
    pane.term.writeln(`\x1b[33m[원격 ${from}] ${text}\x1b[0m`);
    shareClient.sendLog(`\n[원격 ${from}] ${text}\n`, pane.id);
    sendConsoleCommand(text, { fromRemote: true, pane });
  };

  shareClient.onKeys = (text, from, slot) => {
    if (!shareClient.guestMayCmd(from)) {
      return;
    }
    const pane = panes.find((item) => item.id === String(slot || '1'));
    pane?.writeKeys(text);
  };

  shareClient.onChat = (text, from) => {
    ShareUtil.appendChatLine(els.chatLog, from, text, shareClient.name);
  };

  shareClient.onFile = (fileName, content, from) => {
    ShareUtil.appendChatFile(els.chatLog, from, fileName, content, shareClient.name);
  };

  shareClient.onCmdLog = (text, from, slot) => {
    const title = findPane(slot)?.title || ('장비 ' + slot);
    ShareUtil.appendCmdLine(els.cmdLog, from, '[' + title + '] ' + text, shareClient.name);
  };

  shareClient.onRename = (title, slot) => {
    const pane = findPane(slot);
    if (!pane) {
      return;
    }
    pane.setTitle(title);
    broadcastConsoles();
  };

  shareClient.onPeers = (info) => {
    els.sharePeers.textContent = ShareUtil.peerSummary(info);
    renderShareGuests(info);
  };

  shareClient.onError = (message) => {
    currentPane()?.term.writeln('');
    currentPane()?.term.writeln(`\x1b[31m[공유] ${message}\x1b[0m`);
    stopShare();
  };

  shareClient.onClosed = (message) => {
    if (!shareClient) {
      return;
    }
    currentPane()?.term.writeln('');
    currentPane()?.term.writeln(`\x1b[33m[공유] ${message}\x1b[0m`);
    stopShare();
  };

  shareClient.connect();
  setButtonState(currentPane()?.isOpen);
}

function stopShare(message) {
  const client = shareClient;
  shareClient = null;
  shareUrl = '';
  client?.disconnect();

  els.shareUrl.value = '';
  if (els.shareGuestBar) {
    els.shareGuestBar.hidden = true;
  }
  renderShareGuests({ guests: [] });
  els.chatPanel.hidden = true;
  els.cmdPanel.hidden = true;
  els.sharePeers.textContent = '접속 0명';
  setButtonState(currentPane()?.isOpen);

  if (message) {
    const pane = currentPane();
    pane?.term.writeln('');
    pane?.term.writeln(`\x1b[33m[공유] ${message}\x1b[0m`);
  }
}

async function fetchShareInfo() {
  const response = await fetch('/api/info', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(
      '중계가 없는 예전 서버입니다. 연결.bat 을 다시 실행한 뒤, 이 페이지를 새로 고침하세요.'
    );
  }
  return response.json();
}

function allShareUrls(room, info) {
  const path = `/join.html?room=${encodeURIComponent(room)}`;
  const port = info?.port || 8765;
  const wan = readWanBase(port);
  const autoWan = parseShareBase(info?.wan, port);
  const urls = [].concat(info?.urls || []).filter(Boolean);
  const bases = [];

  if (wan) {
    bases.push(wan);
  }
  if (autoWan && bases.indexOf(autoWan) < 0) {
    bases.push(autoWan);
  }
  for (const url of urls) {
    const base = parseShareBase(url, port);
    if (base && bases.indexOf(base) < 0) {
      bases.push(base);
    }
  }
  if (bases.length === 0) {
    bases.push(parseShareBase(info?.local, port) || location.origin);
  }
  return bases.map((base) => `${String(base).replace(/\/$/, '')}${path}`);
}

function wanHostFromInfo(info) {
  return hostFromShareText(info?.wan);
}

/**
 * COM 잔여 문자(System.__ComObject)가 섞여도 IPv4만 골라낸다.
 */
function hostFromShareText(raw) {
  const text = String(raw || '').trim();
  if (!text) {
    return '';
  }
  const ipMatch = text.match(/(?:\d{1,3}\.){3}\d{1,3}/);
  if (ipMatch) {
    return ipMatch[0];
  }
  const host = text.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
  if (!host || /\s/.test(host) || /comobject/i.test(host)) {
    return '';
  }
  return host;
}

function parseShareBase(raw, port) {
  const host = hostFromShareText(raw);
  if (!host) {
    return '';
  }
  const text = String(raw || '');
  const portMatch = text.match(/:(\d{2,5})/);
  const usePort = portMatch ? portMatch[1] : port || 8765;
  return `http://${host}:${usePort}`;
}

/**
 * ipTIME 이 사내망에서 받은 주소. 노트북이 공유기에서 받은 주소가 아니다.
 */
function readWanBase(port) {
  return parseShareBase(els.shareWan?.value, port);
}

function copyShareUrl() {
  if (!shareUrl) {
    return;
  }

  els.shareUrl.select();
  const done = navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText(shareUrl)
    : Promise.reject();

  done.then(() => {
    currentPane()?.term.writeln('\x1b[32m[공유] 링크를 복사했습니다.\x1b[0m');
  }).catch(() => {
    try {
      document.execCommand('copy');
      currentPane()?.term.writeln('\x1b[32m[공유] 링크를 복사했습니다.\x1b[0m');
    } catch {
      currentPane()?.term.writeln('\x1b[33m[공유] 복사에 실패했습니다. 입력칸의 URL 을 직접 복사하세요.\x1b[0m');
    }
  });
}

function setStatus(connected, text) {
  els.statusDot.classList.toggle('connected', connected);
  els.statusText.textContent = text;
}

/**
 * xterm 은 Enter 를 \r 로 보낸다.
 * 붙여넣기의 \n / \r\n 도 선택한 개행으로 맞춘다.
 */
function applyNewline(data, mode) {
  const normalized = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (mode === 'lf') {
    return normalized;
  }
  if (mode === 'crlf') {
    return normalized.replace(/\n/g, '\r\n');
  }
  return normalized.replace(/\n/g, '\r');
}

function echoLocal(pane, payload) {
  const target = pane || currentPane();
  if (!target) {
    return;
  }
  const visible = payload
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '\r\n');
  target.term.write(visible);
}

function isUserCancel(err) {
  return err?.name === 'NotFoundError' || err?.name === 'AbortError';
}

function toSaveLocationError(err) {
  const message = err?.message || String(err);

  if (
    err?.name === 'SecurityError' ||
    /system files|시스템 파일|cannot be opened|열 수 없/i.test(message)
  ) {
    return '바탕화면·문서·다운로드 폴더 자체는 Chrome이 막습니다. [저장 파일]로 바탕화면에 .log 를 지정하거나, 그 안에 새 폴더를 만든 뒤 [저장 폴더]로 고르세요.';
  }

  return message;
}

function readHostName() {
  return String(els.shareName?.value || '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

function readSharePassword() {
  return String(els.sharePass?.value || '');
}

function isSharePasswordReady() {
  return ShareUtil.validateSharePassword(readSharePassword()) === '';
}

function updateSharePasswordHint() {
  if (!els.sharePassHint) {
    return;
  }
  const typed = readSharePassword();
  if (!typed) {
    els.sharePassHint.textContent = ShareUtil.SHARE_PASSWORD_HINT;
    els.sharePassHint.classList.remove('ok', 'bad');
    return;
  }
  const error = ShareUtil.validateSharePassword(typed);
  if (error) {
    els.sharePassHint.textContent = error;
    els.sharePassHint.classList.add('bad');
    els.sharePassHint.classList.remove('ok');
    return;
  }
  els.sharePassHint.textContent = '비밀번호 조건을 만족합니다.';
  els.sharePassHint.classList.add('ok');
  els.sharePassHint.classList.remove('bad');
}

function renderShareGuests(info) {
  const listEl = els.shareGuestList;
  if (!listEl) {
    return;
  }

  const guests = ShareUtil.guestListFromPeers(info);
  listEl.textContent = '';
  if (!guests.length) {
    const empty = document.createElement('span');
    empty.className = 'share-guest-empty';
    empty.textContent = '아직 입장한 사람이 없습니다.';
    listEl.appendChild(empty);
    return;
  }

  for (const guest of guests) {
    const label = document.createElement('label');
    label.className = 'share-guest-item' + (guest.canCmd ? ' has-cmd' : '');

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = guest.canCmd;
    check.disabled = !guest.id;
    check.title = guest.canCmd ? '명령을 허용 중입니다. 끄면 채팅만 됩니다.' : '켜면 이 사람이 장비에 명령을 넣을 수 있습니다.';
    check.addEventListener('change', () => {
      shareClient?.sendAllowCmd(guest.id, check.checked);
    });

    const name = document.createElement('span');
    name.textContent = guest.name + (guest.canCmd ? ' · 명령' : ' · 채팅만');

    label.appendChild(check);
    label.appendChild(name);
    listEl.appendChild(label);
  }
}

function saveHostName(name) {
  try {
    localStorage.setItem(SHARE_NAME_KEY, name);
  } catch {
    // 저장 실패는 공유에 영향 없다
  }
}

function getSerialBlockReason() {
  if ('serial' in navigator) {
    return null;
  }

  if (location.protocol === 'file:') {
    return 'HTML 파일을 직접 열면 COM 을 열 수 없습니다. 연결.bat 을 실행하거나 https:// 로 열어 주세요.';
  }

  if (!window.isSecureContext) {
    return 'http:// 에서는 COM 을 열 수 없습니다. https:// 또는 http://127.0.0.1 로 열어 주세요.';
  }

  return '이 브라우저는 Web Serial API를 지원하지 않습니다. Chrome 또는 Edge에서 열어 주세요.';
}

function toErrorMessage(err) {
  const message = err?.message || String(err);

  if (/failed to open|access denied|busy|in use/i.test(message)) {
    return `${message}  (같은 COM 을 Tera Term 등이 잡고 있으면 종료하세요. 선택 목록에 예전에 쓴 FTDI 가 남아 있으면 지금 꽂힌 포트를 고르세요)`;
  }

  return message;
}
