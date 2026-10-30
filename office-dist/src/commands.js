/**
 * 콘솔에 바로 보낼 빠른 명령.
 * 기본 목록은 처음 한 번만 쓰고, 이후에는 이 브라우저에 저장한다.
 */
(function (global) {
  const STORAGE_KEY = 'quick-commands';
  const MAX_COMMANDS = 20;
  const LABEL_MAX = 40;
  const COMMAND_MAX = 200;

  const DEFAULT_QUICK_COMMANDS = [
    { label: 'ifconfig', command: 'ifconfig' },
    { label: 'ifconfig -a', command: 'ifconfig -a' },
    { label: 'route -n', command: 'route -n' },
    { label: 'iwconfig', command: 'iwconfig' },
    { label: 'brctl show', command: 'brctl show' },
    { label: 'uptime', command: 'uptime' },
    { label: 'free', command: 'free' },
    { label: 'df -h', command: 'df -h' },
    { label: 'ps -w', command: 'ps -w' },
    { label: 'dmesg', command: 'dmesg' },
    { label: 'logread', command: 'logread' },
    { label: 'uname -a', command: 'uname -a' },
    { label: 'reboot', command: 'reboot' },
  ];

  function normalizeItem(item) {
    const command = String(item?.command || item?.label || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!command) {
      return null;
    }

    const label = String(item?.label || command)
      .replace(/[\t\n\r]/g, ' ')
      .trim() || command;

    return {
      label: label.slice(0, LABEL_MAX),
      command: command.slice(0, COMMAND_MAX),
    };
  }

  function loadQuickCommands() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return DEFAULT_QUICK_COMMANDS.map((item) => normalizeItem(item));
      }

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return DEFAULT_QUICK_COMMANDS.map((item) => normalizeItem(item));
      }

      return parsed.map(normalizeItem).filter(Boolean).slice(0, MAX_COMMANDS);
    } catch {
      return DEFAULT_QUICK_COMMANDS.map((item) => normalizeItem(item));
    }
  }

  function saveQuickCommands(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  function addQuickCommand(command) {
    const item = normalizeItem({ command });
    if (!item) {
      return { error: '버튼으로 만들 명령을 입력하세요.' };
    }

    const list = loadQuickCommands();
    if (list.some((entry) => entry.command === item.command)) {
      return { error: '이미 있는 버튼입니다.' };
    }
    if (list.length >= MAX_COMMANDS) {
      return { error: '버튼은 ' + MAX_COMMANDS + '개까지입니다.' };
    }

    list.push(item);
    saveQuickCommands(list);
    return { list };
  }

  function removeQuickCommand(command) {
    const next = loadQuickCommands().filter((item) => item.command !== command);
    saveQuickCommands(next);
    return next;
  }

  function resetQuickCommands() {
    const list = DEFAULT_QUICK_COMMANDS.map((item) => normalizeItem(item));
    saveQuickCommands(list);
    return list;
  }

  function renderQuickCommandButtons(container, options) {
    if (!container) {
      return;
    }

    const sendEnabled = Boolean(options?.sendEnabled);
    const editing = Boolean(options?.editing);
    const onSend = options?.onSend;
    const onRemove = options?.onRemove;

    container.replaceChildren();
    container.classList.toggle('command-editing', editing);

    for (const item of loadQuickCommands()) {
      const wrap = document.createElement('span');
      wrap.className = 'cmd-item';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-cmd';
      button.textContent = item.label;
      button.title = item.command;
      button.disabled = !sendEnabled;
      button.addEventListener('click', () => {
        onSend?.(item.command);
      });
      wrap.appendChild(button);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-cmd-remove';
      remove.textContent = '×';
      remove.title = '버튼 삭제: ' + item.command;
      remove.hidden = !editing;
      remove.addEventListener('click', () => {
        onRemove?.(item.command);
      });
      wrap.appendChild(remove);

      container.appendChild(wrap);
    }
  }

  global.QUICK_COMMANDS = DEFAULT_QUICK_COMMANDS;
  global.QuickCommands = {
    max: MAX_COMMANDS,
    load: loadQuickCommands,
    add: addQuickCommand,
    remove: removeQuickCommand,
    reset: resetQuickCommands,
    render: renderQuickCommandButtons,
  };
})(window);
