'use client';
import { useRef, useState } from 'react';
import { MAX_FRAME_RESULTS } from '@/commerce/frame-extraction-types';
import { CanvasFrameTools } from '@/commerce/components/commerce-agent/canvas-frame-tools';
import { api, type Runtime, type UIAsset } from '@/commerce/components/commerce-agent/runtime-ui';

import {isVideoProductionSkill,type VideoProductionSkill} from '@/commerce/shared/member-video-production';
import {VideoProductionAction} from './video-production-action';

type Tracks = {audio:UIAsset; video:UIAsset};
function AudioTracks({assetId}: {assetId:string}) {
  const [tracks, setTracks] = useState<Tracks|null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  async function separate() {
    if (lock.current) return;
    lock.current=true; setWorking(true); setError('');
    try { setTracks(await api<Tracks>('/api/commerce/studio/separate-audio', {assetId,format:'mkv'})); }
    catch (e) { setError((e as Error).message); }
    finally { lock.current=false; setWorking(false); }
  }
  return <div>
    <button type="button" onClick={()=>void separate()} disabled={working}>{working?'正在分离…':'分离并保存'}</button>
    {tracks && <p><a href={tracks.audio.url+'?download=1'} download={tracks.audio.name}>下载音轨</a>{' · '}
      <a href={tracks.video.url+'?download=1'} download={tracks.video.name}>下载无声视频</a></p>}
    {error && <span role="alert">{error}</span>}
  </div>;
}

export function VideoFileSkill({runtime, skill}: {runtime:Runtime; skill:'video-frame'|'demux'|VideoProductionSkill}) {
  const [assetId, setAssetId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const videos = runtime.assets.filter(item => item.type.startsWith('video/'));
  const frames = skill==='video-frame';
  const source = videos.find(v=>v.id===assetId);
  const title = {'video-frame':'视频截帧',demux:'音视频分离','speech-cut':'口播精剪','speech-pace':'口播节奏优化','ad-spec':'千川素材规格适配'}[skill];

  async function upload(file?: File) {
    if (!file) return;
    setUploading(true); setError('');
    try { setAssetId((await runtime.upload(file)).id); }
    catch (e) { setError((e as Error).message); }
    finally { setUploading(false); }
  }

  return <div className="cs-frame-skill" aria-label={title}>
    <label>源视频 <select aria-label={frames?'截帧源视频':skill==='demux'?'分离源视频':title+'源视频'} value={assetId} disabled={uploading} onChange={e => setAssetId(e.target.value)}>
      <option value="">从素材库选择</option>
      {videos.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    <input type="file" hidden ref={input} accept="video/mp4,video/webm,video/quicktime" onChange={e=>{void upload(e.target.files?.[0]);e.target.value='';}}/>
    <button type="button" disabled={uploading || !runtime.ready} onClick={()=>input.current?.click()}>{uploading?'正在上传…':'上传视频'}</button>
    {assetId && (isVideoProductionSkill(skill) ? source && <VideoProductionAction key={skill+assetId} skill={skill} source={source}/> : frames ? <CanvasFrameTools key={assetId} assetId={assetId} contextKey="skill:video-frame" remainingSlots={MAX_FRAME_RESULTS} onNotice={runtime.notice}/> : <AudioTracks key={assetId} assetId={assetId}/>)}
    {error && <span role="alert">{error}</span>}
  </div>;
}