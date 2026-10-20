'use strict';
const { imageMime, MAX_IMAGE_FILE_BYTES } = require('../backend/image-format.cjs');
const imageKey = file => JSON.stringify([file.id, file.name, file.sha256 || '']);
const message = error => (typeof error?.message === 'string' ? error.message : '').replace(/^Error invoking remote method 'muse:invoke': (?:Error: )?/, '').trim() || '无法读取图片，请重试。';

// Each mounted viewer owns its URL. Loading a replacement invalidates every
// earlier callback; a retired request cannot publish or allocate a new URL.
class ImageResource {
  constructor({ readFile, onChange, createURL = blob => URL.createObjectURL(blob), revokeURL = url => URL.revokeObjectURL(url) }) {
    this.readFile = readFile; this.onChange = onChange; this.createURL = createURL; this.revokeURL = revokeURL;
    this.epoch = 0; this.url = null; this.closed = false; this.view = null;
  }
  release() { if (this.url) { const url = this.url; this.url = null; this.revokeURL(url); } }
  publish(patch) { this.view = { ...this.view, ...patch }; this.onChange(this.view); }
  async load(file) {
    if (this.closed) return;
    const epoch = ++this.epoch; this.release();
    this.view = { key: imageKey(file), status: 'loading', url: null, error: '' }; this.onChange(this.view);
    try {
      const mime = imageMime(file.name);
      if (!mime) throw new Error('此文件格式不支持内置图片预览。');
      const result = await this.readFile({ id: file.id, expectedName: file.name, ...(file.sha256 ? { expectedSha256: file.sha256 } : {}) });
      if (this.closed || epoch !== this.epoch) return;
      if (result?.id !== file.id || result.name !== file.name || result.mimeType !== mime || Object.prototype.toString.call(result.image) !== '[object ArrayBuffer]' || !Number.isSafeInteger(result.size) || result.size !== result.image.byteLength || result.size > MAX_IMAGE_FILE_BYTES || typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256) || file.sha256 && result.sha256 !== file.sha256) throw new Error('图片数据无效或已变化，请重新打开。');
      this.url = this.createURL(new Blob([result.image], { type: mime }));
      this.publish({ status: 'prepared', url: this.url });
    } catch (error) { if (!this.closed && epoch === this.epoch) { this.release(); this.publish({ status: 'error', url: null, error: message(error) }); } }
  }
  decoded(url) { if (!this.closed && this.url && this.url === url) this.publish({ status: 'ready' }); }
  failed(url) {
    if (this.closed || !this.url || this.url !== url) return;
    this.release(); this.publish({ status: 'error', url: null, error: '无法解码这张图片。文件可能损坏，或此浏览器不支持该格式；仍可下载原始副本。' });
  }
  dispose() { if (this.closed) return; this.closed = true; this.epoch++; this.release(); }
}
module.exports = { ImageResource, imageKey };
