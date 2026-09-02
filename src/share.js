/**
 * 시험 PC 중계 서버와 붙는 공유 클라이언트.
 * host(시험팀): WebSocket. guest(개발팀): HTTP 폴링.
 * 공유기 NAT 뒤에서 WebSocket 프레임이 막혀도 join.html 과 같은 HTTP 로 방에 들어간다.
 */
(function (global) {
  const ROOM_KEY = 'share-room';

  class ShareClient {
    constructor(options) {
      this.role = options.role;
      this.room = options.room;
      this.name = options.name || (options.role === 'host' ? '시험팀' : '개발팀');
      this.socket = null;
      this.sid = '';
      this.transport = '';
      this.connected = false;

      this.onLog = null;
      this.onCmd = null;
      this.onKeys = null;
      this.onChat = null;
      this.onCmdLog = null;
      this.onConsoles = null;
      this.onRename = null;
      this.onPeers = null;
      this.onHistory = null;
      this.onError = null;
      this.onClosed = null;
      this.onReady = null;
      this.onOpen = null;
    }

    get isHost() {
      return this.role === 'host';
    }

    get isLive() {
      if (this.failed || this.intentionalClose) {
        return false;
      }
      if (this.transport === 'http') {
        return this.connected && Boolean(this.sid);
      }
      return Boolean(this.socket) && this.socket.readyState === WebSocket.OPEN;
    }

    connect() {
      this.disconnect();

      this.failed = false;
      this.intentionalClose = false;
      this.sid = '';
      this.transport = '';

      if (this.role === 'guest') {
        this.connectHttp();
        return;
      }

      this.connectWs();
    }

    connectWs() {
      this.transport = 'ws';
      const url = websocketUrl();
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.addEventListener('open', () => {
        this.send({
          type: 'hello',
          role: this.role,
          room: this.room,
          name: this.name,
        });
        this.onOpen?.();
        this.readyTimer = setTimeout(() => {
          if (this.connected || this.failed || this.intentionalClose) {
            return;
          }
          this.failed = true;
          this.onError?.(
            '웹 페이지는 열렸지만 공유 방에는 들어가지 못했습니다. 시험팀 연결.bat 창에 [ws] host 로그가 있는지 확인하세요.'
          );
        }, 8000);
      });

      socket.addEventListener('message', (event) => {
        this.handleMessage(event.data);
      });

      socket.addEventListener('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.socket = null;
        if (this.intentionalClose || this.failed) {
          return;
        }
        if (wasConnected) {
          this.onClosed?.('연결이 끊어졌습니다.');
          return;
        }
        this.failed = true;
        this.onError?.(
          '중계 서버에 연결하지 못했습니다. 연결.bat 창을 닫고 다시 실행한 뒤, 이 페이지를 새로 고침하세요.'
        );
      });

      socket.addEventListener('error', () => {
        if (this.intentionalClose || this.failed) {
          return;
        }
        this.failed = true;
        this.onError?.(
          '중계 서버에 연결하지 못했습니다. 연결.bat 창을 닫고 다시 실행한 뒤, 이 페이지를 새로 고침하세요.'
        );
      });
    }

    async connectHttp() {
      this.transport = 'http';
      this.onOpen?.();

      try {
        const res = await fetch('/api/share/hello', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({
            type: 'hello',
            role: 'guest',
            room: this.room,
            name: this.name,
          }),
        });
        const data = await res.json();
        if (this.intentionalClose) {
          return;
        }
        if (data.error) {
          this.failed = true;
          this.onError?.(data.error);
          return;
        }

        this.sid = data.sid || '';
        if (data.name) {
          this.name = data.name;
        }
        this.applyHttpEvents(data.events);
        this.pollHttp();
      } catch {
        if (this.intentionalClose || this.failed) {
          return;
        }
        this.failed = true;
        this.onError?.(
          '중계 서버에 연결하지 못했습니다. 연결.bat 창을 닫고 다시 실행한 뒤, 이 페이지를 새로 고침하세요.'
        );
      }
    }

    async pollHttp() {
      while (this.transport === 'http' && this.sid && !this.intentionalClose && !this.failed) {
        try {
          const res = await fetch('/api/share/wait?sid=' + encodeURIComponent(this.sid), {
            cache: 'no-store',
          });
          const data = await res.json();
          if (this.intentionalClose) {
            return;
          }
          if (data.error) {
            this.failed = true;
            this.connected = false;
            this.onError?.(data.error);
            return;
          }
          this.applyHttpEvents(data.events);
          if (data.closed) {
            return;
          }
        } catch {
          if (this.intentionalClose || this.failed) {
            return;
          }
          await sleepMs(1000);
        }
      }
    }

    applyHttpEvents(events) {
      if (!Array.isArray(events)) {
        return;
      }
      for (const event of events) {
        if (typeof event === 'string') {
          this.handleMessage(event);
        } else if (event && typeof event === 'object') {
          this.handleMessage(event);
        }
      }
    }

    handleMessage(raw) {
      if (raw instanceof Blob) {
        raw.text().then((text) => this.handleMessage(text));
        return;
      }
      if (raw instanceof ArrayBuffer) {
        this.handleMessage(new TextDecoder('utf-8').decode(raw));
        return;
      }
      if (typeof raw === 'object' && raw) {
        this.dispatchMessage(raw);
        return;
      }
      if (typeof raw !== 'string') {
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      this.dispatchMessage(msg);
    }

    dispatchMessage(msg) {
      if (!msg) {
        return;
      }

      const type = msg.type;
      if (type === 'error') {
        this.failed = true;
        if (this.readyTimer) {
          clearTimeout(this.readyTimer);
          this.readyTimer = null;
        }
        this.onError?.(msg.message || '중계 오류');
        return;
      }
      if (type === 'welcome' || type === 'peers') {
        this.markReady();
        if (type === 'peers') {
          this.onPeers?.(msg);
        }
        return;
      }
      if (type === 'log') {
        this.markReady();
        this.onLog?.(msg.text || '', msg.slot || '1');
        return;
      }
      if (type === 'history') {
        this.markReady();
        this.onHistory?.(msg.text || '', msg.slot || '1');
        return;
      }
      if (type === 'cmd') {
        this.onCmd?.(msg.text || '', msg.from || '', msg.slot || '1');
        return;
      }
      if (type === 'keys') {
        this.onKeys?.(msg.text || '', msg.from || '', msg.slot || '1');
        return;
      }
      if (type === 'chat') {
        this.onChat?.(msg.text || '', msg.from || '');
        return;
      }
      if (type === 'cmdlog') {
        this.onCmdLog?.(msg.text || '', msg.from || '', msg.slot || '1');
        return;
      }
      if (type === 'consoles') {
        this.onConsoles?.(msg.text || '');
        return;
      }
      if (type === 'rename') {
        this.onRename?.(msg.text || '', msg.slot || '1');
        return;
      }
      if (type === 'closed') {
        this.connected = false;
        this.sid = '';
        this.onClosed?.(msg.message || '공유가 종료되었습니다.');
      }
    }

    markReady() {
      const first = !this.connected;
      this.connected = true;
      if (this.readyTimer) {
        clearTimeout(this.readyTimer);
        this.readyTimer = null;
      }
      if (first) {
        this.onReady?.();
      }
    }

    sendLog(text, slot) {
      if (!text || !this.isHost) {
        return;
      }
      this.send({ type: 'log', text, slot: slot || '1' });
    }

    sendCmd(text, slot) {
      if (!text) {
        return;
      }
      this.send({ type: 'cmd', text, slot: slot || '1' });
    }

    sendKeys(text, slot) {
      if (!text) {
        return;
      }
      this.send({ type: 'keys', text, slot: slot || '1' });
    }

    sendChat(text) {
      const body = String(text || '').trim();
      if (!body) {
        return;
      }
      this.send({ type: 'chat', text: body });
    }

    sendCmdLog(text, slot) {
      if (!text) {
        return;
      }
      this.send({ type: 'cmdlog', text, slot: slot || '1' });
    }

    sendConsoles(text) {
      if (!this.isHost) {
        return;
      }
      this.send({ type: 'consoles', text: text || '' });
    }

    sendRename(slot, title) {
      const name = String(title || '').replace(/[\t\n\r]/g, '').trim().slice(0, 20);
      if (!name) {
        return;
      }
      this.send({ type: 'rename', slot: slot || '1', text: name });
    }

    send(payload) {
      if (!payload) {
        return;
      }
      if (this.transport === 'http') {
        this.sendHttp(payload);
        return;
      }
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return;
      }
      this.socket.send(JSON.stringify(payload));
    }

    sendHttp(payload) {
      if (!this.sid || this.failed || this.intentionalClose) {
        return;
      }
      const body = Object.assign({ sid: this.sid }, payload);
      fetch('/api/share/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body),
      }).catch(() => {
        // 다음 poll 에서 세션 오류를 받는다
      });
    }

    disconnect() {
      const socket = this.socket;
      const sid = this.sid;
      const wasHttp = this.transport === 'http';
      this.intentionalClose = true;
      this.socket = null;
      this.sid = '';
      this.connected = false;
      if (this.readyTimer) {
        clearTimeout(this.readyTimer);
        this.readyTimer = null;
      }
      if (wasHttp && sid) {
        fetch('/api/share/bye?sid=' + encodeURIComponent(sid), {
          method: 'POST',
          cache: 'no-store',
        }).catch(() => {
          // 닫는 중
        });
      }
      if (!socket) {
        return;
      }
      try {
        socket.close();
      } catch {
        // already closed
      }
    }
  }

  function sleepMs(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function websocketUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
  }

  function makeRoomToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function roomFromLocation() {
    const params = new URLSearchParams(location.search);
    return (params.get('room') || '').trim();
  }

  function appendChatLine(logEl, from, text, myName, kind) {
    if (!logEl) {
      return;
    }

    const mine = Boolean(myName) && from === myName;
    const row = document.createElement('div');
    row.className = mine ? 'chat-row chat-row-mine' : 'chat-row chat-row-other';
    if (kind === 'cmd') {
      row.classList.add('chat-row-cmd');
    }

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';

    const nameEl = document.createElement('span');
    nameEl.className = 'chat-from';
    nameEl.textContent = mine ? '나' : from || '?';
    bubble.appendChild(nameEl);

    const body = document.createElement('p');
    body.className = 'chat-text';
    body.textContent = text || '';
    bubble.appendChild(body);

    row.appendChild(bubble);
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function appendCmdLine(logEl, from, text, myName) {
    appendChatLine(logEl, from, text, myName, 'cmd');
  }

  /**
   * 터미널 키 입력을 줄 단위로 모은다.
   * Enter 로 확정된 줄만 돌려 주고, Backspace / Ctrl+C 는 줄 내용만 고친다.
   */
  class TypedLineBuffer {
    constructor() {
      this.buf = '';
      this.skipLf = false;
    }

    push(chunk) {
      const clean = String(chunk || '')
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/\x1b./g, '');
      const lines = [];

      for (var i = 0; i < clean.length; i++) {
        const ch = clean.charAt(i);
        if (ch === '\r' || ch === '\n') {
          if (ch === '\n' && this.skipLf) {
            this.skipLf = false;
            continue;
          }
          this.skipLf = ch === '\r';
          const line = this.buf.replace(/\s+$/g, '');
          this.buf = '';
          if (line) {
            lines.push(line.length > 200 ? line.slice(0, 200) : line);
          }
          continue;
        }

        this.skipLf = false;
        if (ch === '\x7f' || ch === '\b') {
          this.buf = this.buf.slice(0, -1);
          continue;
        }
        if (ch === '\x03') {
          this.buf = '';
          continue;
        }
        if (ch === '\t') {
          if (this.buf.length < 200) {
            this.buf += ch;
          }
          continue;
        }
        if (ch < ' ') {
          continue;
        }
        if (this.buf.length < 200) {
          this.buf += ch;
        }
      }

      return lines;
    }
  }

  function encodeConsoles(list) {
    const rows = [];
    for (const item of list || []) {
      const id = String(item.id || '').replace(/[\t\n]/g, '');
      const title = String(item.title || '').replace(/[\t\n]/g, '');
      if (!id) {
        continue;
      }
      rows.push(id + '\t' + title + '\t' + (item.open ? '1' : '0'));
    }
    return rows.join('\n');
  }

  function decodeConsoles(text) {
    const list = [];
    const rows = String(text || '').split('\n');
    for (const row of rows) {
      if (!row) {
        continue;
      }
      const parts = row.split('\t');
      if (!parts[0]) {
        continue;
      }
      list.push({
        id: parts[0],
        title: parts[1] || ('장비 ' + parts[0]),
        open: parts[2] === '1',
      });
    }
    return list;
  }

  function peerSummary(info) {
    const guests = Array.isArray(info?.guests) ? info.guests : [];
    const count = Number(info?.guestCount ?? guests.length);
    if (count <= 0) {
      return '접속 0명';
    }
    return `접속 ${count}명 (${guests.join(', ')})`;
  }

  /**
   * 연결.bat 이 연 주소만 중계(/api, /ws)가 있다.
   * GitHub Pages 등 정적 호스팅은 COM 만 되고 공유는 불가.
   */
  function isLocalRelayOrigin() {
    const host = String(location.hostname || '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  }

  global.ShareClient = ShareClient;
  global.ShareUtil = {
    makeRoomToken,
    roomFromLocation,
    appendChatLine,
    appendCmdLine,
    TypedLineBuffer,
    encodeConsoles,
    decodeConsoles,
    peerSummary,
    isLocalRelayOrigin,
    ROOM_KEY,
  };
})(window);
