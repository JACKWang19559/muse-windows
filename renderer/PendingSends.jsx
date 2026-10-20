import React from 'react';
import { Clock3, CornerUpLeft, X } from 'lucide-react';

export default function PendingSends({ items, onRestore, onCancel }) {
  if (!items.length) return null;
  return <section className="pending-sends" aria-label="待发送消息" data-testid="pending-sends"><header><Clock3 size={13} /><strong>待发送</strong><small>关闭工作台会取消等待</small></header><div className="pending-send-list">{items.map(item => <div className={`pending-send ${item.state}`} key={item.id} data-testid="pending-send" data-queue-id={item.id}><div><p>{item.content || '附件消息'}</p>{(item.activePanel||item.artifactContext)&&<small data-testid="pending-active-panel">应用：{(item.activePanel||item.artifactContext).artifactName}</small>}<small>{item.state === 'queued' ? '将在当前回复结束后发送' : item.error || '尚未发送，可恢复为草稿'}{item.attachmentIds.length ? ` · ${item.attachmentIds.length} 个附件` : ''}</small></div><button title="取消等待并恢复为草稿" aria-label="恢复为草稿" data-testid="queue-restore" onClick={() => onRestore(item)}><CornerUpLeft size={14} /></button><button title="移除这条待发送消息" aria-label="取消发送" data-testid="queue-cancel" onClick={() => onCancel(item)}><X size={14} /></button></div>)}</div></section>;
}
