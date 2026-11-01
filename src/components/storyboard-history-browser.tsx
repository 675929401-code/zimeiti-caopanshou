"use client";

import { useMemo, type ReactNode } from "react";
import { ArrowLeft, Download, Film, Loader2, Play, RefreshCw, Trash2 } from "lucide-react";
import type { VideoHistoryItem } from "./video-history-panel";
import { groupVideoHistory } from "@/lib/video-history-policy";
import { storyboardRecordState } from "@/lib/storyboard-history-view";
import { STORYBOARD_ARCHIVE_RETENTION_MS } from "@/lib/storyboard-video-archive-policy";
import "./storyboard-history-browser.css";

export interface StoryboardHistoryBrowserProps {
  items: readonly VideoHistoryItem[];
  localTaskIds: ReadonlySet<string>;
  renderCover: (item: VideoHistoryItem) => ReactNode;
  loading: boolean;
  error?: string;
  notice?: string;
  onBack: () => void;
  onRefresh: () => void;
  onRequestClear: () => void;
  confirmation?: ReactNode;
  clearBusy?: boolean;
  batchBusy: string;
  downloadBusy?: boolean;
  hasRecovery?: boolean;
  onDownloadBatch: (batch: { batchId: string; batchTopic?: string; items: VideoHistoryItem[] }) => void;
  onDownloadVideo: (item: VideoHistoryItem) => void;
  onPreview: (item: VideoHistoryItem) => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
}

const batchLabel = (topic?: string) => {
  const value = String(topic || "").trim();
  return value && !/^(?:storyboard-workbench|video-page|digital-human)$/u.test(value) ? value : "分镜制作";
};
const segmentLabel = (item: VideoHistoryItem) => Number.isInteger(item.cardIndex) && Number(item.cardIndex) >= 0
  ? `第${Number(item.cardIndex) + 1}段` : "分镜视频";
const timeLabel = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" }) : "";
};
const durationLabel = (item: VideoHistoryItem) => {
  const value = item.durationSeconds ?? item.duration;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? `${value}秒` : "";
};

