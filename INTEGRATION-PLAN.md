# 智音工坊 → 主站整合技术方案

> 版本: v1.0
> 日期: 2025-07-21
> 作者: 架构决策记录

---

## 一、现状分析

### 1.1 当前架构（问题态）

```
用户浏览器
    │
    ├── 主站 (端口 5000) ─── Supabase (PostgreSQL)
    │       │
    │       ├── /admin ─── 后台管理（含 voice-studio Tab）
    │       │               └── iframe 嵌入 → /voice-platform/admin
    │       │
    │       ├── /voice-studio ─── iframe 嵌入 → /voice-platform
    │       │
    │       └── next.config rewrites ─── proxy /voice-platform/* → 5001
    │
    └── 智音工坊独立服务 (端口 5001) ─── SQLite
            │
            ├── 独立 layout、独立主题、独立路由
            ├── 独立用户系统（与主站不互通）
            ├── 独立数据库（与主站 Supabase 隔离）
            └── 独立鉴权（自有 JWT/密码体系）
```

**核心问题**：
1. iframe 无法融合主题，像"截图贴上去"
2. 两套用户系统，登录状态不互通
3. 两套数据库（SQLite + Supabase），数据孤岛
4. 后台管理中的 voice-studio Tab 全屏独占，挡住其他 Tab
5. 音色数据不完整（主站 241 个，火山官方 301 个）
6. 缺少音色上传和火山引擎同步功能

### 1.2 主站已有能力（无需重复造轮子）

| 模块 | 文件路径 | 说明 |
|------|---------|------|
| 声音库 CRUD | `src/lib/store.ts` | JSON 文件存储，getAllVoices/addVoice/updateVoice/deleteVoice |
| 声音库 API | `src/app/api/admin/voices/route.ts` | GET/POST/PATCH/DELETE |
| TTS 引擎 | `src/lib/tts/` | 火山引擎/CosyVoice/ElevenLabs/FishAudio/OpenAI TTS |
| 扣费系统 | `src/app/api/voice/tts/route.ts` | 已集成 credits 扣除 + 失败退款 |
| 火山音色库 | `src/lib/voice-studio/voices-volc.ts` | 241 个音色数据 |
| 音色试听 | `src/app/api/voice/preview/route.ts` | 免费试听 |
| 声音克隆 | `src/app/api/voice/clone/route.ts` | 声音复刻 |
| 引擎配置 | `src/app/api/admin/voice-config/route.ts` | 引擎 API Key 管理 |

### 1.3 智音工坊独立服务（需迁移的部分）

| 页面 | 路径 | 说明 |
|------|------|------|
| 首页 | `/voice-platform/` | Hero + 功能入口 |
| 工作台 | `/voice-platform/workspace` | TTS 生成工作台 |
| 音色库 | `/voice-platform/voices` | 音色浏览/筛选 |
| 声音设计 | `/voice-platform/design` | 声音参数设计 |
| 声音模仿 | `/voice-platform/imitate` | 声音模仿 |
| 声音克隆 | `/voice-platform/clone` | 声音克隆（上传参考音频） |
| 登录 | `/voice-platform/login` | 独立用户登录 |
| 后台 | `/voice-platform/admin` | 独立管理后台 |

---

## 二、目标架构

### 2.1 整合后架构

```
用户浏览器
    │
    └── 主站 (端口 5000) ─── Supabase (PostgreSQL)
            │                              │
            ├── /admin (含 voice-studio Tab)│
            ├── /voice-studio (智音工坊首页) │
            ├── /voice-studio/workspace     │
            ├── /voice-studio/voices        │
            ├── /voice-studio/design        │
            ├── /voice-studio/imitate       │
            ├── /voice-studio/clone         │
            └── 对象存储 (S3) ───────────────┘
```

**关键变化**：
1. 智音工坊页面**全部迁移为主站的本地路由组件**
2. 音色数据从 SQLite → Supabase（或保持主站现有 JSON 存储）
3. 对象存储存音频文件（缓存用签名 URL，永久存 fileKey）
4. 用户直接使用主站登录态，无额外认证
5. 主题使用主站现有 DESIGN.md 规范（玻璃拟态风格）
6. 扣费走主站已有 billing 系统

### 2.2 路由设计

| 路径 | 页面组件 | 菜单位置 |
|------|---------|---------|
| `/voice-studio` | 智音工坊首页 | 主站侧边栏 |
| `/voice-studio/workspace` | TTS 工作台 | 智音工坊内导航 |
| `/voice-studio/voices` | 音色库 | 智音工坊内导航 |
| `/voice-studio/design` | 声音设计 | 智音工坊内导航 |
| `/voice-studio/imitate` | 声音模仿 | 智音工坊内导航 |
| `/voice-studio/clone` | 声音克隆 | 智音工坊内导航 |
| `/admin`（voice-studio Tab） | 后台管理 Tab | 主站后台 Tab 栏 |

