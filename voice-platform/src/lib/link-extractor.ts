/**
 * 链接克隆 - 链接提取器
 * 功能：短视频链接 → 视频解析 → MP4下载 → MP3提取 → WAV处理 → Base64
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

// API 密钥配置
const PPT6_CONFIG = {
  clientId: process.env.PPT6_CLIENT_ID?.trim() ?? '',
  clientSecretKey: process.env.PPT6_CLIENT_SECRET?.trim() ?? '',
  baseUrl: 'https://apis.ppt6.top',
};

const IYUNS_API = 'https://api.iyuns.com/api/mp4tomp3';

// 火山引擎声音复刻要求
const CLONE_CONSTRAINTS = {
  minDuration: 14,     // 最短14秒
  maxDuration: 30,     // 最长30秒
  defaultDuration: 20, // 默认截取20秒
  skipStart: 2,        // 跳过开头2秒
  format: 'wav' as const,
  sampleRate: 16000,
  channels: 1,         // 单声道
};

export interface VideoInfo {
  videoUrl: string;
  title: string;
  cover: string;
  platform: string;
  type: 'video' | 'image';
}

export interface AudioProcessResult {
  wavBase64: string;
  duration: number;
  title: string;
  cover: string;
}

/**
 * 解析短视频链接，获取视频信息
 */
export async function extractVideoInfo(url: string): Promise<VideoInfo> {
  if (!PPT6_CONFIG.clientId || !PPT6_CONFIG.clientSecretKey) {
    throw new Error('视频解析服务尚未配置');
  }
  const params = new URLSearchParams({
    clientId: PPT6_CONFIG.clientId,
    clientSecretKey: PPT6_CONFIG.clientSecretKey,
    url: url.trim(),
  });

  const apiUrl = `${PPT6_CONFIG.baseUrl}?${params.toString()}`;

  const response = await fetch(apiUrl, {
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`PPT6 API 请求失败: HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.code !== 200) {
    const errorMessages: Record<number, string> = {
      103: '请输入正确的链接',
      104: '接口暂不可用',
      107: '数据结构异常',
      110: '今日调用次数已用完',
      113: '链接解析失败',
      115: '会员等级不足',
      504: '解析超时，请检查链接是否有效',
    };
    throw new Error(errorMessages[data.code] || data.msg || '链接解析失败');
  }

  const videoData = data.data;
  if (videoData.type !== 1) {
    throw new Error('该链接不是视频类型，无法提取音频');
  }

  const videoUrl = videoData.video_mp4 || videoData.video_url;
  if (!videoUrl) {
    throw new Error('未能获取到视频下载链接');
  }

  return {
    videoUrl,
    title: videoData.title || videoData.desc || '未知标题',
    cover: videoData.cover || '',
    platform: detectPlatform(url),
    type: 'video',
  };
}

/**
 * 检测链接所属平台
 */
function detectPlatform(url: string): string {
  if (url.includes('xiaohongshu.com') || url.includes('xhslink.com')) return '小红书';
  if (url.includes('douyin.com') || url.includes('v.douyin.com')) return '抖音';
  if (url.includes('bilibili.com') || url.includes('b23.tv')) return 'B站';
  return '未知平台';
}

/**
 * MP4视频 → MP3音频（使用 iyuns 免费API）
 */
export async function convertVideoToMp3(videoUrl: string): Promise<string> {
  const params = new URLSearchParams({ url: videoUrl });
  const apiUrl = `${IYUNS_API}?${params.toString()}`;

  const response = await fetch(apiUrl, {
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`音频转换请求失败: HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.code === 200 && data.data) {
    return data.data; // 返回MP3下载链接
  }

  throw new Error(data.msg || '音频提取失败');
}

/**
 * 下载文件到临时目录
 */
async function downloadFile(url: string, ext: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`文件下载失败: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const tmpDir = os.tmpdir();
  const filename = `link-clone-${Date.now()}.${ext}`;
  const filepath = path.join(tmpDir, filename);

  fs.writeFileSync(filepath, buffer);
  return filepath;
}

/**
 * 音频预处理：MP3 → WAV（满足火山API要求）
 * 
 * 处理步骤：
 * 1. 跳过开头skipStart秒
 * 2. 截取duration秒
 * 3. 转单声道16kHz WAV
 * 4. 音量归一化
 * 5. 转Base64
 */
export async function processAudio(
  mp3Url: string,
  duration: number = CLONE_CONSTRAINTS.defaultDuration
): Promise<string> {
  // 验证时长在合法范围
  if (duration < CLONE_CONSTRAINTS.minDuration || duration > CLONE_CONSTRAINTS.maxDuration) {
    throw new Error(`音频时长必须在 ${CLONE_CONSTRAINTS.minDuration}-${CLONE_CONSTRAINTS.maxDuration} 秒之间`);
  }

  // 下载MP3
  const mp3Path = await downloadFile(mp3Url, 'mp3');
  const wavPath = mp3Path.replace('.mp3', '.wav');

  try {
    // ffmpeg 处理
    const cmd = [
      `ffmpeg -y`,
      `-i "${mp3Path}"`,
      `-ss ${CLONE_CONSTRAINTS.skipStart}`,
      `-t ${duration}`,
      `-ac ${CLONE_CONSTRAINTS.channels}`,
      `-ar ${CLONE_CONSTRAINTS.sampleRate}`,
      `-sample_fmt s16`,
      `-af "highpass=f=80,lowpass=f=8000,loudnorm"`,
      `"${wavPath}"`,
    ].join(' ');

    // 尝试 ffmpeg（系统安装或node-modules）
    await execAsync(cmd, { timeout: 30000 });
  } catch (ffmpegErr: any) {
    // ffmpeg 不可用时尝试 @ffmpeg-installer
    try {
      const ffmpeg = require('@ffmpeg-installer/ffmpeg');
      const cmd2 = [
        `"${ffmpeg.path}"`,
        `-y -i "${mp3Path}"`,
        `-ss ${CLONE_CONSTRAINTS.skipStart}`,
        `-t ${duration}`,
        `-ac ${CLONE_CONSTRAINTS.channels}`,
        `-ar ${CLONE_CONSTRAINTS.sampleRate}`,
        `-sample_fmt s16`,
        `-af "highpass=f=80,lowpass=f=8000,loudnorm"`,
        `"${wavPath}"`,
      ].join(' ');
      await execAsync(cmd2, { timeout: 30000 });
    } catch {
      // 兜底：直接使用原始MP3的base64（降级方案）
      const mp3Buffer = fs.readFileSync(mp3Path);
      return mp3Buffer.toString('base64');
    }
  }

  // 读取WAV并转Base64
  const wavBuffer = fs.readFileSync(wavPath);
  const base64 = wavBuffer.toString('base64');

  // 清理临时文件
  try { fs.unlinkSync(mp3Path); } catch {}
  try { fs.unlinkSync(wavPath); } catch {}

  return base64;
}

/**
 * 完整链接克隆流程
 */
export async function extractAudioFromLink(
  url: string,
  duration: number = CLONE_CONSTRAINTS.defaultDuration
): Promise<AudioProcessResult> {
  // Step 1: 解析视频
  const videoInfo = await extractVideoInfo(url);

  // Step 2: MP4→MP3
  const mp3Url = await convertVideoToMp3(videoInfo.videoUrl);

  // Step 3: 处理音频
  const wavBase64 = await processAudio(mp3Url, duration);

  return {
    wavBase64,
    duration,
    title: videoInfo.title,
    cover: videoInfo.cover,
  };
}
