import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, FileText, Folder, LoaderCircle, MessageCircle, Search } from 'lucide-react';

const excerpt = (value = '') => value.replace(/\s+/g, ' ').trim().slice(0, 100);
const recent = chats => [...chats].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
function Snippet({ hit }) {
  return <>{hit.snippet.slice(0, hit.matchStart)}<mark>{hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength)}</mark>{hit.snippet.slice(hit.matchStart + hit.matchLength)}</>;
}

export default function SearchDialog({ snapshot, currentChatId, Modal, onClose, onSelect }) {
  const [query, setQuery] = useState('');
  const [currentOnly, setCurrentOnly] = useState(false);
  const [selected, setSelected] = useState(0);
  const [page, setPage] = useState({ hits: [], nextCursor: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const needle = query.trim(), scope = currentOnly && currentChatId ? { chatId: currentChatId } : {};
  const identity = JSON.stringify([needle, scope.chatId || null]);
  useEffect(() => {
    const token = ++generation.current;
    setSelected(0); setPage({ hits: [], nextCursor: null }); setError('');
    if (!needle) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(async () => {
      try { const value = await window.muse.searchMessages({ query: needle, ...scope, limit: 20 }); if (generation.current === token) setPage({ ...value, identity }); }
      catch (error) { if (generation.current === token) setError(error.message); }
      finally { if (generation.current === token) setLoading(false); }
    }, 300);
    return () => { clearTimeout(timer); generation.current++; };
  }, [needle, currentOnly, currentChatId]);
  const more = async () => {
    if (loading || !page.nextCursor || page.identity !== identity) return;
    const token = generation.current;
    setLoading(true); setError('');
    try {
      const next = await window.muse.searchMessages({ query: needle, ...scope, limit: 20, cursor: page.nextCursor });
      if (token === generation.current) setPage(previous => ({ hits: [...previous.hits, ...next.hits], nextCursor: next.nextCursor, identity }));
    } catch (error) { if (token === generation.current) setError(error.message); }
    finally { if (token === generation.current) setLoading(false); }
  };
  const results = useMemo(() => {
    if (!needle) return recent(snapshot.chats).filter(chat => !currentOnly || chat.id === currentChatId).slice(0, 8).map(chat => ({ type: 'chat', id: chat.id, name: chat.title, description: excerpt(chat.messages.filter(message => !message.isDeleted).at(-1)?.content || '打开对话') }));
    const search = needle.toLowerCase();
    const named = currentOnly ? [] : [
      ...snapshot.workspaces.filter(space => `${space.name} ${space.description}`.toLowerCase().includes(search)).map(space => ({ type: 'workspace', id: space.id, name: space.name, description: space.description || '工作区' })),
      ...recent(snapshot.chats).filter(chat => chat.title.toLowerCase().includes(search)).map(chat => ({ type: 'chat', id: chat.id, name: chat.title, description: '对话标题' })),
      ...snapshot.files.filter(file => file.name.toLowerCase().includes(search)).map(file => ({ type: 'file', id: file.id, name: file.name, description: '文件' }))
    ].slice(0, 20);
    return [...(page.identity === identity ? page.hits : []).map(hit => ({ type: 'message', id: hit.chatId, messageId: hit.messageId, name: hit.title, hit, query: needle })), ...named];
  }, [needle, snapshot, page.hits, page.identity, identity, currentOnly, currentChatId]);
  const choose = item => { if (item) { onSelect(item); onClose(); } };
  return <Modal title="搜索工作台" onClose={onClose} className="search-modal" testId="search-dialog">
    <div className="search-input-wrap"><Search size={21} /><input data-testid="search-input" value={query} maxLength={500} onChange={event => setQuery(event.target.value)} placeholder="搜索消息、对话、工作区和文件…" autoFocus onKeyDown={event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setSelected(value => Math.min(value + 1, Math.max(0, results.length - 1))); }
      if (event.key === 'ArrowUp') { event.preventDefault(); setSelected(value => Math.max(value - 1, 0)); }
      if (event.key === 'Enter') choose(results[selected]);
    }} /><kbd>ESC</kbd></div>
    {currentChatId && <div className="search-scope"><button aria-pressed={!currentOnly} onClick={() => setCurrentOnly(false)}>全部对话</button><button aria-pressed={currentOnly} onClick={() => setCurrentOnly(true)} data-testid="search-current-chat">当前对话</button></div>}
    <div className="search-results" aria-busy={loading}><span className="list-label">{needle ? `${results.length} 个结果${loading ? ' · 正在搜索' : ''}` : '最近对话'}</span>
      {results.map((item, index) => { const Icon = item.type === 'workspace' ? Folder : item.type === 'file' ? FileText : MessageCircle; return <button key={`${item.type}-${item.id}-${item.messageId || ''}`} className={`search-result ${selected === index ? 'selected' : ''}`} data-testid={item.type === 'message' ? 'search-message-hit' : undefined} data-message-id={item.messageId} onMouseMove={() => setSelected(index)} onClick={() => choose(item)}><span className="search-result-icon"><Icon size={19} /></span><span><strong>{item.name}</strong><small>{item.hit ? <Snippet hit={item.hit} /> : item.description}</small></span><span className="search-result-type">{item.type === 'message' ? item.hit.role === 'user' ? '你的消息' : 'Muse 回复' : item.type === 'workspace' ? '工作区' : item.type === 'file' ? '文件' : '对话'}</span><ArrowRight size={15} /></button>; })}
      {!results.length && <div className="search-empty">{loading ? <LoaderCircle size={26} className="spin" /> : <Search size={28} />}<p>{loading ? '正在搜索消息…' : needle ? '没有找到相关内容' : '你的第一段对话，会从这里开始'}</p></div>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      {page.identity === identity && page.nextCursor && <button className="button secondary search-more" data-testid="search-more" onClick={more} disabled={loading}>{loading ? '正在加载…' : '加载更多消息'}</button>}
    </div><footer className="search-footer"><span><kbd>↑</kbd><kbd>↓</kbd>选择</span><span><kbd>Enter</kbd>打开</span></footer>
  </Modal>;
}
