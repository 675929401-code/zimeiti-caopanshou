'use client';

import { Clapperboard, Sparkles, Video } from 'lucide-react';
import './video-director-catalog.css';

export type VideoDirectorCatalogItem = {
  key: string;
  name: string;
  description: string;
  category: string;
  icon?: string;
  recommended?: boolean;
};

export function VideoDirectorCatalog({
  items,
  selectedKey,
  directorMode,
  onSelect,
  onDirect,
  onClone,
}: {
  items: VideoDirectorCatalogItem[];
  selectedKey: string;
  directorMode: boolean;
  onSelect: (key: string) => void;
  onDirect: () => void;
  onClone: () => void;
}) {
  return (
    <section className="ca-video-director-catalog" aria-labelledby="ca-video-director-title" data-testid="commerce-video-director-catalog">
      <header>
        <div>
          <span className="ca-video-director-kicker"><Clapperboard size={14} />视频创作方式</span>
          <h2 id="ca-video-director-title">超级编导 <small>{items.length} 种场景全部展示</small></h2>
          <p>直接选择场景进入对应编导，素材、脚本和生成设置继续在下方完成。</p>
        </div>
        <div className="ca-video-director-actions">
          <button type="button" className={!directorMode ? 'selected' : ''} aria-pressed={!directorMode} onClick={onDirect}>
            <Sparkles size={16} /><span><strong>自由创作</strong><small>直接写视频提示词</small></span>
          </button>
          <button type="button" className="ca-video-clone-entry" aria-label="打开复刻原视频独立工作流" onClick={onClone}>
            <Video size={16} /><span><strong>复刻原视频</strong><small>独立工作流 · 换人物、商品、场景或声音</small></span>
          </button>
        </div>
      </header>
      <div className="ca-video-director-grid">
        {items.map(item => {
          const selected = directorMode && item.key === selectedKey;
          return (
            <button
              type="button"
              key={item.key}
              className={selected ? 'selected' : ''}
              aria-label={`选择超级编导：${item.name}`}
              aria-pressed={selected}
              data-director-key={item.key}
              onClick={() => onSelect(item.key)}
            >
              <span className="ca-video-director-avatar">
                {item.icon ? <img src={item.icon} alt="" /> : <Clapperboard size={20} />}
              </span>
              <span className="ca-video-director-copy">
                <span><strong>{item.name}</strong>{item.recommended && <em>推荐</em>}</span>
                <small>{item.description}</small>
              </span>
              <span className="ca-video-director-category">{item.category}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