---

## 三、数据库方案

### 3.1 方案选择：保持现有 JSON 存储 + Supabase 扩展

**理由**：
- 主站 `src/lib/store.ts` 已经用 JSON 文件存储声音库数据
- 音色数据主要是**读多写少**（基础音色只从火山引擎同步写入，很少修改）
- JSON 存储简单可靠，无需额外数据库迁移
- 上传的音色文件存对象存储，数据库只需记录 fileKey

**优化方向**：
| 数据类 | 存储位置 | 说明 |
|--------|---------|------|
| 基础音色库 (241 个官方音色) | `data/voices.json` + 代码中常量 | 读多写少 |
| 用户上传音色 | `data/custom-voices.json` | 管理后台 CRUD |
| 音频文件 | 对象存储 (S3) | 永久保存 fileKey |
| 生成记录 | `data/generations.json` | 历史查询 |
| 扣费记录 | Supabase `transactions` 表 | 已有，复用 |
| 引擎配置 | `data/engine-configs.json` | API Key 等 |

### 3.2 数据流

```
用户上传音色文件
    → 前端 multipart/form-data
    → POST /api/voice/upload
    → S3Storage.uploadFile() → 得到 fileKey
    → 写入 data/custom-voices.json（存 fileKey + 元数据）
    → 用户预览时 S3Storage.generatePresignedUrl() 生成临时 URL
```

---

## 四、存储方案（缓存 vs 永久）

### 4.1 分类原则

| 数据类型 | 存储方式 | 有效期 | 说明 |
|---------|---------|--------|------|
| **火山引擎音色** | 纯数据（JSON/代码常量） | 永久 | 无音频文件，TTS 时实时生成 |
| **用户上传参考音频** | 对象存储 fileKey | 永久 | 声音克隆的参考素材 |
| **TTS 生成结果** | 对象存储 fileKey | 临时（7天） | 用户可下载到本地 |
| **试听片段** | 对象存储 fileKey 或临时 URL | 缓存（1天） | 不持久化，过期自动清理 |
| **卡通头像** | 项目 `/public/avatars/` | 永久 | 静态资源，随代码部署 |
| **引擎配置** | `data/engine-configs.json` | 永久 | API Key 等敏感配置 |

### 4.2 缓存清理策略

```
TTS 生成音频：
  - 生成 → 对象存储（fileKey）→ 记录到数据库
  - 7天后 → 定时任务/懒删除
  - 用户下载后 → 本地保存，云端可删
  
试听音频：
  - 试听 → 实时生成 → 直接流式返回
  - 不持久化存储
  - 如果需要缓存 → 对象存储，24h 过期

上传参考音频（声音克隆）：
  - 永久保存，直到用户主动删除
```

### 4.3 对象存储目录结构

```
/voice-studio/
  ├── uploads/{userId}/{uuid}.{ext}        # 用户上传参考音频（永久）
  ├── generations/{userId}/{uuid}.{ext}    # TTS 生成结果（7天清理）
  └── previews/{uuid}.{ext}               # 试听缓存（24h 过期）
```

---

## 五、扣费系统集成

### 5.1 现状：主站已有扣费链路

```
POST /api/voice/tts
  → 查询用户 credits（Supabase users 表）
  → credits >= price？ 扣减：返回余额不足
  → 调用 TTS 引擎
  → 成功：扣费生效
  → 失败：退款（原路返还 credits）
  → 记录 transactions 表
```

### 5.2 计费标准

| 服务 | 价格（积分） | 说明 |
|------|------------|------|
| TTS 生成（基础音色） | 引擎配置中 `retailPrice` | 按次/按字符 |
| 声音克隆 | 引擎配置中 `retailPrice` | 按次 |
| 音色试听 | 免费 | 不扣费 |

### 5.3 无需改造

主站 `src/app/api/voice/tts/route.ts` 已完整实现扣费逻辑，迁移页面后直接调用同一 API 即可。

---

## 六、主题兼容方案

### 6.1 现状冲突

| 方面 | 主站（admin 后台） | 智音工坊独立服务 |
|------|-------------------|-----------------|
| 背景 | CSS 变量 `var(--background)` | 硬编码深色 `#030910` |
| 卡片 | `var(--card)` | 半透明玻璃 `rgba(255,255,255,.08)` |
| 主色 | `var(--primary)` | `#7C5CFF` |
| 字体 | 系统字体 | Inter/SF Pro |

### 6.2 整合方案

**原则**：智音工坊的前台页面（用户可见）保持 DESIGN.md 的玻璃拟态风格，后台页面融入主站 admin 主题。

| 页面 | 主题策略 |
|------|---------|
| `/voice-studio/*`（前台） | 沿用 DESIGN.md 毛玻璃风格，独立于 admin 主题 |
| `/admin` voice-studio Tab | 使用 admin 主题 CSS 变量，保持一致 |

