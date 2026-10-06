# 主站 ↔ 语音工坊 接口协议

> 本文档定义主站（Coze 构建，端口 5000）与语音工坊（Next.js，端口 8000）之间的通信协议。
> 扣子 AI 读取本文档后即可理解两系统如何握手，无需重新阅读代码。

---

## 1. 架构概览

```
用户浏览器
    │
    ├── 主站（Coze 构建）
    │   ├── 前端：扣子页面编辑器渲染
    │   ├── 后端：Supabase 数据库
    │   ├── 端口：5000（PM2 管理）
    │   └── 域名：zyuani8.com
    │
    └── 语音工坊（Next.js 独立项目）
        ├── 前端：/voice-studio
        ├── 后端：Next.js API Routes
        ├── 端口：8000（supervisord 管理）
        └── 部署：同一台腾讯云服务器 134.175.87.247
```

---

## 2. 握手方式

### 2.1 嵌入方式

主站通过 **iframe** 或 **导航跳转** 嵌入语音工坊：

```
# iframe 方式
<iframe src="http://zyuani8.com:8000/voice-studio?token={USER_TOKEN}" />

# 导航跳转方式（推荐）
window.location.href = 'http://zyuani8.com:8000/voice-studio?token={USER_TOKEN}'
```

### 2.2 认证握手

用户从主站跳转到语音工坊时，通过 URL 参数传递认证信息：

| 参数 | 说明 | 示例 |
|------|------|------|
| `token` | 用户登录令牌（主站生成） | `eyJhbGciOi...` |
| `uid` | 用户 ID | `user_abc123` |
| `role` | 用户角色 | `admin` / `user` |

语音工坊前端接收后存入 localStorage，后续 API 请求通过 Header 传递：

```
Authorization: Bearer {token}
X-User-Id: {uid}
X-User-Role: {role}
```

### 2.3 沙箱模式

当无 token 时，自动进入沙箱管理员模式（无需登录）：

- `token` 为空 → `Authorization: Bearer sandbox-admin-token`
- 所有扣费逻辑跳过
- 适用于预览和测试

---

## 3. API 接口清单

### 3.1 声音列表

```
GET /api/voice/list?keyword={关键词}&engine={引擎}&gender={性别}
```

**响应**：
```json
{
  "success": true,
  "data": [
    {
      "id": "vol-cancan",
      "name": "灿灿",
      "engine": "volcano",
      "speakerId": "BV700_streaming",
      "styleTags": ["通用","女声","清晰"],
      "gender": "female",
      "language": "zh",
      "description": "通用女声，清晰自然"
    }
  ],
  "message": "共 71 个声音"
}
```

### 3.2 服务卡片列表

```
GET /api/voice/services
```

**响应**：
```json
{
  "success": true,
  "data": [
    {
      "id": "default-volcano",
      "name": "火山引擎语音",
      "engineType": "volcano",
      "serviceType": "both",
      "retailPrice": 0,
      "isDefault": true
    }
  ]
}
```

### 3.3 语音合成（TTS）

```
POST /api/voice/tts
Content-Type: application/json
Authorization: Bearer {token}
X-User-Id: {uid}

{
  "text": "大家好，欢迎收听本期节目",
  "voiceId": "vol-cancan",
  "serviceId": "default-volcano",
  "speedRatio": 1.0,
  "emotion": "neutral",
  "outputFormat": "mp3"
}
```

**支持语音标记**（text 字段内）：
- `[pause:500ms]` — 停顿 0.5 秒
- `[pause:1000ms]` — 停顿 1 秒
- `[emphasis:strong]重要内容[/emphasis]` — 加重语气
- `[slow]慢慢说[/slow]` — 局部放慢
- `[fast]快速说[/fast]` — 局部加快

**响应**：
```json
{
  "success": true,
  "message": "合成成功",
  "data": {
    "generationId": "gen_1234567890",
    "audioData": "base64编码的音频数据",
    "duration": 15.2,
    "format": "mp3",
    "cost": 5,
    "costPrice": 2.5,
    "retailPrice": 5.0
  }
}
```

