import {createHash} from 'node:crypto';
import pptxgen from '../../../integrations/commerce-pptx';
import {z} from 'zod';
import {PRESENTATION_TYPE, publicAsset, readIdempotentAsset, storeAsset} from './assets';

const heading=z.string().trim().min(1).max(100);
const cell=z.union([z.string().max(90),z.number().finite()]);
const slideHeader={title:heading};
const slideSpec=z.discriminatedUnion('type',[
  z.object({...slideHeader,type:z.literal('text'),points:z.array(z.string().trim().min(1).max(150)).min(1).max(6)}),
  z.object({...slideHeader,type:z.literal('table'),rows:z.array(z.array(cell).min(1).max(6)).min(1).max(8)}),
  z.object({...slideHeader,type:z.literal('chart'),chart:z.enum(['bar','line','pie']),labels:z.array(heading).min(1).max(12),series:z.array(z.object({name:heading,values:z.array(z.number().finite()).min(1).max(12)})).min(1).max(4)}),
  z.object({...slideHeader,type:z.literal('timeline'),steps:z.array(z.object({date:heading,label:z.string().trim().min(1).max(100)})).min(1).max(6)}),
]);
const deckSpec=z.object({title:heading,slides:z.array(slideSpec).min(1).max(40)});

export async function generateMemberSlides(owner:string,input:unknown){
  const parsed=deckSpec.safeParse(input);
  if(!parsed.success)throw Error('请检查 '+parsed.error.issues[0].path.join('.')+'：页面需要标题和该类型的内容。每份最多 40 页。');
  const spec=parsed.data,key='member-slides/v1/'+createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  const prior=readIdempotentAsset(owner,key);
  if(prior)return {asset:publicAsset(prior),pages:spec.slides.length};
  const deck=new pptxgen();
  deck.layout='LAYOUT_WIDE';deck.author='自媒体操盘手';deck.title=spec.title;
  deck.theme={headFontFace:'Microsoft YaHei',bodyFontFace:'Microsoft YaHei'};
  for(const page of spec.slides){
    const slide=deck.addSlide();
    slide.addText(page.title,{x:.65,y:.35,w:12,h:.7,margin:0,bold:true,fontSize:28,color:'171717',fit:'shrink'});
    switch(page.type){
      case 'text':
        page.points.forEach((point,i)=>slide.addText(point,{x:.8,y:1.25+i*(5.9/page.points.length),w:11.7,h:5.6/page.points.length,margin:.08,bullet:true,fontSize:21,color:'273444',fit:'shrink'}));
        break;
      case 'table': {
        const columns=page.rows[0].length;
        if(!page.rows.every(row=>row.length===columns))throw Error('表格每行的列数需要相同');
        const rows=page.rows.map((row,i)=>row.map(value=>({text:String(value),options:{bold:i===0,fill:{color:i===0?'E8F1FF':'FFFFFF'}}})));
        slide.addTable(rows,{x:.7,y:1.35,w:11.9,h:5.4,colW:11.9/columns,fontSize:14,margin:.08,border:{pt:.7,color:'CDD6E2'},autoPage:false});
        break;
      }
      case 'chart': {
        if(page.series.some(s=>s.values.length!==page.labels.length))throw Error('图表数据个数必须与横轴标签一致');
        if(page.chart==='pie'&&page.series.length!==1)throw Error('饼图需要一个数据系列');
        const series=page.series.map(s=>({...s,labels:page.labels}));
        slide.addChart(deck.ChartType[page.chart],series,{x:.75,y:1.25,w:11.8,h:5.7,showLegend:page.series.length>1||page.chart==='pie',legendPos:'b',chartColors:['0471FE','00A784','EAA239','824CC7']});
        break;
      }
      case 'timeline': {
        const each=5.8/page.steps.length;
        page.steps.forEach((step,i)=>{
          const y=1.22+i*each;
          slide.addText(step.date,{x:.8,y,w:2.7,h:each-.12,bold:true,fontSize:19,margin:.08,color:'0471FE',fit:'shrink'});
          slide.addText(step.label,{x:3.7,y,w:8.7,h:each-.12,fontSize:20,margin:.08,color:'171717',fit:'shrink'});
        });
      }
    }
  }
  const bytes=Buffer.from(await deck.write({outputType:'nodebuffer',compression:true}) as Uint8Array);
  const name=spec.title.replace(/[\\/:*?"<>|\p{Cc}]/gu,'_')+'.pptx';
  try{
    const asset=await storeAsset(owner,bytes,PRESENTATION_TYPE,name,'generated',undefined,undefined,key);
    return {asset:publicAsset(asset),pages:spec.slides.length};
  }catch(error){
    // Concurrent exports can have distinct Office timestamps but describe the exact same deck.
    const saved=readIdempotentAsset(owner,key);
    if(saved)return {asset:publicAsset(saved),pages:spec.slides.length};
    throw error;
  }
}
