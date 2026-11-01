"use client";

export function StoryboardTaskNavigator({ items, activeId, imageDone, videoDone, onSelect, onAdd, disabled }: {
  items: Array<{ id: string; order: number; title: string; status: string; statusLabel: string }>;
  activeId: string; imageDone: number; videoDone: number;
  onSelect: (id: string) => void; onAdd: () => void; disabled: boolean;
}) {
  return <aside className="sbw-task-navigator" aria-label="项目段落导航">
    <header><strong>项目段落 <span>{items.length}</span></strong><small>分镜图 {imageDone}/{items.length} · 视频 {videoDone}/{items.length}</small>
      <progress value={imageDone} max={Math.max(1, items.length)} aria-label="分镜图完成进度" /></header>
    <nav>{items.map(item => <button key={item.id} type="button" data-nav-card-id={item.id} aria-current={activeId === item.id ? "step" : undefined}
      onClick={() => onSelect(item.id)} title={`段落${item.order}：${item.title} · ${item.statusLabel}`}>
      <span>{String(item.order).padStart(2, "0")}</span><span><strong>{item.title || `段落 ${item.order}`}</strong><small>{item.statusLabel}</small></span><i data-status={item.status} /></button>)}</nav>
    <footer><button type="button" disabled={disabled} onClick={onAdd}>＋ 新增段落</button><p>参考资产一次确认<br />新增段落自动继承</p></footer>
  </aside>;
}
