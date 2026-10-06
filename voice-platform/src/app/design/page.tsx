'use client';

import React, { useState, useEffect } from 'react';
import Button from '@/components/ui/Button';
import Select from '@/components/ui/Select';
import FileUpload from '@/components/FileUpload';
import AudioPlayer from '@/components/AudioPlayer';

const DEFAULT_TEMPLATES = [
  { label: '温柔女友', prompt: '女性，年轻，声音温柔甜美，语速偏慢，带着撒娇和亲昵感，适合情感陪伴场景' },
  { label: '沉稳播音', prompt: '男性，中年，声音低沉浑厚，咬字清晰有力，语速适中，适合新闻播报和纪录片配音' },
  { label: '活泼少女', prompt: '女性，年轻，声音清脆明亮，语速偏快，充满活力和朝气，适合短视频和广告' },
  { label: '磁性大叔', prompt: '男性，中年，声音沙哑磁性，语速偏慢，带有故事感和沧桑感，适合有声书和情感电台' },
  { label: '专业客服', prompt: '女性，青年，声音清晰温和，语速均匀，态度专业友好，适合客服中心和 IVR 语音' },
  { label: '少年热血', prompt: '男性，少年，声音清亮有穿透力，语速偏快，充满激情和热血感，适合动漫和游戏配音' },
];

interface Template { label: string; prompt: string }