**扣费逻辑**：
- 管理员（`sandbox-admin-token`）：跳过扣费
- 普通用户：先检查余额 → 生成成功扣 `retailPrice` 积分 → 失败自动退款

### 3.4 声音克隆

```
POST /api/voice/clone
Content-Type: application/json
Authorization: Bearer {token}

{
  "voiceName": "我的声音",
  "engine": "volcano",
  "audioData": "base64编码的音频",
  "audioFormat": "wav",
  "language": "zh"
}
```

**响应**：
```json
{
  "success": true,
  "message": "克隆任务已提交，训练中",
  "data": {
    "cloneId": "volcano_1234567890",
    "speakerId": "S_xxxx",
    "status": "training",
    "estimatedTime": 60
  }
}
```

### 3.5 克隆状态查询

```
GET /api/voice/status?speakerId={speakerId}
```

**响应**：
```json
{
  "success": true,
  "data": {
    "status": "ready",  // training | ready | failed
    "speakerId": "S_xxxx"
  }
}
```

### 3.6 生成历史

```
GET /api/voice/history?page=1&pageSize=15
```

### 3.7 后台管理

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/admin/services` | GET | 获取全部服务卡片 |
| `/api/admin/services` | POST | 新建服务卡片 |
| `/api/admin/services` | PATCH | 更新服务卡片 |
| `/api/admin/services?id=xxx` | DELETE | 删除服务卡片 |
| `/api/admin/config` | GET | 获取引擎配置（旧版兼容） |
| `/api/admin/config` | POST | 保存引擎配置（旧版兼容） |
| `/api/admin/voices` | GET | 声音库管理 |
| `/api/admin/voices` | POST | 添加声音 |
| `/api/admin/voices` | PATCH | 编辑声音 |
| `/api/admin/voices?id=xxx` | DELETE | 删除声音 |

---

## 4. 统一响应格式

所有 API 返回统一结构：

```json
{
  "success": true,
  "data": {},
  "message": "操作成功"
}
```

错误：
```json
{
  "success": false,
  "data": null,
  "message": "错误描述"
}
```

HTTP 状态码：
- `200` — 成功
- `400` — 参数错误
- `402` — 积分不足
- `404` — 资源不存在
- `500` — 服务器异常

---

## 5. 引擎适配器对照表

| 引擎 ID | 引擎名称 | 支持 TTS | 支持克隆 | 语音标记翻译方式 |
|---------|---------|---------|---------|-----------------|
| `volcano` | 火山引擎 | ✅ | ✅ | 标点控制停顿，emotion 控制情感 |
| `cosyvoice` | 阿里云 CosyVoice | ✅ | ✅ | SSML break/emphasis/prosody 标签 |
| `fish_audio` | Fish Audio | ✅ | ✅ | prosody 标签 |
| `elevenlabs` | ElevenLabs | ✅ | ✅ | 标点+大写控制 |
| `gpt_sovits` | GPT-SoVITS | ✅ | ✅ | 参数控制 |
| `openai_tts` | OpenAI TTS | ✅ | ❌ | 标点控制 |

---

## 6. 部署信息

| 项 | 值 |
|----|-----|
| 服务器 | 134.175.87.247（腾讯云） |
| 主站端口 | 5000（PM2: agent-hub） |
| 语音工坊端口 | 8000（supervisord: preview-8000） |
| 域名 | zyuani8.com |
| 数据库 | Supabase（腾讯云北京） |
| Git 仓库 | https://gitee.com/zhujunguo/wangzhanbeifen.git |

---

## 7. 扣子集成要点

在扣子平台编写代码与语音工坊交互时：

1. **获取声音列表**：`fetch('http://localhost:8000/api/voice/list')`
2. **获取服务卡片**：`fetch('http://localhost:8000/api/voice/services')`
3. **生成语音**：`POST /api/voice/tts`，注意传 `serviceId` 选择服务卡片
4. **用户认证**：通过 Header 传递 `Authorization` 和 `X-User-Id`
5. **语音标记**：在 text 字段中直接使用 `[pause:500ms]` 等标记
6. **沙箱模式**：不传 token 即为沙箱管理员，不扣费
