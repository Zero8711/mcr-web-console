/**
 * 콘솔 옆 채팅·로그 분석·명령 기록 칸의 너비를 드래그로 조절한다.
 * 콘솔 칸은 남은 폭을 쓰고, 값은 이 브라우저에만 저장한다.
 */
(function (global) {
  const STORE = {
    chat: 'panel-w-chat',
    llm: 'panel-w-llm',
    cmd: 'panel-w-cmd',
  };
  const DEFAULTS = {
    chat: 248,
    llm: 280,
    cmd: 248,
  };
  const MIN_PANEL = 180;
  const MIN_CONSOLE = 220;

  function bind(workspace) {
    if (!workspace) {
      return;
    }

    const consoles = workspace.querySelector('#console-stack');
    const chat = workspace.querySelector('#chat-panel');
    const llm = workspace.querySelector('#llm-panel');
    const cmd = workspace.querySelector('#cmd-panel');

    setup(workspace, consoles, chat, 'chat', '콘솔 · 채팅 너비');
    setup(workspace, consoles, llm, 'llm', '로그 분석 너비');
    setup(workspace, consoles, cmd, 'cmd', '명령 기록 너비');

    window.addEventListener('resize', function () {
      applyAll(workspace, consoles, [
        { panel: chat, key: 'chat' },
        { panel: llm, key: 'llm' },
        { panel: cmd, key: 'cmd' },
      ]);
    });
  }

  function setup(workspace, consoles, panel, key, title) {
    if (!panel) {
      return;
    }

    applyWidth(workspace, consoles, panel, loadWidth(key));

    const handle = document.createElement('div');
    handle.className = 'panel-resizer';
    handle.title = title + ' (더블클릭하면 기본 크기)';
    panel.insertBefore(handle, panel.firstChild);

    handle.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || isColumn(workspace)) {
        return;
      }
      event.preventDefault();
      startDrag(event, workspace, consoles, panel, key, handle);
    });

    handle.addEventListener('dblclick', function (event) {
      event.preventDefault();
      if (isColumn(workspace)) {
        return;
      }
      const width = clampWidth(workspace, consoles, panel, DEFAULTS[key]);
      saveWidth(key, width);
      applyWidth(workspace, consoles, panel, width);
    });
  }

  function startDrag(event, workspace, consoles, panel, key, handle) {
    const startX = event.clientX;
    const startWidth = panel.getBoundingClientRect().width;

    handle.classList.add('dragging');
    document.body.classList.add('panel-resizing');
    handle.setPointerCapture(event.pointerId);

    function onMove(moveEvent) {
      const next = startWidth + (startX - moveEvent.clientX);
      const width = clampWidth(workspace, consoles, panel, next);
      applyWidth(workspace, consoles, panel, width);
    }

    function onUp(upEvent) {
      handle.releasePointerCapture(upEvent.pointerId);
      handle.classList.remove('dragging');
      document.body.classList.remove('panel-resizing');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      saveWidth(key, Math.round(panel.getBoundingClientRect().width));
    }

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  function applyAll(workspace, consoles, items) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item.panel) {
        continue;
      }
      applyWidth(workspace, consoles, item.panel, loadWidth(item.key));
    }
  }

  function applyWidth(workspace, consoles, panel, width) {
    if (isColumn(workspace)) {
      panel.style.width = '';
      panel.style.flex = '';
      panel.style.maxWidth = '';
      return;
    }
    const next = clampWidth(workspace, consoles, panel, width);
    panel.style.width = next + 'px';
    panel.style.flex = '0 0 ' + next + 'px';
    panel.style.maxWidth = 'none';
  }

  function clampWidth(workspace, consoles, panel, width) {
    const max = maxPanelWidth(workspace, consoles, panel);
    return Math.round(Math.min(max, Math.max(MIN_PANEL, Number(width) || MIN_PANEL)));
  }

  function maxPanelWidth(workspace, consoles, panel) {
    const box = workspace.getBoundingClientRect();
    let used = MIN_CONSOLE;
    const sides = workspace.querySelectorAll('.chat-panel');
    for (let i = 0; i < sides.length; i += 1) {
      const side = sides[i];
      if (side === panel || side.hidden) {
        continue;
      }
      used += side.getBoundingClientRect().width;
    }
    const gaps = 8 * Math.max(1, sides.length);
    const pad = 16;
    return Math.max(MIN_PANEL, Math.floor(box.width - used - gaps - pad));
  }

  function isColumn(workspace) {
    return getComputedStyle(workspace).flexDirection.indexOf('column') === 0;
  }

  function loadWidth(key) {
    try {
      const raw = localStorage.getItem(STORE[key]);
      const value = Number(raw);
      if (value >= MIN_PANEL) {
        return value;
      }
    } catch {
      // private mode
    }
    return DEFAULTS[key];
  }

  function saveWidth(key, width) {
    try {
      localStorage.setItem(STORE[key], String(width));
    } catch {
      // private mode
    }
  }

  global.PanelResize = {
    bind: bind,
  };
})(window);
