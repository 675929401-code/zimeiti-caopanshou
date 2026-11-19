"use client";
import { useEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Plus, RefreshCw } from "lucide-react";
import type { PublishingStudioController } from "./types";
import { StudioHistoryPanel } from "./StudioHistoryPanel";
import { timezoneLabel, platformName, historyStateGroup, type StudioHistoryFilter } from "./StudioPresentation";
import { calendarDateKey as keyOf, calendarTaskTone, studioCalendarDay, studioCalendarDates } from "./studio-calendar";
import styles from "./Studio.module.css";

export function StudioCalendar({ work, onCompose }: { work: PublishingStudioController; onCompose(): void }) {
  const [month, setMonth] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const [selectedDay, setSelectedDay] = useState(() => keyOf(new Date()));
  const [mode, setMode] = useState<'month' | 'week'>('month');
  const [platformFilter, setPlatformFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StudioHistoryFilter>("all");
  const dayHeading = useRef<HTMLDivElement>(null);
  const { loadHistory } = work;
  const dates = studioCalendarDates(month, selectedDay, mode);
  const days = mode === "month" ? dates.days : [];
  const weekDays = mode === "week" ? dates.days : [];
  const { from, to } = dates;
  const range = from + "/" + to;
  useEffect(() => { void loadHistory({ from, to, completeRange: true }); }, [loadHistory, from, to]);
  const rangeError = work.historyPage.range === range && !work.historyLoading && !!work.historyPage.rangeError;
  const rangeLoading = !rangeError && (work.historyPage.range !== range || work.historyLoading);
  const events = rangeLoading || rangeError ? [] : work.history.filter(item => {
    const scheduledAt = item.publishAt ? Date.parse(item.publishAt) : NaN;
    const group = historyStateGroup(item.state);
    return scheduledAt >= Date.parse(from) && scheduledAt < Date.parse(to)
      && (!platformFilter || item.platform === platformFilter)
      && (statusFilter === "all" || group === statusFilter);
  });
  const weekEvents = (day: Date) => events.filter(item => keyOf(new Date(item.publishAt!)) === keyOf(day));
  const selectedEvents = weekEvents(new Date(selectedDay + "T00:00:00"));
  const selectedLunar = studioCalendarDay(selectedDay), today = keyOf(new Date());
  function showDayDetails(day: string) {
    setSelectedDay(day);
    dayHeading.current?.focus();
  }
  function movePeriod(offset: number) {
    if (mode === "month") {
      const next = new Date(month.getFullYear(), month.getMonth() + offset, 1);
      setMonth(next);
      setSelectedDay(keyOf(next));
    } else {
      const next = new Date(selectedDay + "T00:00:00");
      next.setDate(next.getDate() + offset * 7);
      setSelectedDay(keyOf(next));
      setMonth(new Date(next.getFullYear(), next.getMonth(), 1));
    }
  }
  const title = mode === "month" ? month.getFullYear() + " 年 " + (month.getMonth() + 1) + " 月"
    : keyOf(weekDays[0]).slice(5).replace("-", "/") + " – " + keyOf(weekDays[6]).slice(5).replace("-", "/");
  return <section className={styles.calendar} data-testid="studio-calendar">
    <div className={styles.calendarToolbar}><div className={styles.calendarMonthTitle}><span className={styles.calendarMonthIcon}><CalendarDays size={24} strokeWidth={1.6} /></span><div><h2>{title}</h2><span>{timezoneLabel()}</span></div></div><div className={styles.inline}>
      <div className={styles.calendarModeSwitch} role="group" aria-label="日历视图"><button type="button" aria-pressed={mode === "month"} onClick={() => setMode("month")}>月</button><button type="button" aria-pressed={mode === "week"} onClick={() => setMode("week")}>周</button></div>
      <div className={styles.calendarMonthControls}><button type="button" className={styles.iconButton} aria-label={mode === "month" ? "上个月" : "上一周"} onClick={() => movePeriod(-1)}><ChevronLeft size={19} /></button><button type="button" className={styles.smallButton} onClick={() => { const now = new Date(); setMonth(new Date(now.getFullYear(), now.getMonth(), 1)); setSelectedDay(keyOf(now)); }}>今天</button><button type="button" className={styles.iconButton} aria-label={mode === "month" ? "下个月" : "下一周"} onClick={() => movePeriod(1)}><ChevronRight size={19} /></button></div>
      <button type="button" className={styles.quietButton} disabled={work.historyLoading || !!work.busy} onClick={() => void loadHistory({ from, to, completeRange: true })}><RefreshCw size={15} className={work.historyLoading ? styles.spin : undefined} />刷新</button><button type="button" className={styles.primaryButton} onClick={onCompose}><Plus size={16} />新建发布</button>
    </div></div>
    <div className={styles.calendarFilters}>
      <label>平台<select aria-label="平台" className={styles.input} value={platformFilter} onChange={event => setPlatformFilter(event.target.value)}>
        <option value="">全部平台</option>
        {work.platforms.map(platform => <option key={platform.key} value={platform.key}>{platform.name}</option>)}
      </select></label>
      <label>状态<select aria-label="状态" className={styles.input} value={statusFilter} onChange={event => setStatusFilter(event.target.value as StudioHistoryFilter)}>
        <option value="all">全部状态</option><option value="progress">排期与进行中</option><option value="verify">待确认或核对</option><option value="success">已完成</option><option value="failed">失败或取消</option>
      </select></label>
    </div>
    {rangeError && <p className={styles.fieldHint} role="status">本时段的安排未能完整读取，请刷新后查看。</p>}
    <div className={styles.calendarLegend}><span><i data-tone="scheduled" />排期与进行中</span><span><i data-tone="attention" />待你处理</span><span><i data-tone="done" />平台回报完成</span><span><i data-tone="failed" />未完成</span><span className={styles.calendarLunarNote}>农历 · 节气</span></div>
    {mode === "week" && <div className={styles.weekGrid} data-testid="studio-calendar-week" aria-busy={rangeLoading}>
      {weekDays.map(day => { const key = keyOf(day), dayEvents = weekEvents(day), lunar = studioCalendarDay(key); return <div className={styles.weekColumn} key={key} data-today={key === today} data-selected={key === selectedDay}>
        <button type="button" className={styles.weekColumnHead} onClick={() => setSelectedDay(key)} aria-pressed={selectedDay === key}><span>{day.getMonth() + 1}/{day.getDate()}</span><small>周{"一二三四五六日"[(day.getDay() + 6) % 7]} · {lunar.lunarLabel}</small></button>
        <div className={styles.weekEvents}>{dayEvents.length ? dayEvents.slice(0, 4).map(item => <button type="button" key={item.id} className={styles.weekEvent} data-tone={calendarTaskTone(item.state)} data-platform={item.platform} disabled={!!work.busy} title={`${platformName(work, item.platform)} · ${item.accountName || "发布账号"} · ${item.title || "未命名发布"}`} onClick={() => { setSelectedDay(key); void work.refreshRecord(item.id); }}><span className={styles.weekEventPlatform}>{platformName(work, item.platform).slice(0, 1)}</span><time>{new Date(item.publishAt!).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time><em>{item.title || "未命名发布"}</em></button>) : <p className={styles.weekEmpty}>{rangeLoading ? "读取中" : rangeError ? "暂不可读取" : "无安排"}</p>}
          {dayEvents.length > 4 && <button type="button" className={styles.calendarMore} onClick={() => showDayDetails(key)}>另有 {dayEvents.length - 4} 项安排</button>}
        </div>
      </div>; })}
    </div>}    <div className={styles.calendarGrid} data-mode={mode} style={mode === "week" ? { display: "none" } : undefined} aria-label={`${month.getFullYear()}年${month.getMonth()+1}月发布日历`} aria-busy={rangeLoading}>
      {["一", "二", "三", "四", "五", "六", "日"].map((day,index) => <div className={styles.weekday} data-weekend={index > 4} key={day}>周{day}</div>)}
      {days.map(day => {
        const key = keyOf(day), lunar = studioCalendarDay(key), records = events.filter(item => keyOf(new Date(item.publishAt!)) === key);
        const outside = day.getMonth() !== month.getMonth(), weekend = day.getDay() === 0 || day.getDay() === 6;
        return <div key={key} className={styles.calendarDay} data-outside={outside} data-weekend={weekend} data-today={key === today} data-selected={selectedDay === key}>
          <button type="button" className={styles.calendarDateButton} data-testid={`studio-calendar-day-${key}`} aria-pressed={selectedDay === key} aria-label={`${day.getMonth()+1}月${day.getDate()}日 ${lunar.fullLunar} ${lunar.festival} ${lunar.solarTerm}，已读取${records.length}项安排`} onClick={() => setSelectedDay(key)}><span className={styles.dayNumber}>{day.getDate()}</span><span className={styles.lunarDay}>{lunar.lunarLabel}</span>{key === today && <span className={styles.todayLabel}>今天</span>}</button>
          {(lunar.festival || lunar.solarTerm) && <div className={styles.calendarDateTags}>{lunar.festival && <span data-kind="festival">{lunar.festival}</span>}{lunar.solarTerm && lunar.solarTerm !== "清明" && <span data-kind="term">{lunar.solarTerm}</span>}</div>}
          <div className={styles.calendarEvents}>{records.slice(0, 2).map(item => <button type="button" className={styles.calendarEvent} data-tone={calendarTaskTone(item.state)} data-platform={item.platform} key={item.id} disabled={!!work.busy} title={`${platformName(work,item.platform)} · ${item.accountName || "发布账号"} · ${item.title || "未命名发布"}`} onClick={() => { setSelectedDay(key); void work.refreshRecord(item.id); }}><i /><span><time>{new Date(item.publishAt!).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</time>{item.title || "未命名发布"}</span></button>)}</div>
          {records.length > 2 && <button type="button" className={styles.calendarMore} onClick={() => showDayDetails(key)}>另有 {records.length - 2} 项安排</button>}
        </div>;
      })}
    </div>
    <div className={styles.calendarDayHeading} ref={dayHeading} tabIndex={-1} data-testid="studio-calendar-selected-date">
      <div><h3>{selectedDay.replaceAll("-", "/")} 的发布安排</h3>{selectedLunar.fullLunar && <p>{selectedLunar.fullLunar}</p>}</div>
      <span>{rangeLoading ? "正在读取…" : rangeError ? "暂不可读取" : selectedEvents.length + " 项安排"}</span>
    </div>
    {!rangeLoading && !rangeError && <StudioHistoryPanel work={work} items={selectedEvents} onCompose={onCompose}
      emptyTitle="这一天没有符合筛选条件的安排" emptyDescription="切换日期、调整筛选，或准备下一份作品。" />}
    <p className={styles.calendarSource}>农历与节气按北京时间，节日标注不代表放假或调休。<a href="https://www.hko.gov.hk/tc/gts/time/conversion.htm" target="_blank" rel="noopener noreferrer">历法资料</a></p>
  </section>;
}
