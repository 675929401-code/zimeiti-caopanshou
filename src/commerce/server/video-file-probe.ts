import {runFFmpeg} from './media-tools';
import type {SourceVideoInfo} from '../shared/member-video-production';

export const videoProbeInputArgs=(file:string)=>['-nostdin','-nostats','-hide_banner','-protocol_whitelist','file,pipe','-i',file];
export async function probeVideoFile(file:string):Promise<SourceVideoInfo> {
  const log=await runFFmpeg([...videoProbeInputArgs(file),'-map','0:v:0','-an','-frames:v','1','-vf','showinfo','-f','null','-'],30000);
  const source=log.split('Stream mapping:')[0];
  const time=source.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  const dimensions=log.match(/\bs:(\d+)x(\d+)/);
  const stream=source.split('\n').find(s=>/Stream #0:\d+.*: Video:/.test(s));
  if(!dimensions||!time||!stream)throw Error('无法读取源视频尺寸或时长');
  const fps=stream.match(/([\d.]+)\s+fps/), bitrate=source.match(/bitrate:\s*(\d+) kb\/s/);
  return {duration:+time[1]*3600+(+time[2])*60+(+time[3]),width:+dimensions[1],height:+dimensions[2],
    codec:stream.match(/Video:\s*(\w+)/)?.[1]||'',audioCodec:source.match(/Stream #0:\d+[^\n]*?: Audio:\s*(\w+)/)?.[1]||'',
    fps:fps?+fps[1]:null,bitrateKbps:bitrate?+bitrate[1]:null,videoBitrateKbps:Number(stream.match(/(\d+) kb\/s/)?.[1])||null};
}
