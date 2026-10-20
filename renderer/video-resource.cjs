'use strict';
const { videoMime, MAX_VIDEO_FILE_BYTES } = require('../backend/video-format.cjs');
const videoKey = file => JSON.stringify([file.id, file.name, file.sha256 || '']);
const bufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
const finite = value => Number.isFinite(value) && value >= 0 ? value : 0;
const readError = error => (typeof error?.message === 'string' ? error.message : '')
  .replace(/^Error invoking remote method 'muse:invoke': (?:Error: )?/, '').trim() || '无法读取视频，请重试。';

class VideoResource {
  constructor({ element, readFile, onChange, createURL = blob => URL.createObjectURL(blob), revokeURL = url => URL.revokeObjectURL(url), variant = 'inline' }) {
    if (!element || typeof element.addEventListener !== 'function' || typeof readFile !== 'function' || typeof onChange !== 'function' || !['inline', 'lightbox'].includes(variant)) throw new Error('Invalid video resource configuration.');
    this.element = element; this.readFile = readFile; this.onChange = onChange; this.createURL = createURL; this.revokeURL = revokeURL; this.variant = variant;
    this.epoch = 0; this.playSequence = 0; this.closed = false; this.url = null; this.key = null; this.view = null; this.listeners = [];
    this.lastMuted = variant === 'lightbox'; this.hasPlayed = false; this.autoAttempted = false;
  }
  publish(patch) {
    if (this.closed) return;
    this.view = { ...this.view, ...patch }; this.onChange(this.view);
  }
  current(epoch, key, url, requireSource = true) {
    return !this.closed && epoch === this.epoch && key === this.key && this.url === url && (!requireSource || this.element.currentSrc === url);
  }
  detach() {
    for (const [name, listener] of this.listeners) this.element.removeEventListener(name, listener);
    this.listeners = [];
    try { this.element.pause(); } catch {}
    try { this.element.removeAttribute('src'); } catch {}
    try { this.element.load(); } catch {}
    const url = this.url; this.url = null;
    if (url) this.revokeURL(url);
  }
  async load(file) {
    if (this.closed) return;
    const epoch = ++this.epoch; ++this.playSequence;
    if (this.url) this.lastMuted = this.element.muted === true;
    this.detach();
    this.key = videoKey(file); this.hasPlayed = false; this.autoAttempted = false;
    const key = this.key;
    this.view = { key, status: 'loading', url: null, error: '', notice: '', decoded: false, paused: true, muted: this.lastMuted, duration: 0, currentTime: 0, videoWidth: 0, videoHeight: 0 };
    this.onChange(this.view);
    try {
      const mime = videoMime(file.name);
      if (!mime) throw new Error('此文件格式不支持内置视频预览。');
      const result = await this.readFile({ id: file.id, expectedName: file.name, ...(file.sha256 ? { expectedSha256: file.sha256 } : {}) });
      if (this.closed || epoch !== this.epoch || key !== this.key) return;
      let length;
      try { length = bufferLength.call(result?.video); } catch { throw new Error('视频数据无效或已变化，请重新打开。'); }
      if (result.id !== file.id || result.name !== file.name || result.mimeType !== mime || !Number.isSafeInteger(result.size) || result.size < 0 || result.size !== length || length > MAX_VIDEO_FILE_BYTES || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256) || file.sha256 && file.sha256 !== result.sha256) throw new Error('视频数据无效或已变化，请重新打开。');
      const url = this.createURL(new Blob([result.video], { type: mime }));
      if (this.closed || epoch !== this.epoch || key !== this.key) { this.revokeURL(url); return; }
      this.url = url;
      this.element.controls = this.variant === 'inline';
      this.element.autoplay = this.variant === 'lightbox';
      this.element.loop = this.variant === 'lightbox';
      this.element.playsInline = true; this.element.preload = 'auto'; this.element.muted = this.lastMuted;
      const sync = name => this.sync(epoch, key, url, name);
      for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'play', 'playing', 'pause', 'ended', 'waiting', 'stalled', 'seeking', 'seeked', 'timeupdate', 'durationchange', 'volumechange']) {
        const listener = () => sync(name); this.listeners.push([name, listener]); this.element.addEventListener(name, listener);
      }
      const error = () => this.mediaError(epoch, key, url);
      this.listeners.push(['error', error]); this.element.addEventListener('error', error);
      this.publish({ status: 'prepared', url });
      this.element.src = url; this.element.load();
      // Cached media can already be ready without a later canplay event.
      this.sync(epoch, key, url, 'load');
    } catch (error) {
      if (!this.closed && epoch === this.epoch && key === this.key) {
        this.detach(); this.publish({ status: 'error', url: null, error: readError(error), notice: '', decoded: false, paused: true });
      }
    }
    return this.view;
  }
  sync(epoch, key, url, name) {
    if (!this.current(epoch, key, url)) return;
    const element = this.element;
    if (element.error) { this.mediaError(epoch, key, url); return; }
    if (element.readyState < 2) {
      if ((name === 'loadedmetadata' || name === 'durationchange') && element.readyState >= 1) this.publish({ duration: finite(element.duration), videoWidth: finite(element.videoWidth), videoHeight: finite(element.videoHeight) });
      return;
    }
    const firstDecode = !this.view.decoded, paused = element.paused === true;
    if (!paused) this.hasPlayed = true;
    this.lastMuted = element.muted === true;
    const status = element.ended ? 'ended' : paused ? this.hasPlayed ? 'paused' : 'ready' : element.readyState < 3 ? 'buffering' : 'playing';
    this.publish({ status, decoded: true, paused, muted: this.lastMuted, duration: finite(element.duration), currentTime: finite(element.currentTime), videoWidth: finite(element.videoWidth), videoHeight: finite(element.videoHeight), error: '', ...(status === 'playing' ? { notice: '' } : {}) });
    if (firstDecode && this.variant === 'lightbox' && !this.autoAttempted) { this.autoAttempted = true; if (paused) void this.play(); }
  }
  mediaError(epoch, key, url) {
    if (!this.current(epoch, key, url) || !this.element.error) return;
    const code = this.element.error.code;
    ++this.playSequence; this.detach();
    this.publish({ status: 'error', url: null, decoded: false, paused: true, notice: '', error: code === 2 ? '视频读取中断，请重试或下载原始副本。' : '无法解码这段视频。文件可能损坏，或此浏览器不支持该编码；仍可下载原始副本。' });
  }
  async play() {
    const epoch = this.epoch, key = this.key, url = this.url;
    // After a decoded source starts seeking, Chromium can temporarily drop
    // readyState below HAVE_CURRENT_DATA. Its real play() queues correctly;
    // dropping this user's request would leave a valid video stuck paused.
    if (!url || !this.current(epoch, key, url) || (!this.view?.decoded && this.element.readyState < 2) || this.element.error) return false;
    const sequence = ++this.playSequence;
    try {
      await this.element.play();
      if (!this.current(epoch, key, url) || sequence !== this.playSequence) return false;
      this.sync(epoch, key, url, 'play-result'); return !this.element.paused;
    } catch (error) {
      if (!this.current(epoch, key, url) || sequence !== this.playSequence || error?.name === 'AbortError') return false;
      if (this.element.error) this.mediaError(epoch, key, url);
      else {
        this.sync(epoch, key, url, 'play-rejected');
        this.publish({ notice: error?.name === 'NotAllowedError' ? '浏览器暂未允许自动播放，请点击播放。' : '无法开始播放，请点击播放重试。' });
      }
      return false;
    }
  }
  pause() {
    ++this.playSequence;
    const epoch = this.epoch, key = this.key, url = this.url;
    if (!url || !this.current(epoch, key, url)) return;
    this.element.pause(); this.sync(epoch, key, url, 'pause-request');
  }
  togglePlay() { return this.element.paused || this.element.ended ? this.play() : this.pause(); }
  toggleMute() {
    if (!this.url || !this.current(this.epoch, this.key, this.url)) return;
    this.lastMuted = !this.element.muted; this.element.muted = this.lastMuted;
    this.sync(this.epoch, this.key, this.url, 'mute-request');
  }
  seek(time) {
    const epoch = this.epoch, key = this.key, url = this.url, duration = this.element.duration;
    if (!url || !this.current(epoch, key, url) || this.element.readyState < 1 || !this.view?.decoded || !Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0) return;
    this.element.currentTime = Math.max(0, Math.min(time, duration));
    this.sync(epoch, key, url, 'seek-request');
  }
  dispose() {
    if (this.closed) return;
    this.closed = true; ++this.epoch; ++this.playSequence; this.detach();
  }
}
module.exports = { VideoResource, videoKey };
