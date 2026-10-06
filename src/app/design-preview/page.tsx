'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useApp } from '@/contexts/app-context';

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>导航栏 + 左侧栏 方案预览</title>
<link rel="preconnect" href="https://fonts.googleapis.cn" />
<link rel="preconnect" href="https://fonts.gstatic.cn" crossorigin />
<style>
  :root {
    --bg: #070A14;
    --sidebar: #04070F;
    --primary: #7C5CFF;
    --accent: #69E7FF;
    --success: #62FAD3;
    --text: #F7FAFF;
    --text-dim: #9AA7C7;
    --text-faint: #5B6585;
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--text); font-family: 'Inter', 'Manrope', system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 0; }
  body {
    background:
      radial-gradient(1200px 600px at 20% -10%, rgba(124, 92, 255, 0.18), transparent 60%),
      radial-gradient(900px 500px at 90% 0%, rgba(105, 231, 255, 0.12), transparent 60%),
      var(--bg);
    min-height: 100vh;
  }
  .glass {
    background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
    border: 1px solid rgba(255,255,255,0.08);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
  }
  .glass-strong {
    background: linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.025));
    border: 1px solid rgba(255,255,255,0.10);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
  }
  .grad-text {
    background: linear-gradient(135deg, #7C5CFF 0%, #69E7FF 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .gradient-line {
    height: 1px;
    background: linear-gradient(90deg, transparent 0%, rgba(124,92,255,0.45) 20%, rgba(105,231,255,0.45) 50%, transparent 100%);
  }
  .gradient-line-v {
    width: 1px;
    background: linear-gradient(180deg, transparent 0%, rgba(124,92,255,0.35) 30%, rgba(105,231,255,0.35) 70%, transparent 100%);
  }
  .tab-active {
    color: var(--text);
    position: relative;
  }
  .tab-active::after {
    content: '';
    position: absolute;
    left: 50%;
    bottom: -10px;
    transform: translateX(-50%);
    width: 28px;
    height: 3px;
    border-radius: 3px;
    background: linear-gradient(90deg, #7C5CFF, #69E7FF);
    box-shadow: 0 0 12px rgba(124, 92, 255, 0.6);
  }
  .cta-btn {
    background: linear-gradient(135deg, #7C5CFF 0%, #69E7FF 100%);
    box-shadow:
      0 8px 24px rgba(124, 92, 255, 0.35),
      0 0 0 1px rgba(255, 255, 255, 0.08) inset;
    transition: all .25s ease;
    border: none;
    cursor: pointer;
    color: white;
  }
  .cta-btn:hover {
    transform: translateY(-1px);
    box-shadow:
      0 12px 32px rgba(124, 92, 255, 0.5),
      0 0 0 1px rgba(255, 255, 255, 0.12) inset;
  }
  .quick-card {
    background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.015));
    border: 1px solid rgba(255,255,255,0.06);
    transition: all .25s ease;
    cursor: pointer;
  }
  .quick-card:hover {
    background: linear-gradient(180deg, rgba(124,92,255,0.12), rgba(105,231,255,0.05));
    border-color: rgba(124,92,255,0.35);
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(124, 92, 255, 0.18);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(124, 92, 255, 0.12);
    color: #C4B7FF;
    border: 1px solid rgba(124, 92, 255, 0.25);
    font-size: 11px;
  }
  .switcher-btn {
    transition: all .2s ease;
    border: none;
    background: transparent;
    cursor: pointer;
    color: var(--text-dim);
  }
  .switcher-btn.active {
    background: linear-gradient(135deg, rgba(124,92,255,0.25), rgba(105,231,255,0.15));
    border: 1px solid rgba(124,92,255,0.5);
    color: #F7FAFF;
  }
  .nav-blur { backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
  .icon-tile {
    width: 32px; height: 32px;
    display: inline-flex; align-items: center; justify-content: center;
    border-radius: 8px;
    background: linear-gradient(135deg, rgba(124,92,255,0.18), rgba(105,231,255,0.10));
    border: 1px solid rgba(124,92,255,0.30);
  }
  .badge-dot {
    width: 6px; height: 6px; border-radius: 999px;
    background: linear-gradient(135deg, #7C5CFF, #69E7FF);
    box-shadow: 0 0 8px rgba(124,92,255,0.6);
  }
  .scrollbar::-webkit-scrollbar { width: 4px; }
  .scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
  .scrollbar::-webkit-scrollbar-track { background: transparent; }
  .hidden { display: none !important; }
  .max-w-1400 { max-width: 1400px; }
  .mx-auto { margin-left: auto; margin-right: auto; }
  .px-8 { padding-left: 32px; padding-right: 32px; }
  .py-10 { padding-top: 40px; padding-bottom: 40px; }
  .pt-10 { padding-top: 40px; }
  .mb-2 { margin-bottom: 8px; }
  .mb-3 { margin-bottom: 12px; }
  .mb-4 { margin-bottom: 16px; }
  .mb-5 { margin-bottom: 20px; }
  .mb-6 { margin-bottom: 24px; }
  .mb-8 { margin-bottom: 32px; }
  .mb-10 { margin-bottom: 40px; }
  .mb-16 { margin-bottom: 64px; }
  .mt-3 { margin-top: 12px; }
  .mt-4 { margin-top: 16px; }
  .mt-5 { margin-top: 20px; }
  .mt-6 { margin-top: 24px; }
  .mt-8 { margin-top: 32px; }
  .mt-16 { margin-top: 64px; }
  .mt-1 { margin-top: 4px; }
  .mt-2 { margin-top: 8px; }
  .my-4 { margin-top: 16px; margin-bottom: 16px; }
  .my-5 { margin-top: 20px; margin-bottom: 20px; }
  .p-3 { padding: 12px; }
  .p-4 { padding: 16px; }
  .p-5 { padding: 20px; }
  .p-6 { padding: 24px; }
  .px-2 { padding-left: 8px; padding-right: 8px; }
  .px-3 { padding-left: 12px; padding-right: 12px; }
  .px-4 { padding-left: 16px; padding-right: 16px; }
  .px-5 { padding-left: 20px; padding-right: 20px; }
  .px-6 { padding-left: 24px; padding-right: 24px; }
  .py-1 { padding-top: 4px; padding-bottom: 4px; }
  .py-1\.5 { padding-top: 6px; padding-bottom: 6px; }
  .py-2 { padding-top: 8px; padding-bottom: 8px; }
  .py-2\.5 { padding-top: 10px; padding-bottom: 10px; }
  .py-3 { padding-top: 12px; padding-bottom: 12px; }
  .flex { display: flex; }
  .grid { display: grid; }
  .inline-flex { display: inline-flex; }
  .hidden { display: none; }
  .block { display: block; }
  .items-center { align-items: center; }
  .items-end { align-items: flex-end; }
  .items-start { align-items: flex-start; }
  .justify-between { justify-content: space-between; }
  .justify-center { justify-content: center; }
  .justify-end { justify-content: flex-end; }
  .flex-1 { flex: 1 1 0%; }
  .flex-wrap { flex-wrap: wrap; }
  .gap-1 { gap: 4px; }
  .gap-1\.5 { gap: 6px; }
  .gap-2 { gap: 8px; }
  .gap-2\.5 { gap: 10px; }
  .gap-3 { gap: 12px; }
  .gap-4 { gap: 16px; }
  .gap-6 { gap: 24px; }
  .gap-0\.5 { gap: 2px; }
  .w-3 { width: 12px; }
  .h-3 { height: 12px; }
  .w-4 { width: 16px; }
  .h-4 { height: 16px; }
  .w-5 { width: 20px; }
  .h-5 { height: 20px; }
  .w-6 { width: 24px; }
  .h-6 { height: 24px; }
  .w-7 { width: 28px; }
  .h-7 { height: 28px; }
  .w-8 { width: 32px; }
  .h-8 { height: 32px; }
  .w-9 { width: 36px; }
  .h-9 { height: 36px; }
  .w-10 { width: 40px; }
  .h-10 { height: 40px; }
  .w-11 { width: 44px; }
  .h-11 { height: 44px; }
  .w-12 { width: 48px; }
  .h-12 { height: 48px; }
  .w-px { width: 1px; }
  .h-px { height: 1px; }
  .w-1\.5 { width: 6px; }
  .h-1\.5 { height: 6px; }
  .w-full { width: 100%; }
  .min-w-\[200px\] { min-width: 200px; }
  .min-w-\[260px\] { min-width: 260px; }
  .min-w-0 { min-width: 0; }
  .max-w-\[1400px\] { max-width: 1400px; }
  .grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .grid-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .grid-cols-\[280px_1fr\] { grid-template-columns: 280px 1fr; }
  .text-xs { font-size: 11px; line-height: 1.5; }
  .text-sm { font-size: 13px; line-height: 1.5; }
  .text-base { font-size: 14px; line-height: 1.5; }
  .text-lg { font-size: 16px; line-height: 1.5; }
  .text-xl { font-size: 18px; line-height: 1.4; }
  .text-2xl { font-size: 24px; line-height: 1.3; }
  .text-3xl { font-size: 30px; line-height: 1.25; }
  .text-\[10px\] { font-size: 10px; }
  .text-\[11px\] { font-size: 11px; }
  .text-\[12px\] { font-size: 12px; }
  .font-medium { font-weight: 500; }
  .font-semibold { font-weight: 600; }
  .font-bold { font-weight: 700; }
  .leading-tight { line-height: 1.3; }
  .text-white { color: #ffffff; }
  .text-center { text-align: center; }
  .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rounded { border-radius: 4px; }
  .rounded-md { border-radius: 6px; }
  .rounded-lg { border-radius: 10px; }
  .rounded-xl { border-radius: 14px; }
  .rounded-2xl { border-radius: 18px; }
  .rounded-full { border-radius: 9999px; }
  .rounded-t-lg { border-top-left-radius: 10px; border-top-right-radius: 10px; }
  .aspect-\[16\/10\] { aspect-ratio: 16/10; }
  .shrink-0 { flex-shrink: 0; }
  .ml-auto { margin-left: auto; }
  .relative { position: relative; }
  .absolute { position: absolute; }
  .cursor-pointer { cursor: pointer; }
  .overflow-y-auto { overflow-y: auto; }
  .space-y-1 > * + * { margin-top: 4px; }
  .space-y-1\.5 > * + * { margin-top: 6px; }
  .inline-block { display: inline-block; }
  .uppercase { text-transform: uppercase; }
  .tracking-widest { letter-spacing: 0.15em; }
  .tracking-\[0\.3em\] { letter-spacing: 0.3em; }
  .hover\:bg-white\/\[0\.04\]:hover { background: rgba(255,255,255,0.04); }
  .hover\:text-white:hover { color: #ffffff; }
  .text-\[\#5B6585\] { color: #5B6585; }
  .text-\[\#9AA7C7\] { color: #9AA7C7; }
  .text-\[\#C4B7FF\] { color: #C4B7FF; }
  .bg-white\/\[0\.04\] { background: rgba(255,255,255,0.04); }
  .bg-white\/\[0\.06\] { background: rgba(255,255,255,0.06); }
  .border-white\/\[0\.06\] { border: 1px solid rgba(255,255,255,0.06); }
  .border-white\/\[0\.1\] { border: 1px solid rgba(255,255,255,0.1); }
  .border-white\/10 { border: 1px solid rgba(255,255,255,0.1); }
  .opacity-30 { opacity: 0.3; }
</style>
</head>
<body>

<!-- 早期清理沙箱注入的 coze script（必须在 React mount 前执行，避免干扰） -->
<script>
  (function(){
    try {
      var s = document.querySelectorAll('script[src*="coze-space"], script[src*="coze-webapp"]');
      s.forEach(function(n){ if(n.parentNode) n.parentNode.removeChild(n); });
    } catch(e) {}
    // 同步监听后续注入
    var obs = new MutationObserver(function(ms){
      ms.forEach(function(m){
        m.addedNodes.forEach(function(n){
          if(n.tagName==='SCRIPT' && n.src && (n.src.indexOf('coze-space')>-1 || n.src.indexOf('coze-webapp')>-1)){
            n.parentNode && n.parentNode.removeChild(n);
          }
        });
      });
    });
    if(document.head) obs.observe(document.head, {childList:true});
  })();
</script>

<!-- ========== 顶部预览说明 ========== -->
<div class="max-w-1400 mx-auto px-8 pt-10">
  <div class="flex items-end justify-between mb-6">
    <div>
      <div class="text-xs tracking-[0.3em] uppercase mb-2" style="color:#5B6585">Design Preview</div>
      <h1 class="text-3xl font-bold">
        顶部导航 <span class="grad-text">+</span> 左侧栏 <span class="grad-text">方案对比</span>
      </h1>
      <p class="text-sm mt-2" style="color:#9AA7C7">3 套方案 · 3 个核心问题 · 切换查看</p>
    </div>
    <div class="flex gap-2">
      <span class="chip"><span class="badge-dot"></span>主色 #7C5CFF</span>
      <span class="chip" style="background:rgba(105,231,255,.10); color:#9EE9FF; border-color:rgba(105,231,255,.25)">强调 #69E7FF</span>
      <span class="chip" style="background:rgba(98,250,211,.10); color:#7AF5D2; border-color:rgba(98,250,211,.25)">成功 #62FAD3</span>
    </div>
  </div>

  <div class="glass rounded-2xl p-1 inline-flex gap-1 mb-8">
    <button class="switcher-btn active px-4 py-2 rounded-xl text-sm" data-target="plan-a">方案 A · 极简单线流 ⭐</button>
    <button class="switcher-btn px-4 py-2 rounded-xl text-sm" data-target="plan-b">方案 B · 玻璃胶囊对称</button>
    <button class="switcher-btn px-4 py-2 rounded-xl text-sm" data-target="plan-c">方案 C · 分层级联</button>
  </div>

  <div class="grid grid-cols-3 gap-4 mb-8">
    <div class="glass rounded-xl p-4">
      <div class="text-xs mb-2" style="color:#5B6585">问题 ① 分割策略</div>
      <div class="text-sm font-semibold mb-1">用渐变细线替代硬边框</div>
      <div class="text-xs" style="color:#9AA7C7">紫→青 1px 细线，柔和串联左右；弱化"两块东西"感</div>
    </div>
    <div class="glass rounded-xl p-4">
      <div class="text-xs mb-2" style="color:#5B6585">问题 ② 颜色搭配</div>
      <div class="text-sm font-semibold mb-1">主色驱动层级，淡色退场</div>
      <div class="text-xs" style="color:#9AA7C7">紫给主操作 / 当前态；青做强调；其余用 #9AA7C7 灰系退场</div>
    </div>
    <div class="glass rounded-xl p-4">
      <div class="text-xs mb-2" style="color:#5B6585">问题 ③ 风格统一</div>
      <div class="text-sm font-semibold mb-1">去外框 + 同一渐变语言</div>
      <div class="text-xs" style="color:#9AA7C7">顶部与左侧共享渐变 / 玻璃 / 1px 细线，融成一条视觉线</div>
    </div>
  </div>
</div>

<!-- =================== 方案 A · 极简单线流 =================== -->
<section id="plan-a" class="plan-section">
  <div class="max-w-1400 mx-auto px-8 mb-3">
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs" style="color:#5B6585">顶部导航栏 · 方案 A</span>
      <span class="text-xs" style="color:#5B6585">去外框 · 1px 渐变细线 · 当前 Tab 底部色块</span>
    </div>
  </div>
  <div class="max-w-1400 mx-auto px-8">
    <div class="nav-blur rounded-2xl px-6 py-3 glass" style="background:linear-gradient(180deg, rgba(11,15,31,0.7), rgba(11,15,31,0.4))">
      <div class="flex items-center justify-between gap-6">
        <div class="flex items-center gap-3" style="min-width:260px">
          <div class="relative">
            <div class="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm" style="background:linear-gradient(135deg,#7C5CFF,#69E7FF); box-shadow:0 0 16px rgba(124,92,255,0.45)">自</div>
            <div class="absolute" style="bottom:-2px; right:-2px; width:12px; height:12px; border-radius:999px; background:#62FAD3; border:2px solid #0B0F1F"></div>
          </div>
          <div class="leading-tight">
            <div class="text-sm font-semibold text-white">自媒体文案操盘手</div>
            <div class="text-xs" style="color:#9AA7C7">微信：Yuanqe1991xx · 会员</div>
          </div>
        </div>

        <div class="flex items-center gap-1">
          <button class="px-4 py-2 rounded-lg text-sm font-medium text-white tab-active flex items-center gap-2" style="background:rgba(255,255,255,0.02)">
            <span class="icon-tile" style="width:18px;height:18px;border-radius:5px">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </span>
            应用广场
          </button>
          <button class="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 hover:bg-white/[0.04] hover:text-white" style="color:#9AA7C7">
            <span class="icon-tile" style="width:18px;height:18px;border-radius:5px;background:linear-gradient(135deg,#FFB45C,#FF7A45);border-color:rgba(255,140,90,0.4)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </span>
            文案提取
          </button>
          <button class="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 hover:bg-white/[0.04] hover:text-white" style="color:#9AA7C7">
            <span class="icon-tile" style="width:18px;height:18px;border-radius:5px;background:linear-gradient(135deg,#62FAD3,#69E7FF);border-color:rgba(98,250,211,0.4)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
            </span>
            应用广场
          </button>
          <button class="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 hover:bg-white/[0.04] hover:text-white" style="color:#9AA7C7">
            <span class="icon-tile" style="width:18px;height:18px;border-radius:5px;background:linear-gradient(135deg,#FF6B9D,#C44BFF);border-color:rgba(196,75,255,0.4)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
            </span>
            分段工具
          </button>
          <button class="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 hover:bg-white/[0.04] hover:text-white" style="color:#9AA7C7">
            <span class="icon-tile" style="width:18px;height:18px;border-radius:5px;background:linear-gradient(135deg,#69E7FF,#7C5CFF);border-color:rgba(105,231,255,0.4)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
            </span>
            视频制作
          </button>
          <button class="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 hover:bg-white/[0.04] hover:text-white" style="color:#9AA7C7">
            <span class="icon-tile" style="width:18px;height:18px;border-radius:5px;background:linear-gradient(135deg,#A78BFA,#F0ABFC);border-color:rgba(167,139,250,0.4)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            </span>
            封面制作
          </button>
          <button class="px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 hover:bg-white/[0.04] hover:text-white" style="color:#9AA7C7">
            <span class="icon-tile" style="width:18px;height:18px;border-radius:5px;background:linear-gradient(135deg,#FF8AC8,#7C5CFF);border-color:rgba(255,138,200,0.4)">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
            </span>
            智音工坊
          </button>
        </div>

        <div class="flex items-center gap-3 justify-end" style="min-width:260px">
          <div class="text-xs" style="color:#5B6585">1.6 Core · 10.8 GB</div>
          <div class="w-px h-5 bg-white/10"></div>
          <button class="px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5" style="color:#9AA7C7">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            通知
          </button>
        </div>
      </div>
    </div>
  </div>
  <div class="max-w-1400 mx-auto px-8"><div class="gradient-line mt-3"></div></div>

  <div class="max-w-1400 mx-auto px-8 mt-6">
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs" style="color:#5B6585">左侧栏 · 方案 A（与顶部共享同一套渐变语言）</span>
      <span class="text-xs" style="color:#5B6585">用户卡 · 1px 细线 · 2×2 快捷网格 · 主 CTA</span>
    </div>
  </div>
  <div class="max-w-1400 mx-auto px-8">
    <div class="grid gap-6" style="grid-template-columns:280px 1fr">
      <aside class="glass rounded-2xl p-5" style="background:linear-gradient(180deg, rgba(11,15,31,0.6), rgba(11,15,31,0.3))">
        <div class="flex items-center gap-3">
          <div class="relative shrink-0">
            <div class="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold" style="background:linear-gradient(135deg,#7C5CFF,#69E7FF); box-shadow:0 0 18px rgba(124,92,255,0.4)">自</div>
            <div class="absolute" style="bottom:-2px; right:-2px; width:12px; height:12px; border-radius:999px; background:#62FAD3; border:2px solid #0B0F1F"></div>
          </div>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-white truncate">自媒体文案操盘手</div>
            <div class="text-xs truncate" style="color:#9AA7C7">微信：Yuanqe1991xx</div>
            <div class="flex items-center gap-1.5 mt-1">
              <span class="text-[10px] px-1.5 py-0.5 rounded" style="background:linear-gradient(135deg,#7C5CFF,#69E7FF);color:white;font-weight:600">VIP</span>
              <span class="text-[10px]" style="color:#5B6585">积分 5,000.5</span>
            </div>
          </div>
        </div>

        <div class="gradient-line my-5"></div>

        <div class="flex items-center justify-between mb-3">
          <span class="text-xs tracking-wider uppercase" style="color:#5B6585">快捷应用</span>
          <span class="text-[10px]" style="color:#5B6585">⌘K</span>
        </div>
        <div class="grid grid-cols-2 gap-2.5">
          <div class="quick-card rounded-xl p-3">
            <div class="icon-tile mb-2.5" style="background:linear-gradient(135deg,#7C5CFF,#A78BFA);border-color:rgba(124,92,255,0.4)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </div>
            <div class="text-xs font-semibold text-white">应用</div>
            <div class="text-[10px] mt-0.5" style="color:#5B6585">238 个</div>
          </div>
          <div class="quick-card rounded-xl p-3">
            <div class="icon-tile mb-2.5" style="background:linear-gradient(135deg,#FFB45C,#FF7A45);border-color:rgba(255,140,90,0.4)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </div>
            <div class="text-xs font-semibold text-white">提取</div>
            <div class="text-[10px] mt-0.5" style="color:#5B6585">文案/视频</div>
          </div>
          <div class="quick-card rounded-xl p-3">
            <div class="icon-tile mb-2.5" style="background:linear-gradient(135deg,#62FAD3,#69E7FF);border-color:rgba(98,250,211,0.4)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M3 7h18M3 12h18M3 17h12"/></svg>
            </div>
            <div class="text-xs font-semibold text-white">格式</div>
            <div class="text-[10px] mt-0.5" style="color:#5B6585">去除/转换</div>
          </div>
          <div class="quick-card rounded-xl p-3">
            <div class="icon-tile mb-2.5" style="background:linear-gradient(135deg,#FF6B9D,#C44BFF);border-color:rgba(196,75,255,0.4)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
            </div>
            <div class="text-xs font-semibold text-white">分段</div>
            <div class="text-[10px] mt-0.5" style="color:#5B6585">智能断句</div>
          </div>
        </div>

        <div class="gradient-line my-5"></div>

        <div class="flex items-center justify-between mb-3">
          <span class="text-xs tracking-wider uppercase" style="color:#5B6585">对话历史</span>
          <button class="text-[10px]" style="color:#9AA7C7">清空</button>
        </div>
        <div class="space-y-1 scrollbar overflow-y-auto" style="max-height:240px">
          <div class="flex items-center gap-2 px-2 py-1.5 rounded-lg" style="cursor:pointer">
            <div class="w-5 h-5 rounded shrink-0" style="background:linear-gradient(135deg,#7C5CFF,#A78BFA)"></div>
            <span class="text-xs truncate" style="color:#9AA7C7">爆款文案重构师</span>
            <span class="text-[10px] ml-auto shrink-0" style="color:#5B6585">02:06</span>
          </div>
          <div class="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/[0.06]" style="cursor:pointer; box-shadow:inset 2px 0 0 #7C5CFF">
            <div class="w-5 h-5 rounded shrink-0" style="background:linear-gradient(135deg,#7C5CFF,#69E7FF)"></div>
            <span class="text-xs text-white font-medium truncate">爆款文案重构师</span>
            <span class="text-[10px] ml-auto shrink-0" style="color:#5B6585">01:17</span>
          </div>
          <div class="flex items-center gap-2 px-2 py-1.5 rounded-lg" style="cursor:pointer">
            <div class="w-5 h-5 rounded shrink-0" style="background:linear-gradient(135deg,#62FAD3,#69E7FF)"></div>
            <span class="text-xs truncate" style="color:#9AA7C7">爆款文案重构师</span>
            <span class="text-[10px] ml-auto shrink-0" style="color:#5B6585">01:16</span>
          </div>
          <div class="flex items-center gap-2 px-2 py-1.5 rounded-lg" style="cursor:pointer">
            <div class="w-5 h-5 rounded shrink-0" style="background:linear-gradient(135deg,#FF6B9D,#C44BFF)"></div>
            <span class="text-xs truncate" style="color:#9AA7C7">AI 对话</span>
            <span class="text-[10px] ml-auto shrink-0" style="color:#5B6585">01:16</span>
          </div>
          <div class="flex items-center gap-2 px-2 py-1.5 rounded-lg" style="cursor:pointer">
            <div class="w-5 h-5 rounded shrink-0" style="background:linear-gradient(135deg,#FFB45C,#FF7A45)"></div>
            <span class="text-xs truncate" style="color:#9AA7C7">爆款文案重构师</span>
            <span class="text-[10px] ml-auto shrink-0" style="color:#5B6585">19:59</span>
          </div>
          <div class="flex items-center gap-2 px-2 py-1.5 rounded-lg" style="cursor:pointer">
            <div class="w-5 h-5 rounded shrink-0" style="background:linear-gradient(135deg,#69E7FF,#7C5CFF)"></div>
            <span class="text-xs truncate" style="color:#9AA7C7">百事通</span>
            <span class="text-[10px] ml-auto shrink-0" style="color:#5B6585">10:18</span>
          </div>
        </div>

        <div class="gradient-line my-5"></div>

        <button class="cta-btn w-full rounded-xl py-2.5 text-sm font-semibold flex items-center justify-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          新建对话
        </button>
      </aside>

      <main class="glass rounded-2xl p-6" style="background:linear-gradient(180deg, rgba(11,15,31,0.5), rgba(11,15,31,0.2))">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center gap-2">
            <span class="text-xs" style="color:#5B6585">次级导航</span>
            <div class="gradient-line-v h-3"></div>
            <div class="flex items-center gap-2">
              <button class="px-3.5 py-2 rounded-xl text-xs text-white flex items-center gap-2 shadow-sm" style="background:linear-gradient(135deg, rgba(124,92,255,0.25), rgba(105,231,255,0.15)); border:1px solid rgba(124,92,255,0.5)">
                <span class="icon-tile" style="width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#7C5CFF,#69E7FF);border-color:rgba(124,92,255,0.6);box-shadow:0 2px 6px rgba(124,92,255,0.35)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5" opacity="0.7"/><rect x="3" y="13" width="8" height="8" rx="1.5" opacity="0.7"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>
                </span>
                <span class="font-semibold">全部</span>
              </button>
              <button class="px-3.5 py-2 rounded-xl text-xs flex items-center gap-2 hover:bg-white/[0.05] hover:text-white transition-all border border-transparent hover:border-white/[0.08]" style="color:#9AA7C7">
                <span class="icon-tile" style="width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#FF6B6B,#FF8E53);border-color:rgba(255,107,107,0.5);box-shadow:0 2px 6px rgba(255,107,107,0.25)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M3 11l18-5v12L3 14v-3z" opacity="0.4"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/><circle cx="20" cy="5" r="1" opacity="0.9"/><circle cx="22" cy="3" r="0.7" opacity="0.7"/><path d="M5 6l-2 1.5L5 9" opacity="0.6"/></svg>
                </span>
                <span>引流带货</span>
              </button>
              <button class="px-3.5 py-2 rounded-xl text-xs flex items-center gap-2 hover:bg-white/[0.05] hover:text-white transition-all border border-transparent hover:border-white/[0.08]" style="color:#9AA7C7">
                <span class="icon-tile" style="width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#34D399,#10B981);border-color:rgba(52,211,153,0.5);box-shadow:0 2px 6px rgba(52,211,153,0.25)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M12 2L3 8h2v3h4v-2h6v2h4V8h2L12 2z" opacity="0.95"/><rect x="5" y="12" width="14" height="10" rx="1"/><rect x="10" y="15" width="4" height="7" fill="#10B981" opacity="0.5"/><rect x="7" y="14" width="2" height="2" fill="#FEF3C7" opacity="0.7"/><rect x="15" y="14" width="2" height="2" fill="#FEF3C7" opacity="0.7"/></svg>
                </span>
                <span>实体引流</span>
              </button>
              <button class="px-3.5 py-2 rounded-xl text-xs flex items-center gap-2 hover:bg-white/[0.05] hover:text-white transition-all border border-transparent hover:border-white/[0.08]" style="color:#9AA7C7">
                <span class="icon-tile" style="width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#A78BFA,#7C3AED);border-color:rgba(167,139,250,0.5);box-shadow:0 2px 6px rgba(167,139,250,0.3)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none"><circle cx="11" cy="8" r="3.5"/><path d="M4 20v-1a6 6 0 0 1 12 0v1H4z" opacity="0.95"/><path d="M17 2l1 1.5L20 2l-1 3.5-3-1 1.5-1.5L17 2z" fill="#FBBF24"/><path d="M16 5.5l1.5 1.5L19 5.5" stroke="#FBBF24" stroke-width="0.8" fill="none"/></svg>
                </span>
                <span>商业定位IP</span>
              </button>
              <button class="px-3.5 py-2 rounded-xl text-xs flex items-center gap-2 hover:bg-white/[0.05] hover:text-white transition-all border border-transparent hover:border-white/[0.08]" style="color:#9AA7C7">
                <span class="icon-tile" style="width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#22D3EE,#0EA5E9);border-color:rgba(34,211,238,0.5);box-shadow:0 2px 6px rgba(34,211,238,0.3)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none"><path d="M12 2L7 9h2.5v5L6 20h12l-3.5-6V9H17L12 2z" opacity="0.95"/><circle cx="12" cy="6" r="0.8" fill="#FBBF24"/><path d="M10 16h4l-0.8 2h-2.4L10 16z" opacity="0.7"/></svg>
                </span>
                <span>营销策略</span>
              </button>
              <button class="px-3.5 py-2 rounded-xl text-xs flex items-center gap-2 hover:bg-white/[0.05] hover:text-white transition-all border border-transparent hover:border-white/[0.08]" style="color:#9AA7C7">
                <span class="icon-tile" style="width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#F472B6,#EC4899);border-color:rgba(244,114,182,0.5);box-shadow:0 2px 6px rgba(244,114,182,0.3)">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none"><circle cx="12" cy="7" r="3.5"/><path d="M4 20v-1a7 7 0 0 1 14 0v1H4z" opacity="0.95"/><circle cx="12" cy="6.5" r="1.3" fill="#FCD34D"/><path d="M9.5 6.5h5v1.5h-5z" fill="#FCD34D"/></svg>
                </span>
                <span>自用</span>
              </button>
            </div>
          </div>
          <div class="flex items-center gap-2 text-xs">
            <div class="px-3 py-1.5 rounded-lg flex items-center gap-1.5" style="background:rgba(255,255,255,0.04); color:#9AA7C7; border:1px solid rgba(255,255,255,0.06); min-width:200px">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              搜索应用...
            </div>
          </div>
        </div>
        <div class="grid grid-cols-4 gap-3">
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#7C5CFF,#69E7FF)"></div><div class="text-xs font-semibold text-white">爆款文案重构师</div><div class="text-[10px] mt-1" style="color:#5B6585">二次创作优化...</div></div>
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#FFB45C,#FF7A45)"></div><div class="text-xs font-semibold text-white">爆单文案重构师</div><div class="text-[10px] mt-1" style="color:#5B6585">高转化带货...</div></div>
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#62FAD3,#69E7FF)"></div><div class="text-xs font-semibold text-white">爆款裂变选题</div><div class="text-[10px] mt-1" style="color:#5B6585">逆向拆解...</div></div>
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#FF6B9D,#C44BFF)"></div><div class="text-xs font-semibold text-white">宠物赛道口播</div><div class="text-[10px] mt-1" style="color:#5B6585">高频消费决策...</div></div>
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#A78BFA,#F0ABFC)"></div><div class="text-xs font-semibold text-white">2D 文案影像架构师</div><div class="text-[10px] mt-1" style="color:#5B6585">电影级 2D 动画...</div></div>
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#69E7FF,#7C5CFF)"></div><div class="text-xs font-semibold text-white">3D 文案影像架构师</div><div class="text-[10px] mt-1" style="color:#5B6585">3D 暖色治愈...</div></div>
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#FF8AC8,#7C5CFF)"></div><div class="text-xs font-semibold text-white">差异化爆单助手</div><div class="text-[10px] mt-1" style="color:#5B6585">高停留高转化...</div></div>
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#62FAD3,#7C5CFF)"></div><div class="text-xs font-semibold text-white">文案质检专家</div><div class="text-[10px] mt-1" style="color:#5B6585">逻辑漏洞排查...</div></div>
        </div>
      </main>
    </div>
  </div>
</section>

<!-- =================== 方案 B · 玻璃胶囊对称 =================== -->
<section id="plan-b" class="plan-section hidden">
  <div class="max-w-1400 mx-auto px-8 mb-3 mt-8">
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs" style="color:#5B6585">顶部导航栏 · 方案 B</span>
      <span class="text-xs" style="color:#5B6585">左右两块独立玻璃胶囊 · 视觉重量对等</span>
    </div>
  </div>
  <div class="max-w-1400 mx-auto px-8">
    <div class="flex items-center justify-between gap-4">
      <div class="glass-strong rounded-2xl px-4 py-2.5 flex items-center gap-3">
        <div class="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-sm" style="background:linear-gradient(135deg,#7C5CFF,#69E7FF); box-shadow:0 0 16px rgba(124,92,255,0.45)">自</div>
        <div class="leading-tight">
          <div class="text-sm font-semibold text-white">自媒体文案操盘手</div>
          <div class="text-xs" style="color:#9AA7C7">微信：Yuanqe1991xx</div>
        </div>
        <div class="w-px h-6 bg-white/10 mx-1"></div>
        <div class="flex items-center gap-1.5">
          <span class="text-[10px] px-1.5 py-0.5 rounded font-semibold" style="background:linear-gradient(135deg,#7C5CFF,#69E7FF);color:white">VIP</span>
          <span class="text-[10px]" style="color:#9AA7C7">5,000.5</span>
        </div>
      </div>

      <div class="glass-strong rounded-2xl px-2 py-1.5 flex items-center gap-0.5">
        <button class="px-3.5 py-1.5 rounded-xl text-sm font-medium text-white flex items-center gap-2" style="background:linear-gradient(135deg,rgba(124,92,255,0.3),rgba(105,231,255,0.15));box-shadow:inset 0 0 0 1px rgba(124,92,255,0.4)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
          应用广场
        </button>
        <button class="px-3.5 py-1.5 rounded-xl text-sm font-medium flex items-center gap-2" style="color:#9AA7C7">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          文案提取
        </button>
        <button class="px-3.5 py-1.5 rounded-xl text-sm font-medium flex items-center gap-2" style="color:#9AA7C7">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
          应用广场
        </button>
        <button class="px-3.5 py-1.5 rounded-xl text-sm font-medium flex items-center gap-2" style="color:#9AA7C7">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
          分段工具
        </button>
        <button class="px-3.5 py-1.5 rounded-xl text-sm font-medium flex items-center gap-2" style="color:#9AA7C7">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
          视频制作
        </button>
        <button class="px-3.5 py-1.5 rounded-xl text-sm font-medium flex items-center gap-2" style="color:#9AA7C7">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          封面制作
        </button>
        <button class="px-3.5 py-1.5 rounded-xl text-sm font-medium flex items-center gap-2" style="color:#9AA7C7">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
          智音工坊
        </button>
      </div>

      <div class="glass-strong rounded-2xl px-3 py-2.5 flex items-center gap-2">
        <div class="text-[10px]" style="color:#5B6585">1.6 Core</div>
        <div class="w-px h-4 bg-white/10"></div>
        <button class="w-7 h-7 rounded-lg flex items-center justify-center" style="color:#9AA7C7">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/></svg>
        </button>
      </div>
    </div>
  </div>
  <div class="max-w-1400 mx-auto px-8"><div class="gradient-line mt-3"></div></div>

  <div class="max-w-1400 mx-auto px-8 mt-6">
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs" style="color:#5B6585">左侧栏 · 方案 B（与顶部用同样的玻璃胶囊）</span>
      <span class="text-xs" style="color:#5B6585">完全对称 · 风格最强统一感</span>
    </div>
  </div>
  <div class="max-w-1400 mx-auto px-8">
    <div class="grid gap-6" style="grid-template-columns:280px 1fr">
      <aside class="glass-strong rounded-2xl p-5">
        <div class="glass rounded-xl p-3 flex items-center gap-3">
          <div class="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm" style="background:linear-gradient(135deg,#7C5CFF,#69E7FF)">自</div>
          <div class="min-w-0 flex-1">
            <div class="text-sm font-semibold text-white truncate">自媒体文案操盘手</div>
            <div class="text-[10px] truncate" style="color:#9AA7C7">微信：Yuanqe1991xx</div>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2 mt-3">
          <div class="glass rounded-lg p-2.5 text-center">
            <div class="w-8 h-8 rounded-lg mx-auto mb-1.5 flex items-center justify-center" style="background:linear-gradient(135deg,#7C5CFF,#A78BFA)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </div>
            <div class="text-xs text-white">应用</div>
          </div>
          <div class="glass rounded-lg p-2.5 text-center">
            <div class="w-8 h-8 rounded-lg mx-auto mb-1.5 flex items-center justify-center" style="background:linear-gradient(135deg,#FFB45C,#FF7A45)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg>
            </div>
            <div class="text-xs text-white">提取</div>
          </div>
          <div class="glass rounded-lg p-2.5 text-center">
            <div class="w-8 h-8 rounded-lg mx-auto mb-1.5 flex items-center justify-center" style="background:linear-gradient(135deg,#62FAD3,#69E7FF)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M3 7h18M3 12h18M3 17h12"/></svg>
            </div>
            <div class="text-xs text-white">格式</div>
          </div>
          <div class="glass rounded-lg p-2.5 text-center">
            <div class="w-8 h-8 rounded-lg mx-auto mb-1.5 flex items-center justify-center" style="background:linear-gradient(135deg,#FF6B9D,#C44BFF)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0"/></svg>
            </div>
            <div class="text-xs text-white">分段</div>
          </div>
        </div>
        <button class="cta-btn w-full rounded-xl py-2.5 text-sm font-semibold flex items-center justify-center gap-2 mt-4">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          新建对话
        </button>
        <div class="text-[10px] mt-3 text-center" style="color:#5B6585">对话历史 · 32 条</div>
      </aside>
      <main class="glass-strong rounded-2xl p-6">
        <div class="text-xs mb-3" style="color:#5B6585">主内容区域（与方案 A 一致，此处省略）</div>
        <div class="grid grid-cols-4 gap-3">
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#7C5CFF,#69E7FF)"></div><div class="text-xs font-semibold text-white">爆款文案重构师</div><div class="text-[10px] mt-1" style="color:#5B6585">二次创作优化...</div></div>
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#FFB45C,#FF7A45)"></div><div class="text-xs font-semibold text-white">爆单文案重构师</div><div class="text-[10px] mt-1" style="color:#5B6585">高转化带货...</div></div>
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#62FAD3,#69E7FF)"></div><div class="text-xs font-semibold text-white">爆款裂变选题</div><div class="text-[10px] mt-1" style="color:#5B6585">逆向拆解...</div></div>
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#FF6B9D,#C44BFF)"></div><div class="text-xs font-semibold text-white">宠物赛道口播</div><div class="text-[10px] mt-1" style="color:#5B6585">高频消费决策...</div></div>
        </div>
      </main>
    </div>
  </div>
</section>

<!-- =================== 方案 C · 分层级联 =================== -->
<section id="plan-c" class="plan-section hidden">
  <div class="max-w-1400 mx-auto px-8 mb-3 mt-8">
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs" style="color:#5B6585">顶部导航栏 · 方案 C</span>
      <span class="text-xs" style="color:#5B6585">三段式分层：品牌 / 细线 / 功能 / 细线 / 状态</span>
    </div>
  </div>
  <div class="max-w-1400 mx-auto px-8">
    <div class="rounded-2xl px-5 py-2.5 glass flex items-center justify-between" style="background:linear-gradient(180deg, rgba(11,15,31,0.7), rgba(11,15,31,0.4))">
      <div class="flex items-center gap-2.5" style="min-width:200px">
        <div class="w-8 h-8 rounded-lg flex items-center justify-center" style="background:linear-gradient(135deg,#7C5CFF,#69E7FF); box-shadow:0 0 12px rgba(124,92,255,0.5)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
        </div>
        <div>
          <div class="text-sm font-bold text-white">Agent Hub</div>
          <div class="text-[10px]" style="color:#5B6585">自媒体操盘手</div>
        </div>
      </div>

      <div class="gradient-line-v h-6"></div>

      <div class="flex items-center gap-0.5">
        <button class="px-3 py-1.5 rounded-lg text-sm font-semibold text-white flex items-center gap-2" style="background:rgba(124,92,255,0.18);box-shadow:inset 0 0 0 1px rgba(124,92,255,0.35)">
          <span class="w-1.5 h-1.5 rounded-full" style="background:#7C5CFF;box-shadow:0 0 6px #7C5CFF"></span>
          应用广场
        </button>
        <button class="px-3 py-1.5 rounded-lg text-sm" style="color:#9AA7C7">文案提取</button>
        <button class="px-3 py-1.5 rounded-lg text-sm" style="color:#9AA7C7">应用广场</button>
        <button class="px-3 py-1.5 rounded-lg text-sm" style="color:#9AA7C7">分段工具</button>
        <button class="px-3 py-1.5 rounded-lg text-sm" style="color:#9AA7C7">视频制作</button>
        <button class="px-3 py-1.5 rounded-lg text-sm" style="color:#9AA7C7">封面制作</button>
        <button class="px-3 py-1.5 rounded-lg text-sm" style="color:#9AA7C7">智音工坊</button>
      </div>

      <div class="gradient-line-v h-6"></div>

      <div class="flex items-center gap-2.5 justify-end" style="min-width:200px">
        <div class="px-2.5 py-1 rounded-md text-[10px]" style="background:rgba(255,255,255,0.04); color:#9AA7C7; border:1px solid rgba(255,255,255,0.06)">1.6 Core</div>
        <div class="w-7 h-7 rounded-full flex items-center justify-center text-white font-bold text-[11px]" style="background:linear-gradient(135deg,#7C5CFF,#69E7FF)">自</div>
      </div>
    </div>
  </div>
  <div class="max-w-1400 mx-auto px-8"><div class="gradient-line mt-3"></div></div>

  <div class="max-w-1400 mx-auto px-8 mt-6">
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs" style="color:#5B6585">左侧栏 · 方案 C（信息密度最高，每段间都有细线）</span>
      <span class="text-xs" style="color:#5B6585">四段分层 · 视觉秩序最强</span>
    </div>
  </div>
  <div class="max-w-1400 mx-auto px-8">
    <div class="grid gap-6" style="grid-template-columns:280px 1fr">
      <aside class="glass rounded-2xl p-5" style="background:linear-gradient(180deg, rgba(11,15,31,0.6), rgba(11,15,31,0.3))">
        <div class="flex items-center gap-3">
          <div class="w-11 h-11 rounded-xl flex items-center justify-center text-white font-bold" style="background:linear-gradient(135deg,#7C5CFF,#69E7FF);box-shadow:0 0 16px rgba(124,92,255,0.4)">自</div>
          <div class="min-w-0">
            <div class="text-sm font-semibold text-white truncate">自媒体文案操盘手</div>
            <div class="text-[10px]" style="color:#9AA7C7">VIP · 5,000.5 积分</div>
          </div>
        </div>
        <div class="gradient-line my-4"></div>
        <div class="text-[10px] tracking-widest uppercase mb-2" style="color:#5B6585">快捷应用</div>
        <div class="space-y-1">
          <div class="flex items-center gap-3 px-2.5 py-2 rounded-lg" style="background:rgba(255,255,255,0.04)">
            <div class="w-7 h-7 rounded-md flex items-center justify-center" style="background:linear-gradient(135deg,#7C5CFF,#A78BFA)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </div>
            <span class="text-sm text-white font-medium">应用广场</span>
            <span class="ml-auto text-[10px]" style="color:#5B6585">238</span>
          </div>
          <div class="flex items-center gap-3 px-2.5 py-2 rounded-lg" style="cursor:pointer">
            <div class="w-7 h-7 rounded-md flex items-center justify-center" style="background:linear-gradient(135deg,#FFB45C,#FF7A45)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg>
            </div>
            <span class="text-sm" style="color:#9AA7C7">文案提取</span>
          </div>
          <div class="flex items-center gap-3 px-2.5 py-2 rounded-lg" style="cursor:pointer">
            <div class="w-7 h-7 rounded-md flex items-center justify-center" style="background:linear-gradient(135deg,#62FAD3,#69E7FF)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
            </div>
            <span class="text-sm" style="color:#9AA7C7">应用广场</span>
          </div>
          <div class="flex items-center gap-3 px-2.5 py-2 rounded-lg" style="cursor:pointer">
            <div class="w-7 h-7 rounded-md flex items-center justify-center" style="background:linear-gradient(135deg,#FF6B9D,#C44BFF)">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0"/></svg>
            </div>
            <span class="text-sm" style="color:#9AA7C7">分段工具</span>
          </div>
        </div>
        <div class="gradient-line my-4"></div>
        <div class="text-[10px] tracking-widest uppercase mb-2" style="color:#5B6585">对话历史</div>
        <div class="space-y-1 scrollbar overflow-y-auto" style="max-height:200px">
          <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg" style="background:rgba(255,255,255,0.06); box-shadow:inset 2px 0 0 #7C5CFF">
            <span class="text-xs text-white font-medium">爆款文案重构师</span>
            <span class="text-[10px] ml-auto" style="color:#5B6585">02:06</span>
          </div>
          <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg" style="cursor:pointer">
            <span class="text-xs" style="color:#9AA7C7">爆款文案重构师</span>
            <span class="text-[10px] ml-auto" style="color:#5B6585">01:17</span>
          </div>
          <div class="flex items-center gap-2 px-2.5 py-1.5 rounded-lg" style="cursor:pointer">
            <span class="text-xs" style="color:#9AA7C7">AI 对话</span>
            <span class="text-[10px] ml-auto" style="color:#5B6585">01:16</span>
          </div>
        </div>
        <div class="gradient-line my-4"></div>
        <button class="cta-btn w-full rounded-xl py-2.5 text-sm font-semibold flex items-center justify-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          新建对话
        </button>
      </aside>
      <main class="glass rounded-2xl p-6">
        <div class="text-xs mb-3" style="color:#5B6585">主内容区域（与方案 A 一致，此处省略）</div>
        <div class="grid grid-cols-4 gap-3">
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#7C5CFF,#69E7FF)"></div><div class="text-xs font-semibold text-white">爆款文案重构师</div><div class="text-[10px] mt-1" style="color:#5B6585">二次创作优化...</div></div>
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#FFB45C,#FF7A45)"></div><div class="text-xs font-semibold text-white">爆单文案重构师</div><div class="text-[10px] mt-1" style="color:#5B6585">高转化带货...</div></div>
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#62FAD3,#69E7FF)"></div><div class="text-xs font-semibold text-white">爆款裂变选题</div><div class="text-[10px] mt-1" style="color:#5B6585">逆向拆解...</div></div>
          <div class="rounded-xl p-3 glass"><div class="aspect-[16/10] rounded-lg mb-2" style="background:linear-gradient(135deg,#FF6B9D,#C44BFF)"></div><div class="text-xs font-semibold text-white">宠物赛道口播</div><div class="text-[10px] mt-1" style="color:#5B6585">高频消费决策...</div></div>
        </div>
      </main>
    </div>
  </div>
</section>

<!-- ========== 底部对比说明 ========== -->
<div class="max-w-1400 mx-auto px-8 mt-16 mb-16">
  <div class="text-center mb-8">
    <h2 class="text-2xl font-bold mb-2">怎么选？</h2>
    <p class="text-sm" style="color:#9AA7C7">从你关心的三个角度对比</p>
  </div>
  <div class="grid grid-cols-3 gap-4">
    <div class="glass rounded-2xl p-6">
      <div class="flex items-center gap-2 mb-3">
        <div class="w-6 h-6 rounded-md" style="background:linear-gradient(135deg,#7C5CFF,#69E7FF)"></div>
        <span class="text-sm font-bold text-white">方案 A · 极简单线流</span>
        <span class="text-[10px] px-1.5 py-0.5 rounded ml-auto" style="background:rgba(124,92,255,0.2);color:#C4B7FF">推荐</span>
      </div>
      <div class="text-xs space-y-1.5" style="color:#9AA7C7">
        <div>✅ 分割：1px 渐变细线，柔和串联</div>
        <div>✅ 颜色：主紫驱动层级，淡色退场</div>
        <div>✅ 统一：去外框共享渐变语言</div>
        <div>⚠️ 视觉重量：左侧栏最丰富，顶部较轻</div>
      </div>
    </div>
    <div class="glass rounded-2xl p-6">
      <div class="flex items-center gap-2 mb-3">
        <div class="w-6 h-6 rounded-md" style="background:linear-gradient(135deg,#FFB45C,#FF7A45)"></div>
        <span class="text-sm font-bold text-white">方案 B · 玻璃胶囊对称</span>
      </div>
      <div class="text-xs space-y-1.5" style="color:#9AA7C7">
        <div>✅ 分割：左右各一块玻璃胶囊</div>
        <div>✅ 颜色：胶囊强化玻璃质感</div>
        <div>✅ 统一：完全对称，风格最强</div>
        <div>⚠️ 顶部被切成三段，可能有"塞满"感</div>
      </div>
    </div>
    <div class="glass rounded-2xl p-6">
      <div class="flex items-center gap-2 mb-3">
        <div class="w-6 h-6 rounded-md" style="background:linear-gradient(135deg,#62FAD3,#69E7FF)"></div>
        <span class="text-sm font-bold text-white">方案 C · 分层级联</span>
      </div>
      <div class="text-xs space-y-1.5" style="color:#9AA7C7">
        <div>✅ 分割：每段都有细线，秩序感强</div>
        <div>✅ 颜色：信息密度最高</div>
        <div>✅ 统一：左右都用同一套"段+线"语言</div>
        <div>⚠️ 视觉偏理性，可能少了点"灵动"</div>
      </div>
    </div>
  </div>
  <div class="text-center mt-10 text-xs" style="color:#5B6585">
    点击顶部按钮可切换方案预览 · 确定方案后告诉我"用 A" / "用 B" / "用 C" 即开始改代码
  </div>
</div>

<script>
  document.querySelectorAll('.switcher-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      document.querySelectorAll('.switcher-btn').forEach(b => {
        b.classList.remove('active');
      });
      btn.classList.add('active');
      document.querySelectorAll('.plan-section').forEach(sec => {
        sec.classList.toggle('hidden', sec.id !== target);
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
</script>

</body>
</html>`;

export default function DesignPreview() {
  const { state, checkAuth } = useApp();
  const [authResolved, setAuthResolved] = useState(false);
  const isAdmin = state.auth.user?.role === 'admin';

  useEffect(() => {
    let active = true;
    void checkAuth().finally(() => {
      if (active) setAuthResolved(true);
    });
    return () => {
      active = false;
    };
  }, [checkAuth]);

  useEffect(() => {
    if (!authResolved || !isAdmin) return;

    // 1. 移除沙箱注入到 head 的 coze 脚本（避免它们挂载 React 组件覆盖我的内容）
    const cozeScripts = document.querySelectorAll(
      'script[src*="coze-space"], script[src*="coze-webapp"]'
    );
    cozeScripts.forEach((s) => s.remove());

    // 2. 注入 Inter 字体
    const fontLink = document.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href =
      'https://fonts.googleapis.cn/css2?family=Inter:wght@400;500;600;700;800&family=Manrope:wght@500;600;700&display=swap';
    document.head.appendChild(fontLink);

    // 3. 监听新的 coze 注入（如果沙箱在 React mount 后再次注入），立即移除
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        m.addedNodes.forEach((rawNode) => {
          const node = rawNode as HTMLScriptElement;
          if (
            node.nodeName === 'SCRIPT' &&
            (node.src?.includes('coze-space') || node.src?.includes('coze-webapp'))
          ) {
            node.remove();
          }
        });
      });
    });
    observer.observe(document.head, { childList: true });

    return () => {
      observer.disconnect();
      fontLink.remove();
    };
  }, [authResolved, isAdmin]);

  if (!authResolved) {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#070A14', color: '#F7FAFF' }}>
        <section style={{ width: 'min(520px, 100%)', padding: 32, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 18, background: 'rgba(15,23,42,0.88)', textAlign: 'center' }}>
          <p style={{ margin: 0, color: '#9AA7C7' }}>正在验证管理员身份…</p>
        </section>
      </main>
    );
  }

  if (!isAdmin) {
    const authenticated = state.auth.isAuthenticated;
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: '#070A14', color: '#F7FAFF' }}>
        <section style={{ width: 'min(520px, 100%)', padding: 32, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 18, background: 'rgba(15,23,42,0.88)', textAlign: 'center' }}>
          <p style={{ margin: '0 0 8px', color: '#9AA7C7' }}>内部设计预览</p>
          <h1 style={{ margin: '0 0 12px', fontSize: 24 }}>仅管理员可访问</h1>
          <p style={{ margin: '0 0 24px', color: '#9AA7C7', lineHeight: 1.7 }}>
            {authenticated ? '当前账号没有管理员权限。' : '请先使用管理员账号登录。'}
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 12 }}>
            <Link
              href={authenticated ? '/help' : '/login?redirect=%2Fdesign-preview'}
              style={{ padding: '10px 16px', borderRadius: 10, background: '#7C5CFF', color: '#fff', textDecoration: 'none' }}
            >
              {authenticated ? '返回学习中心' : '管理员登录'}
            </Link>
            <Link
              href="/"
              style={{ padding: '10px 16px', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 10, color: '#F7FAFF', textDecoration: 'none' }}
            >
              返回主页
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <div
      style={{ minHeight: '100vh', background: '#070A14' }}
      dangerouslySetInnerHTML={{ __html: HTML_CONTENT }}
    />
  );
}
