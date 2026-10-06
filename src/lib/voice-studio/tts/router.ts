// TTS 引擎路由器
// 根据引擎类型路由到对应适配器
import type {
  TTSEngine,
  CloneRequest,
  CloneResponse,
  TTSRequest,
  TTSResponse,
  StoredEngineConfig,
  EngineTestResult,
} from '../types';
import { ENGINE_CONFIGS } from '../engines';
import * as volcano from './adapters/volcano';
import * as cosyvoice from './adapters/cosyvoice';
import * as fishAudio from './adapters/fish_audio';
import * as elevenlabs from './adapters/elevenlabs';
import * as gptSovits from './adapters/gpt_sovits';
import * as openaiTts from './adapters/openai_tts';

// ─── TTS 适配器接口 ───
export interface TTSAdapter {
  clone?(req: CloneRequest, config: any): Promise<CloneResponse>;
  cloneStatus?(speakerId: string, config: any): Promise<any>;
  tts(req: TTSRequest, config: any): Promise<TTSResponse>;
  testConnection?(config: any): Promise<EngineTestResult>;
}

interface ResolvedConfig {
  apiKey: string;
  extraConfig: Record<string, string>;
}

/**
 * 路由声音克隆
 */
export async function routeClone(
  req: CloneRequest,
  stored: StoredEngineConfig,
): Promise<CloneResponse> {
  const cfg: ResolvedConfig = { apiKey: stored.apiKey, extraConfig: stored.extraConfig || {} };
  switch (req.engine) {
    case 'volcano':
      return volcano.clone(req, cfg);
    case 'cosyvoice':
      return cosyvoice.clone(req, cfg);
    case 'fish_audio':
      return fishAudio.clone(req, cfg);
    case 'elevenlabs':
      return elevenlabs.clone(req, cfg);
    case 'gpt_sovits':
      return gptSovits.clone(req, cfg);
    case 'openai_tts':
      return { success: false, message: 'OpenAI TTS 不支持声音克隆', code: 'CLONE_NOT_SUPPORTED' };
    default:
      return { success: false, message: `未知引擎: ${req.engine}`, code: 'UNKNOWN_ENGINE' };
  }
}

/**
 * 路由克隆状态查询
 */
export async function routeCloneStatus(
  engine: TTSEngine,
  speakerId: string,
  stored: StoredEngineConfig,
): Promise<CloneResponse> {
  const cfg: ResolvedConfig = { apiKey: stored.apiKey, extraConfig: stored.extraConfig || {} };
  switch (engine) {
    case 'volcano':
      return volcano.cloneStatus(speakerId, cfg);
    case 'cosyvoice':
    case 'fish_audio':
    case 'elevenlabs':
    case 'gpt_sovits':
      return {
        success: true,
        message: '该引擎支持即时克隆',
        data: { cloneId: speakerId, speakerId, status: 'ready', estimatedTime: 0 },
      };
    case 'openai_tts':
      return { success: false, message: 'OpenAI TTS 不支持克隆' };
    default:
      return { success: false, message: `未知引擎: ${engine}` };
  }
}

/**
 * 路由 TTS 合成
 */
export async function routeTTS(
  req: TTSRequest,
  engine: TTSEngine,
  speakerId: string,
  stored: StoredEngineConfig,
): Promise<TTSResponse> {
  const cfg: ResolvedConfig = { apiKey: stored.apiKey, extraConfig: stored.extraConfig || {} };
  switch (engine) {
    case 'volcano':
      return volcano.tts(req, speakerId, cfg);
    case 'cosyvoice':
      return cosyvoice.tts(req, speakerId, cfg);
    case 'fish_audio':
      return fishAudio.tts(req, speakerId, cfg);
    case 'elevenlabs':
      return elevenlabs.tts(req, speakerId, cfg);
    case 'gpt_sovits':
      return gptSovits.tts(req, speakerId, cfg);
    case 'openai_tts':
      return openaiTts.tts(req, speakerId, cfg);
    default:
      return { success: false, message: `未知引擎: ${engine}`, code: 'UNKNOWN_ENGINE' };
  }
}

/**
 * 测试引擎连接
 */
export async function testEngineConnection(
  engine: TTSEngine,
  stored: StoredEngineConfig,
): Promise<EngineTestResult> {
  const meta = ENGINE_CONFIGS[engine];
  if (!meta) {
    return { success: false, message: `未知引擎: ${engine}` };
  }
  if (!stored.apiKey && engine !== 'gpt_sovits') {
    return { success: false, message: `${meta.name} 未配置 API Key` };
  }
  // 基础校验：模拟一次最小请求（这里简化为只校验配置完整性）
  const requiredKeys = meta.extraConfigKeys.filter((k) => k.required);
  for (const k of requiredKeys) {
    if (!stored.extraConfig?.[k.key]) {
      return { success: false, message: `${meta.name} 缺少必填配置: ${k.label}` };
    }
  }
  // 对 OpenAI 做一次轻量校验请求
  const start = Date.now();
  try {
    if (engine === 'openai_tts') {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${stored.apiKey}` },
      });
      if (!res.ok) {
        return { success: false, message: `OpenAI 连接失败: HTTP ${res.status}`, latency: Date.now() - start };
      }
    }
    return { success: true, message: `${meta.name} 配置校验通过`, latency: Date.now() - start };
  } catch (err) {
    return { success: false, message: `${meta.name} 连接异常: ${(err as Error).message}`, latency: Date.now() - start };
  }
}

export default { routeClone, routeCloneStatus, routeTTS, testEngineConnection };

// ─── 向后兼容别名 ───
export const routeSynthesize = routeTTS;
export const routeTestConnection = testEngineConnection;

import { getAllEngineConfigs } from '@/lib/voice-studio/store';

/**
 * 构建引擎运行时配置（合并存储的配置与默认配置）
 */
export function buildEngineRuntimeConfig(engineType: TTSEngine) {
  const configs = getAllEngineConfigs();
  const engineConfig = configs.find(c => c.engine === engineType);
  const defaultConfig = ENGINE_CONFIGS[engineType];

  if (!defaultConfig) return null;

  return {
    apiKey: engineConfig?.apiKey || '',
    extraConfig: engineConfig?.extraConfig || {},
    defaultConfig,
    isConfigured: !!(engineConfig?.apiKey),
  };
}

/**
 * 检查引擎是否已配置
 */
export function isEngineConfigured(engineType: TTSEngine): boolean {
  const config = buildEngineRuntimeConfig(engineType);
  return config?.isConfigured || false;
}