export default function DesignPage() {
  const [textPrompt, setTextPrompt] = useState('');
  const [imageBase64, setImageBase64] = useState('');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [demoText, setDemoText] = useState('你好，这是我为你设计的新声音，希望能满足你的需求。');
  const [language, setLanguage] = useState('0');
  const [voiceName, setVoiceName] = useState('');
  const [designing, setDesigning] = useState(false);
  const [result, setResult] = useState<{ speakerId: string; demoAudio?: string; status: number } | null>(null);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState('');
  const [availableTimes, setAvailableTimes] = useState<number | null>(null);
  const [designStartTime, setDesignStartTime] = useState<number | null>(null);
  const [designDuration, setDesignDuration] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [voiceSaved, setVoiceSaved] = useState(false);
  const [licenseKey, setLicenseKey] = useState('');
  const [licenseVerified, setLicenseVerified] = useState(false);
  const [licenseError, setLicenseError] = useState('');

  const verifyLicense = async () => {
    setLicenseError('');
    try {
      const res = await fetch('/voice-platform/api/license/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: licenseKey.trim() }),
      });
      const d = await res.json();
      if (d.success) {
        setLicenseVerified(true);
      } else {
        setLicenseError(d.message || '密钥无效');
      }
    } catch {
      setLicenseError('验证失败，请重试');
    }
  };

  // 模板库
  const [templates, setTemplates] = useState<Template[]>([]);
  useEffect(() => {
    const saved = localStorage.getItem('design_templates');
    setTemplates(saved ? JSON.parse(saved) : DEFAULT_TEMPLATES);
  }, []);

  const persistTemplates = (list: Template[]) => {
    setTemplates(list);
    localStorage.setItem('design_templates', JSON.stringify(list));
  };

  // 弹窗
  const [modalOpen, setModalOpen] = useState(false);
  const [modalLabel, setModalLabel] = useState('');
  const [modalPrompt, setModalPrompt] = useState('');
  const [editIndex, setEditIndex] = useState<number | null>(null);

  const openAddModal = (prefillLabel = '', prefillPrompt = '') => {
    setModalLabel(prefillLabel);
    setModalPrompt(prefillPrompt);
    setEditIndex(null);
    setModalOpen(true);
  };

  const openEditModal = (idx: number) => {
    const t = templates[idx];
    setModalLabel(t.label);
    setModalPrompt(t.prompt);
    setEditIndex(idx);
    setModalOpen(true);
  };

  const handleModalSave = () => {
    if (!modalLabel.trim() || !modalPrompt.trim()) return;
    if (editIndex !== null) {
      const next = [...templates];
      next[editIndex] = { label: modalLabel.trim(), prompt: modalPrompt.trim() };
      persistTemplates(next);
    } else {
      persistTemplates([...templates, { label: modalLabel.trim(), prompt: modalPrompt.trim() }]);
    }
    setModalOpen(false);
  };

  const deleteTemplate = (idx: number) => {
    persistTemplates(templates.filter((_, i) => i !== idx));
  };

  const handleImageChange = async (file: File) => {
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = () => { const r = reader.result as string; setImageBase64(r.split(',')[1] || r); };
    reader.readAsDataURL(file);
  };

  const handleDesign = async () => {
    if (!textPrompt.trim() && !imageBase64) { setError('请输入文本描述或上传图片参考'); return; }
    setError('');
    setDesigning(true);
    setDesignStartTime(Date.now());
    setStatusText('正在提交声音设计...');
    try {
      const sid = `D_${Date.now()}`;
      const res = await fetch('/voice-platform/api/voice/design', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          speakerId: sid, text: demoText,
          prompt: { textPrompt: textPrompt || undefined, imageBytes: imageBase64 || undefined },
          language: parseInt(language), name: voiceName.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setAvailableTimes(data.data.availableTrainingTimes ?? null);
        if (data.data.status === 2 || data.data.status === 4) {
          setStatusText('设计成功！');
          setResult({ speakerId: data.data.speakerId, demoAudio: data.data.demoAudio, status: data.data.status });
          setDesigning(false);
        } else {
          setStatusText('训练中...');
          pollDesignStatus(data.data.speakerId);
        }
      } else {
        setError(data.message || '声音设计失败'); setDesigning(false);
      }
    } catch {
      setError('网络错误，请重试'); setDesigning(false);
    }
  };

  const pollDesignStatus = async (sid: string) => {
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const res = await fetch(`/voice-platform/api/voice/status?speakerId=${sid}`);
        const data = await res.json();
        if (data.success) {
          if (data.data.status === 2 || data.data.status === 4) {
            setResult({ speakerId: sid, demoAudio: data.data.speakerStatus?.[0]?.demoAudio || '', status: data.data.status });
            setDesigning(false); return;
          }
          setStatusText(`训练中...（${i+1}/100）`);
        }
      } catch {}
    }
    setError('轮询超时'); setDesigning(false);
  };

  const copySpeakerId = async () => {
    try { await navigator.clipboard.writeText(result?.speakerId || ''); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  };

  const formatDuration = (sec: number) => (sec < 60 ? `${sec}秒` : `${Math.floor(sec / 60)}分${sec % 60}秒`);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      {/* 标题 */}
      <div className="text-center mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <span className="h-2.5 w-2.5 rounded-full bg-violet-400 shadow-[0_0_16px_rgba(167,139,250,0.7)] animate-pulse" />
          <span className="text-[11px] uppercase tracking-[0.32em] text-violet-300/80">AI Voice Designer</span>
        </div>
        <h1 className="text-4xl font-bold text-vp-foreground tracking-tight">声音设计</h1>
        <p className="mt-3 text-vp-muted-foreground">通过文字描述或图片参考，让 AI 为你创造独一无二的音色</p>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-400/20 rounded-xl p-4 text-sm text-rose-300 mb-6 text-center">{error}</div>
      )}

      {/* ===== 第1行：模板库 + 图片参考（左右对称等高） ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* 左：模板库 */}
        <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-6 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-vp-foreground flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg bg-violet-400/15 flex items-center justify-center text-violet-300 text-xs font-bold">◈</span>
              Prompt 模板库
            </h3>
            <button
              onClick={() => openAddModal()}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-xl bg-violet-400/10 text-violet-300 border border-violet-400/20 hover:bg-violet-400/20 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
              新建
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 mb-4">
            {templates.map((t, i) => (
              <div key={i} className="group relative">
                <button
                  onClick={() => setTextPrompt(t.prompt)}
                  className={`w-full text-left px-3 py-3 rounded-xl border transition-all duration-200 ${
                    textPrompt === t.prompt
                      ? 'border-violet-400/40 bg-violet-400/10 text-violet-100 shadow-[0_0_12px_rgba(167,139,250,0.15)]'
                      : 'border-vp-border bg-slate-950/30 text-vp-muted-foreground hover:border-violet-400/25 hover:text-slate-200'
                  }`}
                >
                  <div className="text-sm font-semibold">{t.label}</div>
                  <div className="text-[11px] text-vp-muted-foreground mt-0.5 truncate">{t.prompt.slice(0, 22)}...</div>
                </button>
                {/* 操作按钮组 */}
                <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  {i >= DEFAULT_TEMPLATES.length && (
                    <>
                      <button
                        onClick={(e) => { e.stopPropagation(); openEditModal(i); }}
                        className="w-5 h-5 rounded bg-sky-400/15 text-vp-primary text-[10px] flex items-center justify-center hover:bg-sky-400/30"
                        title="编辑"
                      >✎</button>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteTemplate(i); }}
                        className="w-5 h-5 rounded bg-rose-400/15 text-rose-300 text-[10px] flex items-center justify-center hover:bg-rose-400/30"
                        title="删除"
                      >×</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-vp-muted-foreground mt-auto">
            {templates.length} 个模板 · 点击应用 · 悬停编辑/删除 · 永久保存
          </p>
        </div>

        {/* 右：图片参考 */}
        <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-6 flex flex-col">
          <h3 className="text-lg font-semibold text-vp-foreground mb-4 flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-amber-400/15 flex items-center justify-center text-amber-300 text-xs font-bold">◆</span>
            图片参考
            <span className="text-xs text-vp-muted-foreground font-normal">（可选）</span>
          </h3>
          <div className="flex-1">
            <FileUpload accept="image/jpeg,image/png,image/webp" maxSize={10 * 1024 * 1024} onChange={handleImageChange} />
            {imageFile && (
              <div className="mt-3 flex items-center gap-3">
                <img src={URL.createObjectURL(imageFile)} alt="" className="w-14 h-14 rounded-xl object-cover ring-1 ring-violet-400/30" />
                <div>
                  <p className="text-xs text-vp-foreground">{imageFile.name}</p>
                  <button onClick={() => { setImageFile(null); setImageBase64(''); }} className="text-[10px] text-rose-400 hover:text-rose-300 mt-0.5">移除</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ===== 第2行：文案描述 + 试听文本（左右对称等高） ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* 左：文案描述 */}
        <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-6 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-vp-foreground flex items-center gap-2">
              <span className="w-7 h-7 rounded-lg bg-sky-400/15 flex items-center justify-center text-vp-primary text-xs font-bold">T</span>
              文案描述
            </h3>
            {textPrompt.trim() && (
              <button
                onClick={() => openAddModal('', textPrompt)}
                className="text-[11px] px-2 py-1 rounded-lg bg-violet-400/10 text-violet-300 border border-violet-400/20 hover:bg-violet-400/20 transition-colors"
              >
                存为模板
              </button>
            )}
          </div>
          <textarea
            value={textPrompt}
            onChange={(e) => setTextPrompt(e.target.value)}
            placeholder="描述你想要的音色特征，例如：女性，年轻，声音温柔甜美，语速偏慢..."
            rows={5}
            maxLength={200}
            className="flex-1 w-full rounded-xl border border-vp-border bg-vp-card/40 px-4 py-3 text-sm text-vp-foreground placeholder:text-vp-muted-foreground focus:border-violet-400/40 focus:outline-none resize-none"
          />
          <p className="text-xs text-vp-muted-foreground text-right mt-1">{textPrompt.length}/200</p>
        </div>

        {/* 右：试听文本 */}
        <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-6 flex flex-col">
          <h3 className="text-lg font-semibold text-vp-foreground mb-4 flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg bg-emerald-400/15 flex items-center justify-center text-emerald-300 text-xs font-bold">♪</span>
            试听文本
          </h3>
          <textarea
            value={demoText}
            onChange={(e) => setDemoText(e.target.value)}
            rows={5}
            maxLength={300}
            className="flex-1 w-full rounded-xl border border-vp-border bg-vp-card/40 px-4 py-3 text-sm text-vp-foreground placeholder:text-vp-muted-foreground focus:border-emerald-400/40 focus:outline-none resize-none"
          />
          <p className="text-xs text-vp-muted-foreground text-right mt-1">{demoText.length}/300</p>
        </div>
      </div>

      {/* ===== 第3行：开始设计按钮 ===== */}
      <div className="mb-6">
        {!licenseVerified ? (
          <div className="p-4 rounded-xl bg-amber-400/5 border border-amber-400/15">
            <p className="text-sm text-amber-200 mb-3">🔑 输入授权密钥</p>
            <p className="text-xs text-vp-muted-foreground mb-3">
              声音设计消耗音色槽位（138元/个，15次训练）。<br/>
              请联系管理员获取授权密钥。
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value)}
                placeholder="输入密钥，如 ZY-XXXX-XXXX"
                className="flex-1 rounded-xl border border-amber-400/30 bg-vp-background/60 px-3 py-2 text-sm text-slate-200 placeholder:text-vp-muted-foreground"
              />
              <Button variant="primary" size="sm" onClick={verifyLicense}>
                验证
              </Button>
            </div>
            {licenseError && <p className="text-xs text-red-400 mt-2">{licenseError}</p>}
          </div>
        ) : (
          <>
            <div className="text-xs text-emerald-400 bg-emerald-400/5 rounded-lg px-3 py-2 border border-emerald-400/15 mb-3 text-center">
              ✅ 密钥验证通过 · 可使用1个音槽（15次训练）
            </div>
            <Button variant="primary" size="lg" loading={designing} onClick={handleDesign} className="w-full" disabled={!textPrompt.trim() && !imageBase64}>
              {designing ? statusText : '✦ 开始设计'}
            </Button>
            {availableTimes !== null && (
              <div className="mt-3 text-xs text-vp-primary bg-sky-400/10 rounded-lg px-3 py-2 border border-vp-border text-center">
                剩余设计次数：{availableTimes}
              </div>
            )}
          </>
        )}
      </div>

      {/* 训练中 */}
      {designing && (
        <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-8 text-center mb-6">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-violet-400/10 flex items-center justify-center mb-4">
            <svg className="w-7 h-7 text-violet-300 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
          <p className="text-sm text-vp-muted-foreground">{statusText}</p>
          <p className="text-xs text-vp-muted-foreground mt-1">正在火山引擎云端训练，请稍候...</p>
        </div>
      )}

      {/* 设计结果 */}
      {result && (
        <div className="animate-slideUp space-y-4">
          <div className="bg-vp-card/80 border border-violet-400/20 rounded-2xl p-6">
            <div className="flex items-start gap-5">
              <div className="shrink-0">
                {imageFile ? (
                  <img src={URL.createObjectURL(imageFile)} alt="" className="w-16 h-16 rounded-2xl object-cover ring-2 ring-violet-400/30" />
                ) : (
                  <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-400 to-indigo-600 flex items-center justify-center shadow-lg shadow-violet-500/30">
                    <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-xl font-bold text-vp-foreground">声音设计完成</h3>
                <p className="text-xs text-vp-muted-foreground mt-1">试听后可以为音色命名并保存</p>

                {/* 试听 */}
                {result.demoAudio && (
                  <div className="mt-4 flex items-center gap-3">
                    <div className="flex-1"><AudioPlayer audioUrl={result.demoAudio} /></div>
                    <a href={result.demoAudio} download target="_blank" className="shrink-0 flex items-center gap-1.5 px-3 py-2 text-xs bg-violet-400/10 text-violet-200 rounded-lg border border-violet-400/20 hover:bg-violet-400/20 transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                      下载
                    </a>
                  </div>
                )}

                {/* 命名 + 保存（保存前显示） */}
                {!voiceSaved && (
                  <div className="mt-4 flex items-center gap-3">
                    <input
                      type="text"
                      value={voiceName}
                      onChange={(e) => setVoiceName(e.target.value)}
                      placeholder="为音色命名..."
                      maxLength={30}
                      className="flex-1 rounded-xl border border-vp-border bg-vp-card/40 px-4 py-2.5 text-sm text-vp-foreground placeholder:text-vp-muted-foreground focus:border-violet-400/40 focus:outline-none"
                    />
                    <button
                      onClick={() => {
                        setVoiceSaved(true);
                        // 同步收藏到localStorage
                        try {
                          const favs = JSON.parse(localStorage.getItem('voice_favorites') || '[]');
                          if (!favs.includes(result.speakerId)) {
                            favs.push(result.speakerId);
                            localStorage.setItem('voice_favorites', JSON.stringify(favs));
                          }
                        } catch {}
                        // 如果有token则调API收藏
                        const token = localStorage.getItem('token');
                        if (token) {
                          fetch('/voice-platform/api/voices/favorites', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                            body: JSON.stringify({ speakerId: result.speakerId, name: voiceName.trim() }),
                          }).catch(() => {});
                        }
                      }}
                      disabled={!voiceName.trim()}
                      className="shrink-0 px-5 py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-bold hover:bg-emerald-400 disabled:opacity-30 transition-colors"
                    >
                      保存音色
                    </button>
                  </div>
                )}

                {/* 保存成功后的信息 */}
                {voiceSaved && (
                  <div className="mt-4 space-y-3">
                    <div className="flex items-center gap-2 text-xs text-emerald-300">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                      已保存「{voiceName}」到我的定制
                    </div>
                    <div className="flex items-center gap-2 bg-slate-950/40 rounded-lg px-3 py-2 border border-sky-300/8 text-xs">
                      <span className="text-vp-muted-foreground shrink-0">speakerId</span>
                      <code className="font-mono text-vp-primary flex-1 truncate">{result.speakerId}</code>
                      <button onClick={copySpeakerId} className="px-2 py-1 bg-violet-400/15 text-violet-200 rounded-md hover:bg-violet-400/25 transition-colors shrink-0 text-[11px]">
                        {copied ? '已复制' : '复制'}
                      </button>
                    </div>
                  </div>
                )}

                {/* 操作按钮组 */}
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <button
                    onClick={() => window.location.href = `/voice-platform/workspace?speaker=${encodeURIComponent(result.speakerId)}&preload=true`}
                    className="py-2.5 rounded-xl bg-gradient-to-r from-violet-500 to-indigo-600 text-white text-sm font-bold hover:from-violet-400 hover:to-indigo-500 transition-all shadow-lg shadow-indigo-500/20"
                  >
                    🚀 去工作台使用
                  </button>
                  <button
                    onClick={() => { setResult(null); setVoiceSaved(false); setVoiceName(''); setDesignDuration(null); }}
                    className="py-2.5 rounded-xl border border-vp-border text-vp-foreground text-sm font-semibold hover:border-sky-300/40 hover:text-vp-foreground transition-colors"
                  >
                    不满意，重新设计
                  </button>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-x-4 text-xs text-vp-muted-foreground">
                  {designDuration !== null && <div>耗时 {formatDuration(designDuration)}</div>}
                  {availableTimes !== null && <div>剩余 {availableTimes}次</div>}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== 弹窗：新增/编辑模板 ===== */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setModalOpen(false)} />
          <div className="relative bg-vp-card border border-vp-border rounded-2xl w-full max-w-md p-6 shadow-2xl shadow-black/50">
            <h3 className="text-lg font-bold text-vp-foreground mb-1">
              {editIndex !== null ? '编辑模板' : '保存自定义模板'}
            </h3>
            <p className="text-xs text-vp-muted-foreground mb-5">模板永久保存到本地，方便下次快速复用</p>

            <div className="space-y-4">
              <div>
                <label className="text-xs text-vp-muted-foreground mb-1.5 block">模板名称</label>
                <input
                  value={modalLabel}
                  onChange={(e) => setModalLabel(e.target.value)}
                  placeholder="如：霸道总裁、元气少女..."
                  maxLength={10}
                  autoFocus
                  className="w-full rounded-xl border border-vp-border bg-vp-card/60 px-4 py-3 text-sm text-vp-foreground placeholder:text-vp-muted-foreground focus:border-violet-400/40 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs text-vp-muted-foreground mb-1.5 block">模板描述</label>
                <textarea
                  value={modalPrompt}
                  onChange={(e) => setModalPrompt(e.target.value)}
                  placeholder="描述音色的性别、年龄、音色特征、语速、适用场景..."
                  rows={4}
                  maxLength={200}
                  className="w-full rounded-xl border border-vp-border bg-vp-card/60 px-4 py-3 text-sm text-vp-foreground placeholder:text-vp-muted-foreground focus:border-violet-400/40 focus:outline-none resize-none"
                />
              </div>
            </div>

            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setModalOpen(false)}
                className="flex-1 py-2.5 rounded-xl border border-slate-600/40 text-vp-muted-foreground text-sm font-semibold hover:text-slate-200 hover:border-slate-500 transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleModalSave}
                disabled={!modalLabel.trim() || !modalPrompt.trim()}
                className="flex-1 py-2.5 rounded-xl bg-violet-500 text-white text-sm font-semibold hover:bg-violet-400 disabled:opacity-30 transition-colors"
              >
                {editIndex !== null ? '保存修改' : '保存模板'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
