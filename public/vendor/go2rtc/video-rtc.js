/*
 * LABA go2rtc browser adapter.
 * Compatible with the go2rtc WebSocket API and inspired by VideoRTC 1.6.0.
 * Upstream project: https://github.com/AlexxIT/go2rtc (MIT License).
 */
export class VideoRTC extends HTMLElement {
  constructor() {
    super();
    this.mode = 'mse,hls,mjpeg';
    this.media = 'video,audio';
    this.video = null;
    this.ws = null;
    this.wsUrl = '';
    this.activeMode = '';
    this.failedModes = new Set();
    this.reconnectTimer = null;
    this.sourceBuffer = null;
    this.mediaSource = null;
    this.queue = [];
    this.queuedBytes = 0;
    this.jpegUrl = '';
    this.mediaUrl = '';
    this.visibilityHandler = () => {
      if (document.hidden) this.disconnect();
      else if (this.isConnected) this.connect();
    };
  }

  set src(value) {
    const url = new URL(String(value), window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    this.wsUrl = url.toString();
    this.connect();
  }

  connectedCallback() {
    if (!this.video) this.initialize();
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.connect();
  }

  disconnectedCallback() {
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.disconnect();
  }

  initialize() {
    this.video = document.createElement('video');
    this.video.controls = true;
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.append(this.video);
  }

  connect() {
    if (!this.isConnected || document.hidden || !this.wsUrl || this.ws) return;
    clearTimeout(this.reconnectTimer);
    this.ws = new WebSocket(this.wsUrl);
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('open', () => this.startBestMode());
    this.ws.addEventListener('message', (event) => this.handleMessage(event));
    this.ws.addEventListener('close', () => this.handleClose());
    this.ws.addEventListener('error', () => this.ws?.close());
    this.dispatchEvent(new CustomEvent('modechange', { detail: 'loading' }));
  }

  disconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      socket.close();
    }
    this.resetMedia();
  }

  handleClose() {
    this.ws = null;
    this.resetMedia();
    if (!this.isConnected || document.hidden) return;
    this.reconnectTimer = setTimeout(() => this.connect(), 5_000);
  }

  modes() {
    return String(this.mode).split(',').map((value) => value.trim()).filter(Boolean);
  }

  startBestMode() {
    const modes = this.modes();
    let selected = modes.find((mode) => mode === 'mse'
      && !this.failedModes.has(mode)
      && ('MediaSource' in window || 'ManagedMediaSource' in window));
    if (!selected) {
      selected = modes.find((mode) => mode === 'hls'
        && !this.failedModes.has(mode)
        && this.video.canPlayType('application/vnd.apple.mpegurl'));
    }
    if (!selected) selected = modes.find((mode) => mode === 'mjpeg' && !this.failedModes.has(mode));
    if (!selected) {
      this.failedModes.clear();
      this.dispatchEvent(new CustomEvent('streamerror', { detail: 'Немає сумісного формату відео' }));
      this.ws?.close();
      return;
    }

    this.activeMode = selected;
    if (selected === 'mse') this.startMse();
    else if (selected === 'hls') this.send({ type: 'hls', value: this.codecList() });
    else this.send({ type: 'mjpeg' });
  }

  codecList() {
    return [
      'avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0',
      'mp4a.40.2', 'mp4a.40.5', 'flac', 'opus'
    ].join(',');
  }

  startMse() {
    const MediaSourceClass = window.ManagedMediaSource || window.MediaSource;
    this.mediaSource = new MediaSourceClass();
    this.mediaSource.addEventListener('sourceopen', () => {
      const codecs = this.codecList().split(',')
        .filter((codec) => MediaSourceClass.isTypeSupported(`video/mp4; codecs="${codec}"`))
        .join(',');
      this.send({ type: 'mse', value: codecs });
    }, { once: true });

    if ('ManagedMediaSource' in window) {
      this.video.disableRemotePlayback = true;
      this.video.srcObject = this.mediaSource;
    } else {
      this.mediaUrl = URL.createObjectURL(this.mediaSource);
      this.video.src = this.mediaUrl;
    }
    this.play();
  }

  handleMessage(event) {
    if (typeof event.data !== 'string') {
      this.handleBinary(event.data);
      return;
    }

    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'error') {
      this.failedModes.add(this.activeMode);
      this.dispatchEvent(new CustomEvent('streamerror', { detail: 'Потік тимчасово недоступний' }));
      this.ws?.close();
      return;
    }
    if (message.type === 'mse') this.configureSourceBuffer(message.value);
    if (message.type === 'hls') this.configureHls(message.value);
    if (['mse', 'hls', 'mjpeg'].includes(message.type)) {
      this.dispatchEvent(new CustomEvent('modechange', { detail: message.type.toUpperCase() }));
    }
  }

  configureSourceBuffer(mimeType) {
    if (!this.mediaSource || this.sourceBuffer) return;
    try {
      this.sourceBuffer = this.mediaSource.addSourceBuffer(mimeType);
      this.sourceBuffer.mode = 'segments';
      this.sourceBuffer.addEventListener('updateend', () => this.flushQueue());
      this.sourceBuffer.addEventListener('error', () => this.failActiveMode());
    } catch {
      this.failActiveMode();
    }
  }

  configureHls(playlist) {
    const gatewayBase = `${window.location.origin}/gateway/hls/`;
    const rewritten = String(playlist).replaceAll('hls/', gatewayBase);
    this.video.src = `data:application/vnd.apple.mpegurl;base64,${btoa(rewritten)}`;
    this.play();
  }

  handleBinary(data) {
    if (this.activeMode === 'mjpeg') {
      if (this.jpegUrl) URL.revokeObjectURL(this.jpegUrl);
      this.jpegUrl = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
      this.video.poster = this.jpegUrl;
      this.video.controls = false;
      this.dispatchEvent(new CustomEvent('modechange', { detail: 'MJPEG' }));
      return;
    }
    if (!this.sourceBuffer || this.sourceBuffer.updating || this.queue.length) {
      if (this.queuedBytes + data.byteLength > 16 * 1024 * 1024) {
        this.failActiveMode();
        return;
      }
      this.queue.push(data);
      this.queuedBytes += data.byteLength;
      return;
    }
    this.appendBuffer(data);
  }

  appendBuffer(data) {
    try {
      this.sourceBuffer.appendBuffer(data);
    } catch {
      this.failActiveMode();
    }
  }

  flushQueue() {
    if (!this.sourceBuffer || this.sourceBuffer.updating) return;
    if (this.queue.length) {
      const data = this.queue.shift();
      this.queuedBytes -= data.byteLength;
      this.appendBuffer(data);
      return;
    }
    const buffered = this.sourceBuffer.buffered;
    if (!buffered.length) return;
    const end = buffered.end(buffered.length - 1);
    const keepFrom = Math.max(0, end - 8);
    if (keepFrom > buffered.start(0)) {
      try {
        this.sourceBuffer.remove(buffered.start(0), keepFrom);
      } catch {}
    }
    if (this.video.currentTime < end - 3) this.video.currentTime = end - 1;
  }

  failActiveMode() {
    this.failedModes.add(this.activeMode);
    this.ws?.close();
  }

  send(message) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  play() {
    this.video.play().catch(() => {
      this.video.muted = true;
      this.video.play().catch(() => {});
    });
  }

  resetMedia() {
    this.activeMode = '';
    this.queue = [];
    this.queuedBytes = 0;
    this.sourceBuffer = null;
    this.mediaSource = null;
    if (this.jpegUrl) {
      URL.revokeObjectURL(this.jpegUrl);
      this.jpegUrl = '';
    }
    if (this.mediaUrl) {
      URL.revokeObjectURL(this.mediaUrl);
      this.mediaUrl = '';
    }
    if (this.video) {
      this.video.removeAttribute('src');
      this.video.removeAttribute('poster');
      this.video.srcObject = null;
      this.video.load();
    }
  }
}
