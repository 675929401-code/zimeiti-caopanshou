# 仓库引导协议（AI 快速识别指南）

> **本文件供 AI 编程助手（扣子 / Cursor / Claude Code 等）快速理解项目。**
> 读取本文件后即可掌握项目全貌，无需逐个翻阅代码。

---

## 项目名称

**Agent Hub — 智能体平台 + AI 语音克隆工坊**

## 一句话描述

基于 Coze 构建的主站（智能体工作台）+ 独立部署的 AI 语音克隆工坊，部署在腾讯云服务器上。

## 目录结构

```
/workspace/                          # 项目根目录（主站）
├── AGENTS.md                        # ← 主站项目说明（Coze 格式）
├── src/                             # 主站源码
│   ├── app/                         # Next.js App Router 页面
│   │   ├── api/                     # API 路由
│   │   ├── admin/                   # 后台管理页
│   │   └── page.tsx                 # 首页
│   ├── lib/                         # 工具库
│   │   ├── billing.ts              # 扣费逻辑
│   │   ├── auth.ts                  # 认证
│   │   └── ...
│   └── components/                  # React 组件
├── scripts/                         # 部署/备份脚本
│   ├── git-backup.sh               # Git 备份脚本
│   └── sync-deploy.sh              # 部署脚本
├── docs/                            # 文档
│   ├── API_PROTOCOL.md             # ← 主站↔语音工坊 接口协议
│   ├── COZE_REPOSITORY_GUIDE.md    # ← 本文件
│   └── 项目启动文档.md
├── voice-studio/                    # ← 语音克隆工坊（独立 Next.js 项目）
│   ├── src/
│   │   ├── app/
│   │   │   ├── voice-studio/page.tsx   # 语音工坊前端页面
│   │   │   ├── admin/page.tsx          # 语音后台管理
│   │   │   └── api/
│   │   │       ├── voice/list/route.ts     # 声音列表 API（71个声音）
│   │   │       ├── voice/tts/route.ts      # 语音合成 API（含扣费+标记翻译）
│   │   │       ├── voice/clone/route.ts   # 声音克隆 API
│   │   │       ├── voice/services/route.ts # 服务卡片列表 API
│   │   │       └── admin/services/route.ts # 服务卡片管理 API
│   │   └── lib/
│   │       ├── types/index.ts          # 类型定义
│   │       ├── service-store.ts         # 服务卡片存储
│   │       ├── voice-store.ts           # 声音/引擎配置存储
│   │       └── tts/
│   │           ├── engines.ts          # 引擎元信息（6个引擎）
│   │           ├── router.ts            # TTS 路由器
│   │           ├── markers.ts          # 语音标记翻译器
│   │           └── adapters/            # 各引擎适配器
│   │               ├── volcano.ts
│   │               ├── cosyvoice.ts
│   │               ├── fish_audio.ts
│   │               ├── elevenlabs.ts
│   │               ├── gpt_sovits.ts
│   │               └── openai_tts.ts
│   └── data/                           # JSON 数据存储
│       ├── service-cards.json          # 服务卡片配置
│       ├── engine-configs.json         # 引擎配置（旧版）
│       ├── voices.json                 # 声音库
│       └── generations.json            # 生成记录
└── main-site/                         # 主站代码备份副本
```

## 技术栈

| 组件 | 技术 |
|------|------|
| 主站 | Coze 平台构建 + Next.js 16 |
| 语音工坊 | Next.js 15.5.20 + React 19 + TypeScript |
| 数据库 | Supabase（PostgreSQL，腾讯云北京） |
| 样式 | Tailwind CSS 4 |
| 部署 | 腾讯云 134.175.87.247 + PM2 + supervisord |
| Git 备份 | Gitee（zhujunguo/wangzhanbeifen） |

## 两个系统如何通信

详见 **`docs/API_PROTOCOL.md`**

简要：
- 主站端口 5000，语音工坊端口 8000
- 主站通过 iframe 或跳转嵌入语音工坊
- 通过 URL 参数传递用户 token
- API 通过 HTTP Header 传递认证

## 关键配置

| 项 | 值 |
|----|-----|
| 主站端口 | 5000 |
| 语音工坊端口 | 8000 |
| 数据库 | Supabase（硬编码在 supabase-client.ts） |
| Git 仓库 | https://gitee.com/zhujunguo/wangzhanbeifen.git |
| 备份目录 | 项目备份/2025-07-06-v2-最新完整备份/ |

## 扣子编程快速对接

### 1. 调用语音合成

```javascript
// 在扣子代码块中
const res = await fetch('http://localhost:8000/api/voice/tts', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + userToken,
    'X-User-Id': userId,
  },
  body: JSON.stringify({
    text: '大家好[pause:500ms]今天聊[emphasis:strong]重要话题[/emphasis]',
    voiceId: 'vol-cancan',        // 声音ID
    serviceId: 'default-volcano', // 服务卡片ID
    outputFormat: 'mp3',
  }),
});
const result = await res.json();
// result.data.audioData = base64 音频
```

### 2. 获取声音列表

```javascript
const res = await fetch('http://localhost:8000/api/voice/list');
const { data: voices } = await res.json();
// voices = [{id, name, engine, ...}, ...]
```

### 3. 获取服务卡片

```javascript
const res = await fetch('http://localhost:8000/api/voice/services');
const { data: services } = await res.json();
// services = [{id, name, engineType, retailPrice, isDefault}, ...]
```

## 启动命令

```bash
# 主站
cd /workspace && pnpm run dev    # 开发模式
cd /workspace && pnpm run start  # 生产模式（端口 5000）

# 语音工坊
cd /workspace/voice-studio && node node_modules/.bin/next start -p 8000 -H 0.0.0.0

# Git 备份
bash scripts/git-backup.sh "备份说明"
```

## 语音标记语法速查

| 标记 | 含义 | 示例 |
|------|------|------|
| `[pause:500ms]` | 停顿 0.5 秒 | `你好[pause:500ms]世界` |
| `[pause:1000ms]` | 停顿 1 秒 | `第一段[pause:1000ms]第二段` |
| `[emphasis:strong]文字[/emphasis]` | 加重语气 | `[emphasis:strong]重点[/emphasis]` |
| `[slow]文字[/slow]` | 局部放慢 | `[slow]慢慢说[/slow]` |
| `[fast]文字[/fast]` | 局部加快 | `[fast]快速说[/fast]` |

标记会自动翻译为各引擎支持的格式（SSML/标点/参数）。

## 服务卡片管理

后台地址：`http://localhost:8000/admin`

- 可自由添加多张服务卡片（如"火山-TTS"和"火山-克隆"分开配）
- 每张卡片独立配置 API Key、价格、启用状态
- 可设默认卡片
- 用户在前端下拉切换