**技术实现**：
- 前台智音工坊页面使用独立的 CSS 类名前缀 `.voice-studio-*`
- 后台 voice-studio Tab 使用 `var(--background)` 等 admin 变量
- 不互相污染样式

---

## 七、音色库补充计划

### 7.1 现状

| 数据来源 | 数量 |
|---------|------|
| 火山引擎官方文档 | ~301 个 |
| 主站 `voices-volc.ts` | 241 个 |
| 独立服务 `seed.ts` | 164 个 |

### 7.2 需补充约 60 个音色

**来源**：火山引擎官方文档 https://www.volcengine.com/docs/6561/1257544

**补充方式**：
1. 从火山引擎文档爬取最新音色列表
2. 与现有 241 个对比，输出缺失列表
3. 按格式补全到 `voices-volc.ts`
4. 后台"同步"按钮可直接拉取

---

## 八、音色上传功能设计

### 8.1 上传流程

```
用户 → 智音工坊后台 → 音色管理 → "上传音色" 按钮
  → 选择音频文件（MP3/WAV/OGG）
  → 填写元数据（名称、性别、场景、标签）
  → 上传到对象存储
  → 写入 data/custom-voices.json
  → 前台音色库 "我的音色" 分类展示
```

### 8.2 文件规格

| 项目 | 规格 |
|------|------|
| 格式 | MP3 / WAV / OGG |
| 大小 | ≤ 50MB/个 |
| 总容量 | ≤ 5GB/用户（后台可配置） |
| 采样率 | 16000Hz ~ 48000Hz |
| 时长 | 最多 30 分钟/个 |

### 8.3 存储路径

```
对象存储 /voice-studio/uploads/{userId}/{uuid}.{ext}
  → 永久保存
  → 数据库记录 fileKey + 元数据
  → 前端通过 generatePresignedUrl 获取访问 URL
```

---

## 九、火山引擎同步功能设计

### 9.1 同步流程

```
后台 → 点击"同步音色"按钮
  → GET /api/admin/voices/sync
  → 调用火山引擎 ListSpeakers API
  → 对比本地数据，找出新增/变更
  → 增量更新 data/voices.json
  → 返回同步结果（新增X个，更新Y个）
```

### 9.2 API 对接

火山引擎 TTS API 文档：
- 端点：`https://open.volcengine.com/api/v3/tts/speakers`
- 认证：`Authorization: Bearer {api_key}`
- 返回：Speaker 列表（id, name, gender, language, tags）

---

## 十、实施步骤与优先级

### Phase 1：修复基础问题（优先级 P0）

| # | 任务 | 预估工时 | 说明 |
|---|------|---------|------|
| 1.1 | 修复后台入口：点击"管理后台"进入主后台（含所有 Tab），非智音工坊独占 | 0.5h | 已修复 |
| 1.2 | 将智音工坊页面从 iframe 改为本地路由（先迁移核心页面） | 4h | — |
| 1.3 | 主题兼容处理：前台毛玻璃、后台 admin 变量 | 1h | — |

### Phase 2：功能完善（优先级 P1）

| # | 任务 | 预估工时 | 说明 |
|---|------|---------|------|
| 2.1 | 补全音色库至 301 个 | 2h | 从火山引擎文档补充 |
| 2.2 | 实现音色上传功能（前端+后端+存储） | 3h | — |
| 2.3 | 实现火山引擎同步按钮 | 2h | — |

### Phase 3：清理与优化（优先级 P2）

| # | 任务 | 预估工时 | 说明 |
|---|------|---------|------|
| 3.1 | 停用 5001 端口独立服务 | 0.5h | 确认迁移完成后关闭 |
| 3.2 | 删除 next.config 中的 rewrite 代理 | 0.5h | — |
| 3.3 | 清理 iframe 相关残留代码 | 0.5h | — |
| 3.4 | 全量回归测试 | 1h | — |

---

## 十一、风险与注意事项

### 11.1 数据库兼容
- 智音工坊 SQLite 使用 Prisma ORM，主站使用 Supabase
- 迁移时先将 Prisma schema 转换为 Supabase 表结构
- 注意 Prisma 的 autoincrement 与 Supabase UUID 的差异

### 11.2 用户鉴权
- 智音工坊独立服务有自己的 bcrypt 密码体系
- 整合后改用主站 Supabase auth，旧用户需引导重新注册或迁移

### 11.3 文件上传安全
- 限制文件类型（仅允许 MP3/WAV/OGG）
- 服务端校验 MIME type
- 文件名 sanitize（移除特殊字符）
- 使用对象存储签名 URL，不暴露直接路径

### 11.4 存储成本控制
- 永久存储 vs 临时缓存严格区分
- 临时文件设置生命周期策略自动清理
- 用户上传文件总容量限制（5GB/用户）
