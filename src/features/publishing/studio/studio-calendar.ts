import calendar from './studio-calendar-data.json'

const dayMs = 86_400_000
const dayNames = ['初一','初二','初三','初四','初五','初六','初七','初八','初九','初十','十一','十二','十三','十四','十五','十六','十七','十八','十九','二十','廿一','廿二','廿三','廿四','廿五','廿六','廿七','廿八','廿九','三十']
const festivals: Record<string, string> = { '正月-1': '春节', '正月-15': '元宵节', '二月-2': '龙抬头', '五月-5': '端午节', '七月-7': '七夕', '七月-15': '中元节', '八月-15': '中秋节', '九月-9': '重阳节', '十二月-8': '腊八节' }
const starts = calendar.months.map(([date, month]) => ({ date, month, time: Date.parse(`${date}T00:00:00Z`) }))
const solarTerms: Record<string, string> = calendar.terms
export const calendarDateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`

/** Official civil dates use UTC+8; task timestamps retain the user's device timezone. */
export function studioCalendarDay(dateKey: string) {
  const time = Date.parse(`${dateKey}T00:00:00Z`)
  if (!Number.isFinite(time) || dateKey < calendar.from || dateKey > calendar.through) return { lunarLabel: '', fullLunar: '', festival: '', solarTerm: '' }
  let low = 0, high = starts.length - 1
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (starts[mid].time <= time) low = mid; else high = mid - 1 }
  const month = starts[low], day = Math.round((time-month.time)/dayMs)+1
  if (day < 1 || day > 30) return { lunarLabel: '', fullLunar: '', festival: '', solarTerm: '' }
  const next = starts[low+1]
  const festival = next?.month === '正月' && next.time-time === dayMs ? '除夕' : festivals[`${month.month}-${day}`] || ''
  const solarTerm = solarTerms[dateKey] || ''
  const monthLabel = month.month.replace('十二月','腊月').replace('十一月','冬月')
  return { lunarLabel: day === 1 ? monthLabel : dayNames[day-1], fullLunar: `${monthLabel}${dayNames[day-1]}`, festival: festival || (solarTerm === '清明' ? '清明节' : ''), solarTerm }
}

export function calendarTaskTone(state: string): 'scheduled' | 'done' | 'attention' | 'failed' | 'muted' {
  if (['success','succeeded','published','completed'].includes(state)) return 'done'
  if (['failed','rejected','failed_known'].includes(state)) return 'failed'
  if (['cancelled','canceled'].includes(state)) return 'muted'
  if (['unknown','awaiting_user_action','requires_user_action','awaiting_verification','browser_reported'].includes(state)) return 'attention'
  if (['pending','waiting','queued','processing','publishing','running','dispatching','scheduled','planned','platform_scheduled','accepted'].includes(state)) return 'scheduled'
  return 'attention'
}
