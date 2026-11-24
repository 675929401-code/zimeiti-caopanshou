export type Caption={start:number;end:number;text:string};
const timeFormat=/^(\d{2}):([0-5]\d):([0-5]\d)[,.](\d{3})$/;
function seconds(value:string) {
  const m=timeFormat.exec(value);
  if(!m)throw Error('字幕时间须为 HH:MM:SS,mmm');
  return +m[1]*3600 + +m[2]*60 + +m[3] + +m[4]/1000;
}
export function parseSubtitles(text:string):Caption[] {
  const parts=text.replace(/^\ufeff/,'').trim().replace(/\r\n?/g,'\n').split(/\n[ \t]*\n/);
  if(!text.trim()||text.length>120000||parts.length>2000)throw Error('请选择有效的 SRT 字幕（最多 2000 条）');
  let previous=-1;
  return parts.map((part,i)=>{
    const lines=part.split('\n');if(/^\d+$/.test(lines[0].trim()))lines.shift();
    const timing=lines.shift()?.trim().split(/\s*-->\s*/);
    if(!timing||timing.length!==2)throw Error('第 '+(i+1)+' 条缺少起止时间');
    const start=seconds(timing[0]),end=seconds(timing[1]),body=lines.join('\n').trim();
    if(end<=start||start<previous||!body||body.length>4000)throw Error('第 '+(i+1)+' 条字幕时间、次序或文字无效');
    previous=start;return {start,end,text:body};
  });
}
function srtTime(value:number) {
  const ms=Math.round(value*1000),digits=(n:number)=>String(n).padStart(2,'0');
  return digits(Math.floor(ms/3600000))+':'+digits(Math.floor(ms/60000)%60)+':'+digits(Math.floor(ms/1000)%60)+','+String(ms%1000).padStart(3,'0');
}
export function renderSrt(rows:Caption[]) {
  return rows.map((r,i)=>(i+1)+'\n'+srtTime(r.start)+' --> '+srtTime(r.end)+'\n'+r.text).join('\n\n')+'\n';
}
export function renderAss(rows:Caption[],highlight:string) {
  const header='[Script Info]\nScriptType: v4.00+\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Normal,Arial,40,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,30,30,36,1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n';
  const esc=(v:string)=>v.replace(/\\/g,'＼').replace(/{/g,'｛').replace(/}/g,'｝').replace(/\n/g,'\\N');
  const stamp=(n:number)=>srtTime(n).slice(0,-1).replace(',','.');
  return header+rows.map(r=>{
    const value=highlight?r.text.split(highlight).map(esc).join('{\\c&H00FFFF&}'+esc(highlight)+'{\\r}'):esc(r.text);
    return 'Dialogue: 0,'+stamp(r.start)+','+stamp(r.end)+',Normal,,0,0,0,,'+value;
  }).join('\n')+'\n';
}