export function StoryboardHistoryBrowser(props: StoryboardHistoryBrowserProps) {
  const { items, localTaskIds } = props;
  const records = useMemo(() => [...new Map(items.map((item) => [item.taskId, item])).values()], [items]);
  const videos = useMemo(() => records.filter((item) => item.status === "completed"), [records]);
  const unfinished = useMemo(() => records.filter((item) => item.status !== "completed"), [records]);
  const unfinishedNotice = useMemo(() => {
    const failed = unfinished.filter((item) => item.status === "failed" || item.status === "cancelled").length;
    const expired = unfinished.filter((item) => item.status === "expired").length;
    const active = unfinished.length - failed - expired;
    return [active ? `进行中 ${active}` : "", failed ? `失败或取消 ${failed}` : "", expired ? `已过期 ${expired}` : ""].filter(Boolean).join(" · ");
  }, [unfinished]);
  const days = useMemo(() => groupVideoHistory(videos), [videos]);
  const canPlay = (item: VideoHistoryItem) => storyboardRecordState(item, localTaskIds.has(item.taskId)) === "playable";

  return <section className="sbh-storyboard-page" aria-label="分镜历史">
    <header className="sbh-storyboard-heading">
      <div>
        <div className="sbh-storyboard-title-row">
          <button type="button" className="sbh-storyboard-back" aria-label="返回分镜工作台" onClick={props.onBack}><ArrowLeft size={17} />返回工作台</button>
          <h2>分镜历史</h2>
        </div>
        <p>云端视频默认保留{STORYBOARD_ARCHIVE_RETENTION_MS / 86_400_000}天，请及时下载。</p>
      </div>
      <div className="sbh-storyboard-actions">
        <button type="button" onClick={props.onRefresh} disabled={props.loading}><RefreshCw size={14} />刷新</button>
        <button type="button" onClick={props.onRequestClear} disabled={props.clearBusy}><Trash2 size={14} />清空历史</button>
      </div>
    </header>
    {props.confirmation}
    {props.error && <p className="sbh-storyboard-message is-error" role="alert">{props.error}</p>}
    {props.notice && <p className="sbh-storyboard-message" role="status">{props.notice}</p>}
    <div className="sbh-storyboard-content">
      {(unfinished.length > 0 || props.hasRecovery) && <div className="sbh-storyboard-actions">
        <p className="sbh-storyboard-message" role="status">{unfinishedNotice || "未完成项目可返回工作台继续制作。"}</p>
        <button type="button" onClick={props.onBack}>返回工作台查看</button>
      </div>}
      {days.map((day) => <section className="sbh-storyboard-day" key={day.dateKey}>
        <h3>{day.label}</h3>
        {day.batches.map((batch) => {
          const playableVideos = batch.items.filter(canPlay);
          return <section className="sbh-storyboard-batch" key={batch.batchId} data-batch-id={batch.batchId}>
            <div className="sbh-storyboard-batch-heading">
              <div><h4>{batchLabel(batch.batchTopic)}</h4><span>{batch.items.length}个视频</span></div>
              <button type="button" disabled={!playableVideos.length || !!props.batchBusy || props.downloadBusy} onClick={() => props.onDownloadBatch({ batchId: batch.batchId, batchTopic: batchLabel(batch.batchTopic), items: playableVideos })}><Download size={14} />{props.batchBusy === batch.batchId ? "下载中…" : props.hasMore ? "下载已加载视频" : "下载本批次"}</button>
            </div>
            <div className="sbh-storyboard-grid">
              {batch.items.map((item) => {
                const playable = canPlay(item);
                const duration = durationLabel(item);
                return <article className="sbh-storyboard-card" key={item.taskId} data-task-id={item.taskId} data-card-index={item.cardIndex}>
                  <button type="button" className="sbh-storyboard-cover sbh-card-play" aria-label={`播放${segmentLabel(item)}视频`} disabled={!playable} onClick={() => props.onPreview(item)}>
                    {playable ? <>{props.renderCover(item)}<span className="sbh-storyboard-play"><Play size={20} fill="currentColor" /></span></>
                      : <span className="sbh-storyboard-unavailable"><Film size={25} /><span>{item.deliveryState === "expired" ? "视频已过期" : storyboardRecordState(item) === "active" ? "费用确认中" : "暂不可播放"}</span></span>}
                    {duration && <span className="sbh-storyboard-duration">{duration}</span>}
                  </button>
                  <footer className="sbh-storyboard-card-footer">
                    <strong>{segmentLabel(item)}</strong>
                    <time dateTime={item.createdAt}>{timeLabel(item.createdAt)}</time>
                    <button type="button" className="sbh-storyboard-download" aria-label={`下载${segmentLabel(item)}视频`} disabled={!playable || !!props.batchBusy || props.downloadBusy} onClick={() => props.onDownloadVideo(item)}><Download size={15} /><span>{props.downloadBusy ? "准备中…" : "下载"}</span></button>
                  </footer>
                </article>;
              })}
            </div>
          </section>;
        })}
      </section>)}
      {!days.length && <div className={`sbh-storyboard-empty${props.loading ? " is-loading" : ""}`}>
        {props.loading ? <><Loader2 size={24} /><span>加载中…</span></> : <>
          <span className="sbh-storyboard-empty-visual" aria-hidden="true"><Film size={28} /></span>
          <strong>{props.error ? "历史暂时无法读取" : unfinished.length ? "暂无已完成的视频" : "还没有历史视频"}</strong>
          <p>{props.error ? "稍后重试即可；已有记录不会因此被清除。" : "完成的视频会按制作批次出现在这里，可在线播放、按批次下载。"}</p>
          <div className="sbh-storyboard-empty-actions">
            <button type="button" onClick={props.onBack}>返回工作台</button>
            <button type="button" onClick={props.onRefresh} disabled={props.loading}>刷新列表</button>
          </div>
          {props.hasMore && <span className="sbh-storyboard-empty-hint">可加载更多记录查看此前视频。</span>}
        </>}
      </div>}
      {props.hasMore && props.onLoadMore && <button type="button" className="sbh-storyboard-load-more" disabled={props.loading} onClick={props.onLoadMore}>{props.loading ? "加载中…" : "加载更多视频"}</button>}
    </div>
  </section>;
}
