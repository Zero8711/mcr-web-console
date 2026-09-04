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
      this.sharePassword = String(options.password || '');
      this.lockId = String(options.lockId || '');
      this.passGuards = {};
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
      this.onPerm = null;
      this.onAging = null;
      this.onFile = null;
      this.canCmd = false;
      this.lastGuests = [];
      this.lastAging = {};
      this.lastFiles = [];
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
      if (this.transport === 'webrtc') {
        if (this.isHost) {
          return this.connected && Boolean(this.peer) && !this.peer.destroyed;
        }
        return this.connected && Boolean(this.rtcHostConn) && this.rtcHostConn.open;
      }
      return Boolean(this.socket) && this.socket.readyState === WebSocket.OPEN;
    }

    connect() {
      this.disconnect();

      this.failed = false;
      this.intentionalClose = false;
      this.sid = '';
      this.transport = '';
      this.rtcGuests = [];
      this.rtcHostConn = null;
      this.lastConsoles = '';
      this.lastAging = {};
      this.lastFiles = [];
      this.canCmd = false;
      this.lastGuests = [];

      if (!isLocalRelayOrigin()) {
        this.connectWebRtc();
        return;
      }

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
        this.send(this.helloPayload());
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
          body: JSON.stringify(this.helloPayload()),
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
      if (type === 'welcome') {
        if (msg.id && !this.isHost) {
          this.sid = msg.id;
        }
        this.markReady();
        return;
      }
      if (type === 'peers') {
        this.markReady();
        this.lastGuests = guestListFromPeers(msg);
        this.applyMyPerm(msg);
        this.onPeers?.(msg);
        return;
      }
      if (type === 'perm') {
        this.setCanCmd(msg.text === '1');
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
      if (type === 'aging') {
        this.onAging?.(msg.name || '', msg.slot || '1', msg.text || '');
        return;
      }
      if (type === 'file') {
        this.onFile?.(msg.name || '', msg.text || '', msg.from || '');
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
      if (!text || !this.maySendCommand()) {
        return;
      }
      this.send({ type: 'cmd', text, slot: slot || '1' });
    }

    sendKeys(text, slot) {
      if (!text || !this.maySendCommand()) {
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
      if (!this.isHost && !this.maySendCommand()) {
        return;
      }
      this.send({ type: 'cmdlog', text, slot: slot || '1' });
    }

    sendAllowCmd(guestId, allow) {
      if (!this.isHost || !guestId) {
        return;
      }
      const on = Boolean(allow);
      const item = this.lastGuests.find((guest) => guest.id === guestId);
      if (item) {
        item.canCmd = on;
      }
      if (this.transport === 'webrtc') {
        this.setRtcGuestAllow(guestId, on);
        return;
      }
      this.send({ type: 'allowcmd', id: guestId, text: on ? '1' : '0' });
    }

    maySendCommand() {
      return this.isHost || this.canCmd;
    }

    guestMayCmd(name) {
      const item = this.lastGuests.find((guest) => guest.name === name);
      return Boolean(item && item.canCmd);
    }

    applyMyPerm(msg) {
      if (this.isHost) {
        return;
      }
      const ids = Array.isArray(msg.guestIds) ? msg.guestIds : [];
      const flags = Array.isArray(msg.guestCanCmd) ? msg.guestCanCmd : [];
      const index = ids.indexOf(this.sid);
      this.setCanCmd(index >= 0 && String(flags[index]) === '1');
    }

    setCanCmd(allowed) {
      const next = Boolean(allowed);
      const changed = next !== this.canCmd;
      this.canCmd = next;
      if (changed || this.onPerm) {
        this.onPerm?.(this.canCmd);
      }
    }

    setRtcGuestAllow(guestId, allow) {
      const guest = this.rtcGuests.find((item) => item.id === guestId);
      if (!guest) {
        return;
      }
      guest.canCmd = Boolean(allow);
      this.sendRtcTo(guest.conn, { type: 'perm', text: guest.canCmd ? '1' : '0' });
      this.emitRtcPeers();
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

    sendAging(kind, slot, text) {
      if (!this.isHost) {
        return;
      }
      this.send({
        type: 'aging',
        name: String(kind || 'hits'),
        slot: slot || '1',
        text: text || '',
      });
    }

    sendFile(fileName, text) {
      const name = sanitizeShareFileName(fileName);
      const body = String(text || '');
      if (!name || !body) {
        return '빈 파일은 보낼 수 없습니다.';
      }
      if (utf8ByteLength(body) > MAX_SHARE_FILE_BYTES) {
        return '파일이 너무 큽니다. 450KB 이하만 채팅으로 보낼 수 있습니다.';
      }
      this.send({ type: 'file', name, text: body });
      return '';
    }

    rememberFile(payload) {
      const item = {
        type: 'file',
        name: sanitizeShareFileName(payload?.name),
        text: String(payload?.text || ''),
        from: String(payload?.from || this.name || ''),
      };
      if (!item.name || !item.text) {
        return;
      }
      this.lastFiles.push(item);
      while (this.lastFiles.length > MAX_SHARE_FILES_KEEP) {
        this.lastFiles.shift();
      }
    }

    send(payload) {
      if (!payload) {
        return;
      }
      if (payload.type === 'consoles') {
        this.lastConsoles = payload.text || '';
      }
      if (payload.type === 'aging' && payload.name === 'hits') {
        this.lastAging[payload.slot || '1'] = {
          type: 'aging',
          name: 'hits',
          slot: payload.slot || '1',
          text: payload.text || '',
        };
      }
      if (this.transport === 'http') {
        this.sendHttp(payload);
        return;
      }
      if (this.transport === 'webrtc') {
        if (!payload.from && (payload.type === 'chat' || payload.type === 'cmdlog' || payload.type === 'file')) {
          payload = Object.assign({}, payload, { from: this.name });
        }
        if (payload.type === 'file') {
          this.rememberFile(payload);
        }
        this.sendRtc(payload);
        if (this.isHost && (payload.type === 'chat' || payload.type === 'cmdlog' || payload.type === 'file')) {
          this.dispatchMessage(payload);
        }
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
      if (this.peer) {
        try {
          this.peer.destroy();
        } catch {
          // already closed
        }
        this.peer = null;
      }
      this.rtcGuests = [];
      this.rtcHostConn = null;
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

    /**
     * GitHub Pages 등 정적 호스팅에서는 로컬 중계가 없다.
     * 시험팀 브라우저가 방이 되고, 개발팀은 WebRTC 로 붙는다.
     */
    connectWebRtc() {
      this.transport = 'webrtc';
      if (typeof global.Peer !== 'function') {
        this.failed = true;
        this.onError?.('공유 라이브러리(PeerJS)를 불러오지 못했습니다. 페이지를 새로 고침하세요.');
        return;
      }

      this.onOpen?.();
      const peerId = this.isHost ? webRtcHostId(this.room) : undefined;
      const peer = new global.Peer(peerId, webRtcPeerOptions());
      this.peer = peer;

      this.readyTimer = setTimeout(() => {
        if (this.connected || this.failed || this.intentionalClose) {
          return;
        }
        this.failed = true;
        this.onError?.(
          '공유 방에 들어가지 못했습니다. 시험팀 탭이 열려 있는지 확인하세요. 사내망 PC만 안 되고 핸드폰은 되면, 회사 방화벽이 P2P를 막은 것입니다.'
        );
        try {
          peer.destroy();
        } catch {
          // ignore
        }
      }, 35000);

      peer.on('error', (err) => {
        if (this.intentionalClose || this.failed) {
          return;
        }
        this.failed = true;
        const text = err?.type === 'unavailable-id'
          ? '같은 방 토큰이 이미 사용 중입니다. 공유를 다시 시작하세요.'
          : '브라우저 간 공유에 실패했습니다. 방화벽이 P2P 를 막으면 접속되지 않습니다.';
        this.onError?.(text);
      });

      peer.on('open', () => {
        if (this.intentionalClose) {
          return;
        }
        if (this.isHost) {
          this.markReady();
          this.emitRtcPeers();
          return;
        }
        this.openRtcGuestLink();
      });

      if (this.isHost) {
        peer.on('connection', (conn) => {
          this.acceptRtcGuest(conn);
        });
      }
    }

    openRtcGuestLink() {
      const conn = this.peer.connect(webRtcHostId(this.room), {
        reliable: true,
        metadata: { name: this.name },
      });
      this.rtcHostConn = conn;

      conn.on('open', () => {
        if (this.intentionalClose) {
          return;
        }
        this.sendRtc(this.helloPayload());
      });

      conn.on('data', (data) => {
        this.handleMessage(data);
      });

      conn.on('close', () => {
        if (this.intentionalClose || this.failed) {
          return;
        }
        this.connected = false;
        this.onClosed?.('시험팀 공유가 종료되었습니다.');
      });

      conn.on('error', () => {
        if (this.intentionalClose || this.failed) {
          return;
        }
        this.failed = true;
        this.onError?.('시험팀 탭에 연결하지 못했습니다. 공유가 켜져 있는지 확인하세요.');
      });
    }

    acceptRtcGuest(conn) {
      if (this.rtcGuests.length >= 20) {
        try {
          conn.close();
        } catch {
          // ignore
        }
        return;
      }

      let admitted = false;
      const helloTimer = setTimeout(() => {
        if (!admitted && !this.intentionalClose) {
          this.rejectRtcConn(conn, '접속 시간이 초과되었습니다. 다시 접속하세요.');
        }
      }, 12000);

      conn.on('data', (data) => {
        if (!admitted) {
          admitted = this.tryAdmitRtcGuest(conn, data, helloTimer);
          return;
        }
        this.handleRtcGuestData(conn, data);
      });

      conn.on('close', () => {
        clearTimeout(helloTimer);
        this.rtcGuests = this.rtcGuests.filter((item) => item.conn !== conn);
        this.emitRtcPeers();
      });
    }

    tryAdmitRtcGuest(conn, data, helloTimer) {
      let msg = data;
      if (typeof data === 'string') {
        try {
          msg = JSON.parse(data);
        } catch {
          return false;
        }
      }
      if (!msg || typeof msg !== 'object' || msg.type !== 'hello') {
        return false;
      }

      const blocked = evaluateGuestPassword(
        this.passGuards,
        msg.lockId,
        this.sharePassword,
        msg.password
      );
      if (blocked) {
        this.rejectRtcConn(conn, blocked);
        return false;
      }

      clearTimeout(helloTimer);
      const name = String(msg.name || conn.metadata?.name || '개발팀')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 20) || '개발팀';
      const id = makeGuestId();
      this.rtcGuests.push({ conn, name, id, canCmd: false });
      this.sendRtcTo(conn, { type: 'welcome', id });
      if (this.lastConsoles) {
        this.sendRtcTo(conn, { type: 'consoles', text: this.lastConsoles });
      }
      for (const item of Object.keys(this.lastAging)) {
        this.sendRtcTo(conn, this.lastAging[item]);
      }
      for (const item of this.lastFiles) {
        this.sendRtcTo(conn, item);
      }
      this.emitRtcPeers();
      return true;
    }

    rejectRtcConn(conn, message) {
      this.sendRtcTo(conn, { type: 'error', message: message || '접속이 거절되었습니다.' });
      try {
        conn.close();
      } catch {
        // ignore
      }
    }

    helloPayload() {
      const payload = {
        type: 'hello',
        role: this.role,
        room: this.room,
        name: this.name,
        password: this.sharePassword,
      };
      if (!this.isHost && this.lockId) {
        payload.lockId = this.lockId;
      }
      return payload;
    }

    handleRtcGuestData(conn, data) {
      let msg = data;
      if (typeof data === 'string') {
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (!msg || typeof msg !== 'object') {
        return;
      }

      if (msg.type === 'hello') {
        const guest = this.rtcGuests.find((item) => item.conn === conn);
        if (guest && msg.name) {
          guest.name = String(msg.name).replace(/\s+/g, ' ').trim().slice(0, 20) || guest.name;
          this.emitRtcPeers();
        }
        return;
      }

      const guest = this.rtcGuests.find((item) => item.conn === conn);
      if (guest) {
        msg = Object.assign({}, msg, { from: guest.name });
      }
      if ((msg.type === 'cmd' || msg.type === 'keys' || msg.type === 'cmdlog') && guest && !guest.canCmd) {
        return;
      }
      if (msg.type === 'allowcmd' || msg.type === 'perm' || msg.type === 'log' || msg.type === 'consoles' || msg.type === 'aging') {
        return;
      }
      if (msg.type === 'file') {
        this.rememberFile(msg);
      }
      this.dispatchMessage(msg);
      if (msg.type === 'chat' || msg.type === 'cmdlog' || msg.type === 'rename' || msg.type === 'file') {
        this.sendRtc(msg);
      }
    }

    sendRtc(payload, exceptConn) {
      const raw = JSON.stringify(payload);
      if (this.isHost) {
        for (const guest of this.rtcGuests) {
          if (exceptConn && guest.conn === exceptConn) {
            continue;
          }
          this.sendRtcRaw(guest.conn, raw);
        }
        return;
      }
      this.sendRtcRaw(this.rtcHostConn, raw);
    }

    sendRtcTo(conn, payload) {
      this.sendRtcRaw(conn, JSON.stringify(payload));
    }

    sendRtcRaw(conn, raw) {
      if (!conn || !conn.open) {
        return;
      }
      try {
        conn.send(raw);
      } catch {
        // 끊긴 상대는 close 에서 정리
      }
    }

    emitRtcPeers() {
      const guests = this.rtcGuests.map((item) => item.name);
      const guestIds = this.rtcGuests.map((item) => item.id);
      const guestCanCmd = this.rtcGuests.map((item) => (item.canCmd ? '1' : '0'));
      const info = { guests, guestIds, guestCanCmd, guestCount: guests.length };
      this.lastGuests = guestListFromPeers(info);
      this.onPeers?.(info);
      this.sendRtc({
        type: 'peers',
        guests,
        guestIds,
        guestCanCmd,
        guestCount: guests.length,
      });
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

  function webRtcHostId(room) {
    return 'mcr' + String(room || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
  }

  function webRtcPeerOptions() {
    const turnAuth = {
      username: 'openrelayproject',
      credential: 'openrelayproject',
    };
    return {
      host: '0.peerjs.com',
      port: 443,
      path: '/',
      secure: true,
      config: {
        iceServers: [
          { urls: 'stun:stun.cloudflare.com:3478' },
          { urls: 'stun:stun.l.google.com:19302' },
          Object.assign({ urls: 'turn:openrelay.metered.ca:80' }, turnAuth),
          Object.assign({ urls: 'turn:openrelay.metered.ca:443' }, turnAuth),
          Object.assign({ urls: 'turn:openrelay.metered.ca:443?transport=tcp' }, turnAuth),
          Object.assign({ urls: 'turns:openrelay.metered.ca:443?transport=tcp' }, turnAuth),
        ],
      },
    };
  }

  function joinUrlForRoom(room) {
    return new URL('join.html?room=' + encodeURIComponent(room), location.href).href;
  }

  function makeRoomToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function makeGuestId() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const SHARE_PASSWORD_HINT = '영문, 숫자, 특수문자를 섞어 8자 이상';

  function validateSharePassword(value) {
    const text = String(value || '');
    if (text.length < 8) {
      return '비밀번호는 8자 이상이어야 합니다.';
    }
    if (text.length > 64) {
      return '비밀번호는 64자까지입니다.';
    }
    if (/\s/.test(text)) {
      return '비밀번호에 공백은 넣을 수 없습니다.';
    }
    if (!/[A-Za-z]/.test(text)) {
      return '영문이 들어가야 합니다.';
    }
    if (!/[0-9]/.test(text)) {
      return '숫자가 들어가야 합니다.';
    }
    if (!/[^A-Za-z0-9]/.test(text)) {
      return '특수문자가 들어가야 합니다.';
    }
    return '';
  }

  function passwordsMatch(expected, given) {
    return Boolean(expected) && given === expected;
  }

  const PASS_FAIL_LIMIT = 5;
  const PASS_LOCK_MS = 60 * 1000;

  function sanitizeLockId(value) {
    const clean = String(value || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
    return clean || 'anon';
  }

  function evaluateGuestPassword(map, lockId, expected, given) {
    const key = sanitizeLockId(lockId);
    const now = Date.now();
    let guard = map[key];
    if (!guard) {
      guard = { fails: 0, lockUntil: 0 };
      map[key] = guard;
    }
    if (guard.lockUntil > now) {
      return '5회 틀렸습니다. 1분 후 다시 시도하세요.';
    }
    if (guard.lockUntil && guard.lockUntil <= now) {
      guard.fails = 0;
      guard.lockUntil = 0;
    }
    if (passwordsMatch(expected, given)) {
      delete map[key];
      return '';
    }
    guard.fails += 1;
    if (guard.fails >= PASS_FAIL_LIMIT) {
      guard.fails = 0;
      guard.lockUntil = now + PASS_LOCK_MS;
      return '5회 틀렸습니다. 1분 후 다시 시도하세요.';
    }
    return '비밀번호가 다릅니다. (남은 횟수 ' + (PASS_FAIL_LIMIT - guard.fails) + ')';
  }

  function passGuardStorageKey(room) {
    return 'share-pass-guard:' + String(room || '');
  }

  function getOrCreatePassGuard(room) {
    let guard = null;
    try {
      const raw = localStorage.getItem(passGuardStorageKey(room));
      if (raw) {
        const data = JSON.parse(raw);
        if (data && data.id) {
          guard = {
            id: sanitizeLockId(data.id) === 'anon' ? '' : sanitizeLockId(data.id),
            fails: Number(data.fails) || 0,
            lockUntil: Number(data.lockUntil) || 0,
          };
        }
      }
    } catch {
      guard = null;
    }
    if (!guard || !guard.id) {
      guard = {
        id: makeGuestId() + makeGuestId(),
        fails: 0,
        lockUntil: 0,
      };
    }
    if (guard.lockUntil && guard.lockUntil <= Date.now()) {
      guard.fails = 0;
      guard.lockUntil = 0;
    }
    savePassGuard(room, guard);
    return guard;
  }

  function savePassGuard(room, guard) {
    try {
      localStorage.setItem(passGuardStorageKey(room), JSON.stringify(guard));
    } catch {
      // 저장 실패해도 이번 탭의 접속은 진행한다
    }
  }

  function storedPassLockMessage(room) {
    const guard = getOrCreatePassGuard(room);
    if (guard.lockUntil > Date.now()) {
      return '5회 틀렸습니다. 1분 후 다시 시도하세요.';
    }
    return '';
  }

  function storedPassRemainMs(room) {
    const guard = getOrCreatePassGuard(room);
    return Math.max(0, guard.lockUntil - Date.now());
  }

  function applyPassErrorLocal(room, message) {
    const text = String(message || '');
    const guard = getOrCreatePassGuard(room);
    if (text.indexOf('1분') >= 0) {
      guard.fails = 0;
      guard.lockUntil = Date.now() + PASS_LOCK_MS;
      savePassGuard(room, guard);
      return;
    }
    const match = text.match(/남은 횟수\s*(\d+)/);
    if (match) {
      guard.fails = Math.max(0, PASS_FAIL_LIMIT - Number(match[1]));
      guard.lockUntil = 0;
      savePassGuard(room, guard);
      return;
    }
    if (text.indexOf('비밀번호가 다릅니다') >= 0) {
      guard.fails += 1;
      if (guard.fails >= PASS_FAIL_LIMIT) {
        guard.fails = 0;
        guard.lockUntil = Date.now() + PASS_LOCK_MS;
      }
      savePassGuard(room, guard);
    }
  }

  function clearStoredPassFails(room) {
    const guard = getOrCreatePassGuard(room);
    guard.fails = 0;
    guard.lockUntil = 0;
    savePassGuard(room, guard);
  }

  function guestListFromPeers(info) {
    const names = Array.isArray(info?.guests) ? info.guests : [];
    const ids = Array.isArray(info?.guestIds) ? info.guestIds : [];
    const flags = Array.isArray(info?.guestCanCmd) ? info.guestCanCmd : [];
    const list = [];
    for (let i = 0; i < names.length; i += 1) {
      list.push({
        id: ids[i] || '',
        name: names[i],
        canCmd: String(flags[i]) === '1',
      });
    }
    return list;
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

  function appendChatFile(logEl, from, fileName, content, myName) {
    if (!logEl) {
      return;
    }

    const mine = Boolean(myName) && from === myName;
    const row = document.createElement('div');
    row.className = mine ? 'chat-row chat-row-mine' : 'chat-row chat-row-other';

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';

    const nameEl = document.createElement('span');
    nameEl.className = 'chat-from';
    nameEl.textContent = mine ? '나' : from || '?';
    bubble.appendChild(nameEl);

    const body = document.createElement('p');
    body.className = 'chat-text chat-file';

    const label = document.createElement('span');
    label.className = 'chat-file-name';
    label.textContent = sanitizeShareFileName(fileName);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn chat-file-btn';
    button.textContent = '다운로드';
    button.addEventListener('click', () => {
      downloadTextFile(fileName, content);
    });

    body.appendChild(label);
    body.appendChild(button);
    bubble.appendChild(body);
    row.appendChild(bubble);
    logEl.appendChild(row);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function downloadTextFile(fileName, content) {
    const blob = new Blob([String(content || '')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = sanitizeShareFileName(fileName);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const MAX_SHARE_FILE_BYTES = 450000;
  const MAX_SHARE_FILES_KEEP = 5;

  function utf8ByteLength(text) {
    return new Blob([String(text || '')]).size;
  }

  function sanitizeShareFileName(value) {
    const raw = String(value || '').replace(/\\/g, '/');
    const base = raw.split('/').pop() || '';
    const clean = base.replace(/[<>:"|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim();
    return clean.slice(0, 80) || 'aging-error.log';
  }

  function bindChatFileDrop(panel, onFile) {
    if (!panel || typeof onFile !== 'function') {
      return;
    }

    const hasFiles = (event) => {
      const types = event.dataTransfer && event.dataTransfer.types;
      return Boolean(types && types.indexOf && types.indexOf('Files') >= 0);
    };

    panel.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      panel.classList.add('chat-drop-over');
    });
    panel.addEventListener('dragover', (event) => {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      panel.classList.add('chat-drop-over');
    });
    panel.addEventListener('dragleave', (event) => {
      if (event.target !== panel && !panel.contains(event.relatedTarget)) {
        panel.classList.remove('chat-drop-over');
      }
      if (event.target === panel) {
        panel.classList.remove('chat-drop-over');
      }
    });
    panel.addEventListener('drop', (event) => {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      panel.classList.remove('chat-drop-over');
      const files = event.dataTransfer && event.dataTransfer.files;
      if (!files || !files.length) {
        return;
      }
      readDroppedShareFiles(files, onFile);
    });
  }

  function readDroppedShareFiles(files, onFile) {
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      if (!file) {
        continue;
      }
      if (file.size > MAX_SHARE_FILE_BYTES) {
        onFile(file.name, '', '파일이 너무 큽니다. 450KB 이하만 채팅으로 보낼 수 있습니다.');
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        if (!text.trim()) {
          onFile(file.name, '', '빈 파일은 보낼 수 없습니다.');
          return;
        }
        if (utf8ByteLength(text) > MAX_SHARE_FILE_BYTES) {
          onFile(file.name, '', '파일이 너무 큽니다. 450KB 이하만 채팅으로 보낼 수 있습니다.');
          return;
        }
        onFile(file.name, text, '');
      };
      reader.onerror = () => {
        onFile(file.name, '', '파일을 읽지 못했습니다.');
      };
      reader.readAsText(file);
    }
  }

  function renderAgingHitList(box, list, options) {
    if (!box) {
      return;
    }

    box.replaceChildren();
    const rows = Array.isArray(list) ? list : [];
    const emptyText = options && options.emptyText
      ? options.emptyText
      : '키워드를 입력하면 발견 횟수가 여기에 쌓입니다.';
    const clearBtn = options && options.clearButton;

    if (!rows.length) {
      const empty = document.createElement('span');
      empty.className = 'aging-hit-empty';
      empty.textContent = emptyText;
      box.appendChild(empty);
      if (clearBtn) {
        clearBtn.disabled = true;
      }
      return;
    }

    let anyHit = false;
    for (const item of rows) {
      const count = Number(item.count) || 0;
      if (count > 0) {
        anyHit = true;
      }

      const chip = document.createElement('span');
      chip.className = 'aging-hit-item' + (count > 0 ? ' has-hit' : '');

      const name = document.createElement('strong');
      name.textContent = item.keyword;

      const last = count > 0 && item.lastTime ? item.lastTime : '-';
      const meta = document.createElement('span');
      meta.textContent = count + '회 · 마지막 ' + last;

      chip.title = item.keyword + '  ' + count + '회  마지막 ' + last;
      chip.appendChild(name);
      chip.appendChild(meta);
      box.appendChild(chip);
    }

    if (clearBtn) {
      clearBtn.disabled = !anyHit;
    }
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
   * 연결.bat 주소는 로컬 TCP 중계.
   * 시험팀 탭은 127.0.0.1 이고, 개발팀은 같은 중계의 사내 IP:8765 로 들어온다.
   * GitHub Pages 만 브라우저 간 WebRTC 를 쓴다.
   */
  function isLocalRelayOrigin() {
    const host = String(location.hostname || '').toLowerCase();
    if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') {
      return true;
    }
    if (host.indexOf('github.io') >= 0) {
      return false;
    }
    return String(location.port || '') === '8765';
  }

  global.ShareClient = ShareClient;
  global.ShareUtil = {
    makeRoomToken,
    roomFromLocation,
    appendChatLine,
    appendChatFile,
    bindChatFileDrop,
    renderAgingHitList,
    appendCmdLine,
    TypedLineBuffer,
    encodeConsoles,
    decodeConsoles,
    guestListFromPeers,
    validateSharePassword,
    passwordsMatch,
    getOrCreatePassGuard,
    storedPassLockMessage,
    storedPassRemainMs,
    applyPassErrorLocal,
    clearStoredPassFails,
    SHARE_PASSWORD_HINT,
    peerSummary,
    isLocalRelayOrigin,
    joinUrlForRoom,
    ROOM_KEY,
  };
})(window);
