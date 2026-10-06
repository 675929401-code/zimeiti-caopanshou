'use client';

import { Suspense } from 'react';

import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import Button from '@/components/ui/Button';
import Input from '@/components/ui/Input';
import Select from '@/components/ui/Select';
import StepIndicator from '@/components/StepIndicator';
import FileUpload from '@/components/FileUpload';
import AudioPlayer from '@/components/AudioPlayer';
import LinkCloneForm from '@/components/LinkCloneForm';

const STEPS = [
  { label: '上传音频', description: '上传参考音频' },
  { label: '配置参数', description: '设置复刻参数' },
  { label: '开始训练', description: '等待模型训练' },
  { label: '查看结果', description: '试听和使用' },
];

function ClonePageInner() {
  const searchParams = useSearchParams();
  const refAudioUrl = searchParams.get('refAudioUrl');
  const refAudioName = searchParams.get('refAudioName');

  const [activeTab, setActiveTab] = useState(0); // 0=上传音频, 1=链接克隆
  const [currentStep, setCurrentStep] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [audioBase64, setAudioBase64] = useState('');
  const [voiceName, setVoiceName] = useState('');
  const [language, setLanguage] = useState('0');
  const [enableDenoise, setEnableDenoise] = useState(true);
  const [demoText, setDemoText] = useState('');
  const [showAudioEnhance, setShowAudioEnhance] = useState(true); // 默认展开
  const [voiceMss, setVoiceMss] = useState(false);      // 音源分离
  const [voiceCropAsr, setVoiceCropAsr] = useState(true); // ASR精准截断
  const [voiceDenoiseModel, setVoiceDenoiseModel] = useState(''); // 人声美化模型
  const [training, setTraining] = useState(false);
  const [licenseKey, setLicenseKey] = useState('');    // 管理员分配的授权密钥
  const [licenseVerified, setLicenseVerified] = useState(false);
  const [licenseError, setLicenseError] = useState('');
  const [status, setStatus] = useState('');

  // 验证授权密钥
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
        // 如果有绑定的 speakerId，使用它
        if (d.data.speakerId) setSpeakerId(d.data.speakerId as string);
      } else {
        setLicenseError(d.message || '密钥无效');
      }
    } catch {
      setLicenseError('验证失败，请重试');
    }
  };
  const [speakerId, setSpeakerId] = useState('');
  const [demoAudio, setDemoAudio] = useState('');
  const [error, setError] = useState('');
  // 元数据
  const [trainingStartTime, setTrainingStartTime] = useState<number | null>(null);
  const [trainingDuration, setTrainingDuration] = useState<number | null>(null);
  const [availableTimes, setAvailableTimes] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  // 从音色模仿页跳转过来时，自动加载参考音频
  useEffect(() => {
    if (refAudioUrl && refAudioName) {
      setVoiceName(refAudioName);
      // 从 URL 加载音频转为 File
      fetch(refAudioUrl)
        .then(r => r.blob())
        .then(blob => {
          const f = new File([blob], refAudioName + '.mp3', { type: blob.type || 'audio/mpeg' });
          handleFileChange(f);
        })
        .catch(() => {});
    }
  }, [refAudioUrl, refAudioName]);

  const handleFileChange = async (f: File) => {
    setFile(f);
    setError('');
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setAudioBase64(result.split(',')[1] || '');
    };
    reader.readAsDataURL(f);
  };

  const handleNextStep = () => {
    if (currentStep === 0 && !file) { setError('请先上传音频文件'); return; }
    if (currentStep === 1) {
      if (!voiceName.trim()) { setError('请输入音色名称'); return; }
    }
    setError('');
    if (currentStep < 3) setCurrentStep(currentStep + 1);
  };

  const handleClone = async () => {
    if (!licenseVerified) { setError('请先验证授权密钥'); return; }
    setTraining(true);
    setError('');
    setStatus('提交训练请求...');
    setTrainingStartTime(Date.now());
    setTrainingDuration(null);

    try {
      const speakerIdGen = `S_${Date.now()}`;
      const res = await fetch('/voice-platform/api/voice/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          speakerId: speakerIdGen,
          audioBase64,
          audioFormat: file?.name?.split('.').pop() || 'wav',
          language: parseInt(language),
          text: demoText || undefined,
          enableAudioDenoise: enableDenoise,
          voiceCloneEnableMss: voiceMss || undefined,
          enableCropByAsr: voiceCropAsr || undefined,
          voiceCloneDenoiseModelId: voiceDenoiseModel || undefined,
          demoText: demoText || undefined,
          name: voiceName || undefined,
        }),
      });
      const data = await res.json();

      if (data.success) {
        setSpeakerId(data.data.speakerId);
        // 消耗一次训练次数
        if (licenseKey && licenseVerified) {
          fetch('/voice-platform/api/license/consume', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ licenseKey }),
          }).then(r => r.json()).then((res) => {
            if (res.success) {
              setStatus('训练中...（剩余 ' + res.data.remaining + ' 次训练次数）');
            }
          }).catch(() => {});
        } else {
          setStatus('训练中...');
        }
        // Poll for status
        pollStatus(data.data.speakerId);
      } else {
        setError(data.message || '复刻失败');
        setTraining(false);
        setCurrentStep(1);
      }
    } catch {
      setError('网络错误，请重试');
      setTraining(false);
    }
  };

  const pollStatus = async (sid: string) => {
    // 5分钟超时：100 次 × 3 秒 = 300 秒（火山声音复刻训练通常 1-3 分钟）
    const maxAttempts = 100;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch(`/voice-platform/api/voice/status?speakerId=${sid}`);
        const data = await res.json();
        if (data.success) {
          const s = data.data.status;
          if (s === 2 || s === 4) {
            setStatus('训练成功！');
            setDemoAudio(data.data.speakerStatus?.[0]?.demoAudio || '');
            setTraining(false);
            setCurrentStep(3);
            if (trainingStartTime) {
              setTrainingDuration(Math.round((Date.now() - trainingStartTime) / 1000));
            }
            // 自动收藏新克隆音色
            autoFavorite(sid);
            return;
          } else if (s === 3) {
            setStatus('训练失败');
            setError('声音复刻训练失败，请检查音频质量后重试');
            setTraining(false);
            return;
          } else {
            const elapsedSec = (i + 1) * 3;
            setStatus(`训练中... 已用时 ${Math.floor(elapsedSec / 60)}分${elapsedSec % 60}秒（最长5分钟）`);
          }
        }
      } catch {
        // continue polling
      }
    }
    setError('训练超时（5分钟），请稍后在"我的音色"中查看结果，或联系管理员');
    setTraining(false);
  };

  // 自动收藏新创建的克隆音色
  const autoFavorite = async (sid: string) => {
    try {
      const token = localStorage.getItem('token');
      if (!token) return;
      // 先获取 voiceId
      const vRes = await fetch(`/voice-platform/api/voices?type=cloned&mine=true&limit=10`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const vData = await vRes.json();
      const voice = vData.data?.voices?.find((v: any) => v.speakerId === sid);
      if (voice) {
        await fetch(`/voice-platform/api/voices/${voice.id}/favorite`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {
      // 静默
    }
  };

  // 复制 speakerId
  const copySpeakerId = async () => {
    try {
      await navigator.clipboard.writeText(speakerId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  // 下载 demo 音频
  const downloadDemo = () => {
    if (demoAudio) {
      const a = document.createElement('a');
      a.href = demoAudio;
      a.download = `${voiceName || speakerId}_demo.mp3`;
      a.target = '_blank';
      a.click();
    }
  };

  // 跳转到工作台并预选音色
  const useInWorkspace = () => {
    window.location.href = `/voice-platform/workspace?speaker=${encodeURIComponent(speakerId)}&preload=true`;
  };

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m}分${s}秒` : `${s}秒`;
  };

  const resetForm = () => {
    setFile(null);
    setAudioBase64('');
    setDemoText('');
    // 保留 speakerId: 重新训练同一个音槽（消耗次数，不增加槽位）
    // 保留 voiceName/language/enableDenoise: 方便快速重新训练
    setDemoAudio('');
    setStatus('');
    setError('');
    setCurrentStep(0);
  };

  // ====== 链接克隆模式 ======
  if (activeTab === 1) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold text-vp-foreground mb-6">声音复刻</h1>
        <div className="flex gap-2 mb-6 p-1 rounded-2xl glass-card w-fit">
          {['上传音频', '链接克隆'].map((label, i) => (
            <button key={label} onClick={() => setActiveTab(i)} className={`px-4 py-2 text-sm rounded-xl transition-all ${activeTab === i ? 'bg-slate-100 text-slate-900' : 'text-vp-muted-foreground hover:text-vp-foreground'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-6">
          <LinkCloneForm />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-bold text-vp-foreground mb-6">声音复刻</h1>

      {/* Tab 切换 */}
      <div className="flex gap-2 mb-6 p-1 rounded-2xl glass-card w-fit">
        {['上传音频', '链接克隆'].map((label, i) => (
          <button key={label} onClick={() => setActiveTab(i)} className={`px-4 py-2 text-sm rounded-xl transition-all ${activeTab === i ? 'bg-slate-100 text-slate-900' : 'text-vp-muted-foreground hover:text-vp-foreground'}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-6 mb-6">
        <StepIndicator steps={STEPS} currentStep={currentStep} />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700 mb-6">{error}</div>
      )}

      <div className="bg-vp-card/80 rounded-2xl border border-vp-border p-6">
        {/* Step 0: Upload */}
        {currentStep === 0 && (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-vp-foreground">步骤 1: 上传参考音频</h3>
            <p className="text-sm text-vp-muted-foreground">上传一段清晰的单人音频作为复刻参考，建议时长10-30秒</p>
            
            {/* 快捷入口：从音色模仿已保存列表选择 */}
            <div className="p-4 rounded-xl bg-sky-400/5 border border-sky-400/10">
              <p className="text-xs text-vp-primary/70 mb-2">💡 已有提取好的音频？可直接从音色模仿页选择后跳转过来，无需重新上传。</p>
              <a
                href="/imitate"
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-sky-400/10 text-vp-primary text-xs hover:bg-sky-400/20 transition-colors"
              >
                前往音色模仿 → 选择音频 → 训练专属音色
              </a>
            </div>

            <FileUpload
              accept="audio/*"
              maxSize={10 * 1024 * 1024}
              onChange={handleFileChange}
            />
            <div className="flex justify-end">
              <Button onClick={handleNextStep} disabled={!file}>下一步</Button>
            </div>
          </div>
        )}

        {/* 授权密钥 */}
        {!licenseVerified ? (
          <div className="mt-6 p-4 rounded-xl bg-amber-400/5 border border-amber-400/15">
              <p className="text-sm text-amber-200 mb-3">🔑 输入授权密钥</p>
              <p className="text-xs text-vp-muted-foreground mb-3">
                声音复刻消耗音色槽位（138元/个，15次训练）。<br/>
                请联系管理员获取授权密钥。
              </p>
              <div className="flex gap-2 max-w-md">
                <input
                  type="text"
                  value={licenseKey}
                  onChange={(e) => setLicenseKey(e.target.value)}
                  placeholder="输入密钥，如 ZY-XXXX-XXXX"
                  className="flex-1 rounded-xl border border-amber-400/30 bg-vp-background/60 px-3 py-2 text-sm text-slate-200 placeholder:text-vp-muted-foreground"
                />
                <button onClick={verifyLicense} className="px-4 py-2 rounded-xl bg-amber-500/20 text-amber-200 border border-amber-400/30 text-sm hover:bg-amber-500/30 transition-colors">
                  验证
                </button>
              </div>
              {licenseError && <p className="text-xs text-red-400 mt-2">{licenseError}</p>}
            </div>
          ) : (
            <div className="mt-6 p-3 rounded-xl bg-emerald-400/5 border border-emerald-400/15 text-center">
              <p className="text-xs text-emerald-400">✅ 密钥已验证</p>
            </div>
          )
        }

        {/* Step 1: Config */}
        {currentStep === 1 && (
          <div className="space-y-4">
            <h3 className="text-lg font-semibold text-vp-foreground">步骤 2: 配置参数</h3>
            <Input
              label="音色名称"
              placeholder="为你的复刻音色起个名字"
              value={voiceName}
              onChange={(e) => setVoiceName(e.target.value)}
            />
            <Select
              label="语种"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              options={[
                { value: '0', label: '中文' },
                { value: '1', label: '英文' },
                { value: '2', label: '日语' },
                { value: '8', label: '韩语' },
              ]}
            />
            <div className="space-y-4 p-5 rounded-2xl bg-vp-background/40 border border-vp-border">
              <h4 className="text-sm font-semibold text-amber-300 flex items-center gap-2">
                <span>🎛</span> 音频增强设置
                <span className="text-[10px] text-vp-muted-foreground font-normal">以下设置直接影响复刻质量</span>
              </h4>

              {/* 降噪 */}
              <div className="flex items-center gap-3">
                <input type="checkbox" id="denoise" checked={enableDenoise} onChange={(e) => setEnableDenoise(e.target.checked)} className="w-4 h-4 rounded border-vp-border text-sky-400" />
                <div>
                  <label htmlFor="denoise" className="text-sm text-slate-200">降噪处理</label>
                  <p className="text-[11px] text-vp-muted-foreground">去除音频背景噪声，噪声大时建议开启</p>
                </div>
              </div>

              {/* 音源分离 */}
              <div className="flex items-center gap-3">
                <input type="checkbox" id="mss" checked={voiceMss} onChange={(e) => setVoiceMss(e.target.checked)} className="w-4 h-4 rounded border-vp-border text-emerald-400" />
                <div>
                  <label htmlFor="mss" className="text-sm text-slate-200">音源分离</label>
                  <p className="text-[11px] text-vp-muted-foreground">提取纯净人声，去除背景音乐——从抖音提取的音频建议开启</p>
                </div>
              </div>

              {/* ASR截断 */}
              <div className="flex items-center gap-3">
                <input type="checkbox" id="cropAsr" checked={voiceCropAsr} onChange={(e) => setVoiceCropAsr(e.target.checked)} className="w-4 h-4 rounded border-vp-border text-emerald-400" />
                <div>
                  <label htmlFor="cropAsr" className="text-sm text-slate-200">ASR 精准截断</label>
                  <p className="text-[11px] text-vp-muted-foreground">智能定位每个字的发音边界，避免发音被切断</p>
                </div>
              </div>

              {/* 人声美化模型 */}
              <div>
                <label className="text-sm text-slate-200 block mb-1">人声美化模型</label>
                <p className="text-[11px] text-vp-muted-foreground mb-2">三个模型各有侧重，还原度最高的选默认</p>
                <select
                  value={voiceDenoiseModel}
                  onChange={(e) => setVoiceDenoiseModel(e.target.value)}
                  className="w-full rounded-xl bg-vp-card/60 border border-vp-border px-3 py-2.5 text-sm text-slate-200"
                >
                  <option value="">SpeechInpaintingV2 — 默认，平衡音质与还原度</option>
                  <option value="VocalDiffusionV2">VocalDiffusion V2 — 更自然的人声质感</option>
                  <option value="VocalDiffusionV2_44k">VocalDiffusion V2 44kHz — 高保真，适合音乐/播客</option>
                </select>
              </div>

              {/* 试听文本 */}
              <div>
                <label className="text-sm text-slate-200 block mb-1">试听文本（可选，4-80字）</label>
                <p className="text-[11px] text-vp-muted-foreground mb-2">训练完成后系统会用这段文字生成 demo 让你试听效果</p>
                <Input
                  placeholder="输入试听文本，4-80字"
                  value={demoText}
                  onChange={(e) => setDemoText(e.target.value)}
                />
              </div>
            </div>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setCurrentStep(0)}>上一步</Button>
              <Button onClick={handleNextStep}>下一步</Button>
            </div>
          </div>
        )}

        {/* Step 2: Training */}
        {currentStep === 2 && (
          <div className="space-y-4 text-center py-8">
            {!training ? (
              <>
                <h3 className="text-lg font-semibold text-vp-foreground">步骤 3: 开始训练</h3>
                <p className="text-sm text-vp-muted-foreground">确认参数无误后，点击按钮开始声音复刻训练</p>

                <div className="space-y-3">
                  <Button variant="primary" size="lg" onClick={handleClone}>
                      开始复刻训练
                    </Button>
                  </div>
              </>
            ) : (
              <>
                <div className="w-16 h-16 mx-auto rounded-full bg-indigo-100 flex items-center justify-center">
                  <svg className="w-8 h-8 text-vp-primary animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
                <p className="text-sm text-vp-muted-foreground mt-3">{status}</p>
              </>
            )}
            <div className="flex justify-start">
              <Button variant="ghost" onClick={() => setCurrentStep(1)} disabled={training}>上一步</Button>
            </div>
          </div>
        )}

        {/* Step 3: Result */}
        {currentStep === 3 && (
          <div className="space-y-4">
            <div className="text-center py-4">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600 mb-3 shadow-lg shadow-emerald-200">
                <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h3 className="text-2xl font-bold text-vp-foreground">声音复刻成功！</h3>
              <p className="text-sm text-vp-muted-foreground mt-1">音色已自动保存到「我的克隆」和「我的收藏」</p>
            </div>

            {/* 完整音色卡 */}
            <div className="bg-gradient-to-br from-[#050B18] to-[#03101F] border border-indigo-100 rounded-2xl p-5">
              <div className="flex items-start gap-4">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white text-lg font-bold shrink-0 shadow-md">
                  {(voiceName || '克隆').slice(0, 2)}
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="text-lg font-bold text-vp-foreground truncate">{voiceName || '未命名克隆音色'}</h4>
                  <div className="flex flex-wrap gap-2 mt-2">
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded-full">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                      克隆音色
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 bg-blue-50 text-blue-700 rounded-full">
                      🎯 已收藏
                    </span>
                  </div>

                  {/* 元数据网格 */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-3 text-xs">
                    {trainingDuration !== null && (
                      <div>
                        <span className="text-vp-muted-foreground">训练耗时：</span>
                        <span className="text-vp-foreground font-medium">{formatDuration(trainingDuration)}</span>
                      </div>
                    )}
                    {availableTimes !== null && (
                      <div>
                        <span className="text-vp-muted-foreground">剩余复刻：</span>
                        <span className="text-vp-foreground font-medium">{availableTimes}/15 次</span>
                      </div>
                    )}
                    <div>
                      <span className="text-vp-muted-foreground">复刻源：</span>
                      <span className="text-vp-foreground font-medium truncate">{file?.name || '未知'}</span>
                    </div>
                    <div>
                      <span className="text-vp-muted-foreground">采样率：</span>
                      <span className="text-vp-foreground font-medium">16kHz</span>
                    </div>
                    <div>
                      <span className="text-vp-muted-foreground">降噪处理：</span>
                      <span className="text-vp-foreground font-medium">{enableDenoise ? '是' : '否'}</span>
                    </div>
                    <div>
                      <span className="text-vp-muted-foreground">语种：</span>
                      <span className="text-vp-foreground font-medium">{language === '0' ? '中文' : language === '1' ? '英文' : language === '2' ? '日语' : language === '8' ? '韩语' : '中文'}</span>
                    </div>
                  </div>

                  <div className="mt-3 flex items-center gap-2 bg-vp-card/80/70 rounded-lg px-3 py-2">
                    <span className="text-xs text-vp-muted-foreground">speakerId:</span>
                    <code className="text-xs font-mono text-vp-foreground flex-1 truncate">{speakerId}</code>
                    <button
                      onClick={copySpeakerId}
                      className="text-xs px-2 py-1 bg-indigo-100 text-vp-primary rounded hover:bg-indigo-200 transition-colors shrink-0"
                    >
                      {copied ? '✓已复制' : '复制'}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* 试听 */}
            {demoAudio && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold text-vp-foreground">🎧 试听效果</p>
                  <button
                    onClick={downloadDemo}
                    className="text-xs text-vp-primary hover:underline"
                  >
                    下载 demo
                  </button>
                </div>
                <AudioPlayer audioUrl={demoAudio} />
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-2 mt-2 text-xs text-amber-700">
                  ⚠️ demo 音频链接仅 <strong>1小时有效</strong>，如需保留请立即下载
                </div>
              </div>
            )}

            {/* 操作按钮 */}
            <div className="grid grid-cols-2 gap-3 pt-2">
              <Button variant="primary" size="lg" onClick={useInWorkspace}>
                🎤 立即合成
              </Button>
              <Button variant="outline" onClick={resetForm}>
                🔄 重新复刻
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Button variant="ghost" onClick={() => window.open('/voices?type=cloned&mine=true', '_self')}>
                📂 我的克隆
              </Button>
              <Button variant="ghost" onClick={() => window.open('/voices?type=favorites', '_self')}>
                ⭐ 我的收藏
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ClonePage() {
  return <Suspense fallback={<div className="p-8 text-center text-white/60">加载中...</div>}><ClonePageInner /></Suspense>;
}
