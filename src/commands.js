/**
 * 콘솔에 바로 보낼 빠른 명령.
 * label 이 버튼 글자, command 가 장비로 나가는 문자열이다.
 */
(function (global) {
  global.QUICK_COMMANDS = [
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
})(window);
