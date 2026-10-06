'use client';
export async function resolvePlayableAudio(url: string, signal?: AbortSignal): Promise<{url:string;release:()=>void}> {
 const parsed = new URL(url, window.location.origin);
 if (parsed.origin !== window.location.origin || !/^\/api\/storage\/files\/[^/]+\/content$/.test(parsed.pathname)) return {url,release:()=>{}};
 const token=localStorage.getItem('auth_token'); if(!token)throw new Error('请先登录后再播放音频');
 const response=await fetch(parsed.href,{headers:{Authorization:'Bearer '+token},signal,cache:'no-store'});
 if(!response.ok)throw new Error(response.status===401?'登录已过期，请重新登录':response.status===404?'音频不存在或不属于当前账号':'音频暂时无法加载，请重试');
 const blob=await response.blob(); if(!blob.size)throw new Error('音频内容为空，请重试');
 const playable=URL.createObjectURL(blob);return {url:playable,release:()=>URL.revokeObjectURL(playable)};
}
export async function downloadOwnedAudio(url:string,name:string) {
 const resolved=await resolvePlayableAudio(url);const a=document.createElement('a');a.href=resolved.url;a.download=name;a.rel='noopener';document.body.append(a);a.click();a.remove();setTimeout(resolved.release,60000);
}
