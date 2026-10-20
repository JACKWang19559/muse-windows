import React, { useState } from 'react';
import { Check, ChevronRight, FileText, LoaderCircle, ShieldCheck, Square, X } from 'lucide-react';

const LABELS = { workspace_list_files: '查看工作区文件', workspace_read_file: '读取文件', workspace_create_text_file: '创建文件', workspace_save_text_file: '保存文件', muse_list_apps:'查看本地应用', muse_read_app:'读取应用源码', muse_create_app:'创建本地应用', muse_write_app:'修改应用源码', muse_build_app:'构建应用' };
const STATES = { pending: '待处理', running: '正在处理', awaiting_approval: '等待确认', complete: '已完成', denied: '已拒绝', error: '未完成', cancelled: '已停止' };
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

export function AgentActivity({ trace, files, onOpenFile }) {
  if (!trace?.length) return null;
  return <div className="agent-activity" aria-label="文件助手操作" data-testid="agent-activity">{trace.map((round, index) => <div key={index}>
    {round.content && <p className="agent-intent">{round.content.slice(0, 3000)}</p>}
    {round.calls.map(call => {
      const args = parse(call.arguments), result = parse(call.result), fileId = result?.result?.file?.id || result?.result?.id;
      const file = files.find(file => file.id === fileId), label = LABELS[call.name] || call.name;
      const busy = ['pending', 'running', 'awaiting_approval'].includes(call.status);
      return <details className="agent-step" key={call.id} data-tool-status={call.status}><summary>{busy ? <LoaderCircle size={13} className={call.status === 'awaiting_approval' ? '' : 'spin'} /> : call.status === 'complete' ? <Check size={13} /> : <Square size={10} />}<span>{label}{args?.name ? ` · ${args.name}` : ''}</span><small>{STATES[call.status]}</small></summary><div className="agent-step-detail"><p>{result?.error?.message || (call.status === 'complete' ? '操作已完成。' : call.status === 'awaiting_approval' ? '请在确认卡片中检查写入内容。' : '本次操作的请求与结果如下。')}</p>{file && <button className="text-button" onClick={() => onOpenFile(file.id)}><FileText size={12} />{file.name}<ChevronRight size={12} /></button>}<pre>{JSON.stringify({ 请求: args ?? call.arguments, 结果: result }, null, 2)}</pre></div></details>;
    })}
  </div>)}</div>;
}

export function ApprovalQueue({ approvals, chats, files, onRespond, onOpenChat, notify }) {
  const [busy, setBusy] = useState(null);
  if (!approvals?.length) return null;
  const respond = async (approval, decision) => {
    setBusy(approval.id);
    try { await onRespond({ id: approval.id, decision }); }
    catch (error) { notify(error.message, 'error'); }
    finally { setBusy(null); }
  };
  return <aside className="approval-queue" aria-label="文件操作确认" data-testid="approval-queue">{approvals.map(approval => {
    const chat = chats.find(chat => chat.id === approval.chatId), args = approval.arguments || {};
    const name = args.name || files.find(file => file.id === args.id)?.name || (approval.name.startsWith('muse_') ? '当前应用' : '当前文件');
    return <section className="approval-card" key={approval.id} data-approval-id={approval.id}><header><ShieldCheck size={18} /><div><h3>{LABELS[approval.name] || '工作区操作'}需要你确认</h3><button className="text-button" onClick={() => onOpenChat(approval.chatId)}>{chat?.title || '打开对话'}<ChevronRight size={12} /></button></div></header><p className="approval-file-name"><FileText size={15} />{name}</p><p className="approval-description">{approval.summary || (approval.name === 'workspace_create_text_file' ? '将在工作区创建这份文件。' : '将更新工作台中的文件副本，原始导入文件保持不变。')}本次确认仅允许这一项操作。</p><details><summary>查看本次操作的完整参数与内容</summary><pre className="approval-content">{args.content ?? JSON.stringify(args, null, 2)}</pre></details><footer><button className="button secondary small" disabled={busy !== null} onClick={() => respond(approval, 'deny')} data-testid="approval-deny"><X size={13} />拒绝</button><button className="button primary small" disabled={busy !== null} onClick={() => respond(approval, 'approve')} data-testid="approval-approve">{busy === approval.id ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}允许本次操作</button></footer></section>;
  })}</aside>;
}
