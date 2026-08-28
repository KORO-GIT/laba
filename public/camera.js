import './vendor/go2rtc/video-stream.js';

const player = document.querySelector('#camera-player');
const state = document.querySelector('#camera-state');
const errorBox = document.querySelector('#camera-error');
const embedded = window.location.pathname === '/laba-camera/player';
const gatewayPath = embedded ? '/laba-camera' : '/gateway';

if (embedded) document.body.classList.add('camera-embedded');

async function start() {
  try {
    const response = await fetch(`${gatewayPath}/meta`, { headers: { Accept: 'application/json' } });
    const meta = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(meta.error || `Помилка ${response.status}`);

    document.title = `${meta.name} — LABA`;
    document.querySelector('#camera-name').textContent = meta.name;
    document.querySelector('#portal-link').href = meta.portalUrl;

    player.mode = meta.modes || 'mse,hls,mjpeg';
    player.media = 'video,audio';
    player.src = `${gatewayPath}/ws`;
    state.textContent = 'Захищений live-потік';
  } catch (error) {
    state.textContent = 'Немає з’єднання';
    errorBox.textContent = error.message;
    errorBox.classList.remove('hidden');
  }
}

start();
