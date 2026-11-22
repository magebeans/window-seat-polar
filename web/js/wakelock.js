// Keep the screen on. Screen Wake Lock API first; if it is missing or the request fails, loop a tiny
// muted inline video (the long-standing iOS fallback; Wake Lock did not work in home-screen apps
// before iOS 18.4). Must be started from a user gesture.
export class KeepAwake {
  constructor(onChange) {
    this.onChange = onChange; this.lock = null; this.video = null; this.wanted = false; this.mode = 'off';
    document.addEventListener('visibilitychange', () => { if (this.wanted && document.visibilityState === 'visible') this.acquire(); });
  }

  async start(forceVideo = false) { this.wanted = true; this.forceVideo = forceVideo; await this.acquire(); }

  async acquire() {
    let api = false;
    if (!this.forceVideo && 'wakeLock' in navigator) {
      try {
        this.lock = await navigator.wakeLock.request('screen');
        this.lock.addEventListener('release', () => { this.lock = null; this.set(this.video && !this.video.paused ? 'video' : 'released'); });
        api = true;
      } catch (e) { /* NotAllowedError etc. → fall back */ }
    }
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    // On iOS run the video as well: a granted lock has been known not to hold in standalone mode.
    if (!api || isIOS || this.forceVideo) await this.playVideo();
    this.set(api && this.video && !this.video.paused ? 'api+video' : api ? 'api' : this.video && !this.video.paused ? 'video' : 'unavailable');
  }

  async playVideo() {
    if (!this.video) {
      const v = document.createElement('video');
      v.setAttribute('playsinline', ''); v.setAttribute('muted', ''); v.muted = true; v.loop = true;
      v.src = 'media/keepawake.mp4';
      Object.assign(v.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0.01', pointerEvents: 'none', bottom: '0', left: '0' });
      document.body.appendChild(v);
      this.video = v;
    }
    try { await this.video.play(); } catch { /* no media / not allowed */ }
  }

  stop() {
    this.wanted = false;
    this.lock?.release(); this.lock = null;
    this.video?.pause();
    this.set('off');
  }

  set(mode) { this.mode = mode; this.onChange?.(mode); }
}
