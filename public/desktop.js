import RFB from '/novnc/core/rfb.js';

export function initDesktop({ showToast }) {
  const connectButton = document.querySelector('#desktop-connect');
  const disconnectButton = document.querySelector('#desktop-disconnect');
  const fullscreenButton = document.querySelector('#desktop-fullscreen');
  const copyButton = document.querySelector('#desktop-copy-address');
  const screen = document.querySelector('#desktop-screen');
  const placeholder = document.querySelector('#desktop-placeholder');
  const credentialsForm = document.querySelector('#desktop-credentials');
  const usernameInput = document.querySelector('#desktop-username');
  const passwordInput = document.querySelector('#desktop-password');
  const statusDot = document.querySelector('#desktop-status-dot');
  const statusText = document.querySelector('#desktop-status-text');
  let rfb = null;
  let disconnectRequested = false;

  function setStatus(status, message) {
    statusDot.className = `desktop-status-dot${status ? ` ${status}` : ''}`;
    statusText.textContent = message;
  }

  function setDisconnected(message = 'Не підключено', isError = false) {
    rfb = null;
    connectButton.disabled = false;
    connectButton.classList.remove('hidden');
    disconnectButton.classList.add('hidden');
    disconnectButton.disabled = false;
    fullscreenButton.disabled = true;
    credentialsForm.classList.add('hidden');
    passwordInput.value = '';
    placeholder.classList.remove('hidden');
    setStatus(isError ? 'error' : '', message);
  }

  function connect() {
    if (rfb) return;
    disconnectRequested = false;
    connectButton.disabled = true;
    credentialsForm.classList.add('hidden');
    passwordInput.value = '';
    placeholder.classList.add('hidden');
    setStatus('connecting', 'Встановлення захищеного з’єднання…');

    const url = new URL('/api/admin/desktop/ws', window.location.href);
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

    try {
      rfb = new RFB(screen, url.href, { shared: true });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.viewOnly = false;
      rfb.qualityLevel = 6;
      rfb.compressionLevel = 6;

      rfb.addEventListener('serververification', () => {
        // The browser only reaches the fixed LABA WebSocket endpoint; the
        // backend connects to the fixed Raspberry Pi over the private route.
        rfb?.approveServer();
      });
      rfb.addEventListener('credentialsrequired', () => {
        credentialsForm.classList.remove('hidden');
        passwordInput.focus();
        setStatus('connecting', 'Введіть пароль Raspberry Pi');
      });
      rfb.addEventListener('connect', () => {
        credentialsForm.classList.add('hidden');
        passwordInput.value = '';
        connectButton.classList.add('hidden');
        disconnectButton.classList.remove('hidden');
        fullscreenButton.disabled = false;
        setStatus('online', 'Підключено до Raspberry Pi');
        screen.focus();
      });
      rfb.addEventListener('securityfailure', (event) => {
        setStatus('error', event.detail?.reason || 'Raspberry Pi відхилила вхід');
      });
      rfb.addEventListener('disconnect', (event) => {
        const clean = Boolean(event.detail?.clean) || disconnectRequested;
        setDisconnected(clean ? 'Сеанс завершено' : 'З’єднання перервано', !clean);
      });
    } catch (error) {
      setDisconnected('Не вдалося почати сеанс', true);
      showToast(error.message || 'Не вдалося почати VNC-сеанс', true);
    }
  }

  credentialsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!rfb) return;
    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) return;
    rfb.sendCredentials({ username, password });
    passwordInput.value = '';
    credentialsForm.classList.add('hidden');
    setStatus('connecting', 'Перевірка облікових даних…');
  });

  connectButton.addEventListener('click', connect);
  disconnectButton.addEventListener('click', () => {
    if (!rfb) return;
    disconnectRequested = true;
    disconnectButton.disabled = true;
    setStatus('connecting', 'Завершення сеансу…');
    rfb.disconnect();
    disconnectButton.disabled = false;
  });
  fullscreenButton.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement === screen) await document.exitFullscreen();
      else await screen.requestFullscreen();
    } catch (error) {
      showToast(error.message || 'Повноекранний режим недоступний', true);
    }
  });
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText('192.168.0.63:5900');
      showToast('VNC-адресу скопійовано');
    } catch {
      showToast('VNC-адреса: 192.168.0.63:5900');
    }
  });
  document.addEventListener('fullscreenchange', () => {
    fullscreenButton.textContent = document.fullscreenElement === screen ? 'Вийти з повного екрана' : 'На весь екран';
  });
  window.addEventListener('beforeunload', () => rfb?.disconnect());

  return { connect };
}
