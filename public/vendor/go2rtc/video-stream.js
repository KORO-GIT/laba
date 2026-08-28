import { VideoRTC } from './video-rtc.js';

class VideoStream extends VideoRTC {
  initialize() {
    super.initialize();
    const info = document.createElement('div');
    info.className = 'stream-info';
    const status = document.createElement('span');
    status.className = 'stream-status';
    const mode = document.createElement('span');
    mode.className = 'stream-mode';
    info.append(status, mode);
    this.append(info);

    this.addEventListener('modechange', (event) => {
      mode.textContent = event.detail;
      status.textContent = '';
    });
    this.addEventListener('streamerror', (event) => {
      status.textContent = event.detail;
    });
  }
}

customElements.define('video-stream', VideoStream);
