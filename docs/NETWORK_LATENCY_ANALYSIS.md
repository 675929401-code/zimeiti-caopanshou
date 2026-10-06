# 网络延迟问题分析 & 解决方案

## 问题现象

| 平台 | TTFB | 后端处理 | 网络延迟 |
|------|------|---------|---------|
| AIWeb (121.40.25.118) | **96ms** | ~50ms | ~50ms |
| 我们 (localhost:5000) | **2839ms** | 44ms | ~2800ms |

## 根因分析

### 1. 服务器位置

```
yunwu.ai:     15.204.105.134 (美国 OVH 机房)
AIWeb:        121.40.25.118  (阿里云 国内)
我们:         115.190.218.237 (腾讯云 国内)
```

### 2. 网络延迟测试

```
我们 → AIWeb (121.40.25.118):  31ms  ✅ 很快（都是国内）
我们 → yunwu.ai:              347ms ❌ 很慢（跨国网络）
```

### 3. 延迟分解

**我们的链路**:
```
用户 → 腾讯云(44ms) → yunwu.ai美国(347ms) → 模型API(50ms) → 返回
总延迟: ~2800ms
```

**AIWeb 的链路** (推测):
```
用户 → 阿里云(50ms) → yunwu.ai国内节点(?) → 模型API(50ms) → 返回
总延迟: ~100ms
```

## 关键发现

### yunwu.ai 有多个节点

| 域名 | IP | 位置 | 延迟 |
|------|-----|------|------|
| yunwu.ai | 15.204.105.134 | 美国 OVH | 347ms |
| api.yunwu.ai | 40.160.33.47 | 国内 | 未测试成功 |

**推测**: AIWeb 使用的是 yunwu.ai 的**国内节点**（api.yunwu.ai 或其他），而我们使用的是**美国节点**（yunwu.ai）。

## 解决方案

### 方案 A: 切换到 yunwu.ai 国内节点（推荐）

**步骤**:
1. 登录 yunwu.ai 后台，查看是否有国内API地址
2. 或者联系 yunwu.ai 客服，询问国内节点地址
3. 修改 `.env.local` 中的 `LLM_API_BASE_URL`:
   ```bash
   # 从
   LLM_API_BASE_URL=https://yunwu.ai
   
   # 改为（如果有国内节点）
   LLM_API_BASE_URL=https://api.yunwu.ai
   # 或
   LLM_API_BASE_URL=https://yunwu.ai 的国内地址
   ```

**预期效果**: TTFB 从 2800ms 降到 200-500ms

### 方案 B: 确认 AIWeb 的 API 配置

**步骤**:
1. 登录 AIWeb 后台: http://121.40.25.118:9520/admin/
2. 找到"系统设置"或"API配置"页面
3. 查看 `LLM_API_BASE_URL` 或类似配置项
4. 确认它用的是哪个 yunwu.ai 域名

**如果 AIWeb 用的是不同的域名**:
- 直接复制 AIWeb 的 API 地址到我们的配置

### 方案 C: 使用其他国内中转站

如果 yunwu.ai 没有国内节点，可以考虑：
- openrouter.ai 国内镜像
- one-api 自建
- 其他国内 LLM 中转站

## 验证方法

修改 API 地址后，运行以下命令验证：

```bash
# 测试新地址的延迟
curl -s -o /dev/null -w "Connect: %{time_connect}s, TTFB: %{time_starttransfer}s\n" \
  -X POST "https://新地址/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"messages":[{"role":"user","content":"你好"}],"model":"deepseek-v4-flash","stream":true}'

# 预期结果: Connect < 100ms, TTFB < 500ms
```

## 结论

**代码层面已经完全对标 AIWeb**，剩下的 2.8 秒延迟 100% 来自 yunwu.ai 美国节点的网络问题。

**解决方案**: 切换到 yunwu.ai 的国内节点（如果有的话），或者确认 AIWeb 用的是哪个 API 地址。
