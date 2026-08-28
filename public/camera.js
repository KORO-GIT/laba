import './vendor/go2rtc/video-stream.js';

const player = document.querySelector('#camera-player');
const state = document.querySelector('#camera-state');
const errorBox = document.querySelector('#camera-error');

async function start() {
  try {
    const response = await fetch('/gateway/meta', { headers: { Accept: 'application/json' } });
    const meta = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(meta.error || `Помилка ${response.status}`);

    document.title = `${meta.name} — LABA`;
    document.querySelector('#camera-name').textContent = meta.name;
    document.querySelector('#portal-link').href = meta.portalUrl;

    player.mode = 'mse,hls,mjpeg';
    player.media = 'video,audio';
    player.src = '/gateway/ws';
    state.textContent = 'Захищений live-потік';
  } catch (error) {
    state.textContent = 'Немає з’єднання';
    errorBox.textContent = error.message;
    errorBox.classList.remove('hidden');
  }
}

start();
