'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { workbenchUserStorageKey } from '@/lib/workbench-user-storage';
export type FavoriteVoice = { speakerId: string; name: string; engine?: string; gender?: string; language?: string };
export function useVoiceFavorites(userId: string, token: string | null | undefined) {
 const [favorites,setFavorites]=useState<Set<string>>(new Set());
 const [favoriteError,setFavoriteError]=useState('');
 const [favoriteVoices,setFavoriteVoices]=useState<FavoriteVoice[]>([]);
 const owner=useRef(userId);owner.current=userId;
 const pending=useRef(new Set<string>()), sequence=useRef(0);
 const key=userId ? workbenchUserStorageKey('vs_favorites',userId) : ''; 
 const load=useCallback(async()=>{
  if(!userId||!token){setFavorites(new Set());return;}
  const stamp=++sequence.current;
  try { const response=await fetch('/api/voice/favorites',{headers:{Authorization:'Bearer '+token},cache:'no-store'});const data=await response.json();
   if(!response.ok)throw new Error(data.error||'收藏暂时无法读取');
   if(stamp!==sequence.current)return;
   const records=(data.favorites||[]).map((v:any)=>({speakerId:v.voice_id,name:v.voice_name,engine:v.engine,gender:v.gender,language:v.language}));setFavoriteVoices(records);
   const ids=records.map((v:FavoriteVoice)=>v.speakerId);setFavorites(new Set(ids));setFavoriteError('');
   try{localStorage.setItem(key,JSON.stringify(ids));}catch{}
  }catch(error){if(stamp===sequence.current)setFavoriteError(error instanceof Error?error.message:'收藏暂时无法读取');}
 },[userId,token,key]);
 useEffect(()=>{sequence.current++;setFavorites(new Set());setFavoriteVoices([]);pending.current.clear();try{const cached=JSON.parse(localStorage.getItem(key)||'[]');if(Array.isArray(cached)&&userId)setFavorites(new Set(cached));}catch{}void load();
  const update=()=>{if(!pending.current.size)void load();};window.addEventListener('focus',update);window.addEventListener('voice-favorites-updated',update);window.addEventListener('storage',update);
  return()=>{sequence.current++;window.removeEventListener('focus',update);window.removeEventListener('voice-favorites-updated',update);window.removeEventListener('storage',update);};
 },[load,key,userId]);
 const toggleFavorite=useCallback(async(voice:FavoriteVoice)=>{
  if(!userId||!token){setFavoriteError('请先登录，再保存收藏');return;}
  if(pending.current.has(voice.speakerId))return;
  pending.current.add(voice.speakerId);let saved=false;const remove=favorites.has(voice.speakerId);sequence.current++;setFavoriteError('');
  try{const params=new URLSearchParams({voice_id:voice.speakerId,engine:voice.engine||'volcano'});
   const response=await fetch('/api/voice/favorites'+(remove?'?'+params:''),{method:remove?'DELETE':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(remove?{}:{body:JSON.stringify({voice_id:voice.speakerId,voice_name:voice.name,engine:voice.engine||'volcano',gender:voice.gender,language:voice.language})})});
   const data=await response.json();if(!response.ok)throw new Error(data.error||'收藏尚未保存，请重试');
   if(owner.current!==userId)return; saved=true;
   setFavorites(current=>{const next=new Set(current);if(remove)next.delete(voice.speakerId);else next.add(voice.speakerId);try{localStorage.setItem(key,JSON.stringify([...next]));}catch{}return next;});
  }catch(error){if(owner.current===userId)setFavoriteError(error instanceof Error?error.message:'收藏尚未保存，请重试');}
  finally{pending.current.delete(voice.speakerId);if(saved)window.dispatchEvent(new Event('voice-favorites-updated'));}
 },[userId,token,favorites,key]);
 return{favorites,favoriteVoices,favoriteError,toggleFavorite,refreshFavorites:load};
}
