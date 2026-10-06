# zyuani8 项目仓库

> AI智能体工作台 — 主站 + 语音克隆工坊

## 📁 目录结构

```
wangzhanbeifen/
├── main-site/          # 扣子主站（zyuani8.com）
│   ├── src/            # 主站源码（Next.js）
│   ├── public/         # 静态资源
│   ├── Dockerfile      # Docker部署文件
│   └── ...
├── voice-studio/       # 🎙️ AI语音克隆工坊（二级页面）
│   ├── src/
│   │   ├── app/voice-studio/   # 语音生成页面
│   │   ├── app/admin/          # 后台管理页面
│   │   ├── app/api/            # 后端API
│   │   └── lib/tts/            # 6个TTS引擎适配器
│   └── ...
├── docs/               # 📚 项目文档
├── scripts/            # 🔧 部署与同步脚本
└── tests/              # 🧪 测试文件
```

## 🎙️ 语音克隆工坊 (voice-studio)

### 功能
- 文案输入 → 口播优化 → 声音选择 → 语音生成 → 试听下载
- 支持6个TTS引擎：火山引擎、CosyVoice、Fish Audio、ElevenLabs、GPT-SoVITS、OpenAI TTS
- 声音克隆：上传10秒音频克隆授权声音
- 口播优化：4级优化（不优化/轻度/中度/深度）+ 5种风格

### 启动方式
```bash
cd voice-studio
npm install
npm run dev    # 开发模式
npm run build  # 构建生产版本
npm run start  # 启动生产服务器
```

### 访问地址
- 语音生成页面：http://localhost:3000/voice-studio
- 后台管理页面：http://localhost:3000/admin

## 🌐 主站 (main-site)

扣子平台搭建的AI智能体工作台，部署在腾讯云。

### 启动方式
```bash
cd main-site
npm install
npm run dev
```

## 📌 使用说明

1. **语音克隆功能使用前**，需先进入后台管理页面配置至少一个TTS引擎的API Key
2. **后台地址**：/admin → 引擎配置 → 填入API Key → 保存 → 测试连接
3. **口播优化功能**需配置大模型API（豆包/通义千问/GPT）
4. **详细配置说明**见 `docs/` 目录

## 🔒 安全提醒

- API Key存储在服务端，前端不直接接触
- 声音克隆仅支持已授权的声音
- 生成音频标注AI合成标识
