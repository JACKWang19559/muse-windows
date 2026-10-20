import React, { useEffect, useRef, useState } from 'react';

export default function RenameFileDialog({ file, Modal, onClose, onRenamed }) {
  const [name, setName] = useState(file.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef(null);
  useEffect(() => {
    input.current?.focus();
    const dot = file.name.lastIndexOf('.');
    input.current?.setSelectionRange(0, dot > 0 ? dot : file.name.length);
  }, []);
  return <Modal title="重命名文件" subtitle="修改工作台中的文件名；更改扩展名会重新读取预览，文件内容保持原样。" onClose={() => !busy && onClose()} className="entity-modal">
    <form onSubmit={async event => {
      event.preventDefault();
      if (busy || !name.trim() || name.trim() === file.name) return;
      setBusy(true); setError('');
      try {
        const renamed = await window.muse.renameFile({ id: file.id, name: name.trim(), expectedName: file.name });
        onRenamed(renamed);
      } catch (failure) {
        setError((failure?.message || '').replace(/^Error invoking remote method 'muse:invoke': (?:Error: )?/, '') || '重命名失败，请重试。');
      } finally { setBusy(false); }
    }}><div className="form-body"><label className="field"><span>文件名</span><input ref={input} data-testid="file-rename-name" value={name} onChange={event => setName(event.target.value)} maxLength={240} disabled={busy} spellCheck={false} /></label>
      {error && <div className="inline-error" role="alert">{error}</div>}</div>
      <footer className="modal-footer"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="button primary" data-testid="file-rename-submit" disabled={busy || !name.trim() || name.trim() === file.name}>{busy ? '正在重命名…' : '重命名'}</button></footer>
    </form>
  </Modal>;
}
