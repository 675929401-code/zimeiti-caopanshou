"use client";

type IntegrationSettingKey =
  | "coze_api_base_url"
  | "coze_api_token"
  | "coze_workspace_id"
  | "email_smtp_host"
  | "email_smtp_port"
  | "email_smtp_user"
  | "email_smtp_pass"
  | "email_from";

interface IntegrationSettingsSnapshot {
  coze_api_base_url: string;
  coze_api_token: string;
  coze_api_token_configured?: boolean;
  coze_workspace_id: string;
  email_smtp_host: string;
  email_smtp_port: string;
  email_smtp_user: string;
  email_smtp_pass: string;
  email_smtp_pass_configured?: boolean;
  email_from: string;
}

interface CozeConnectionResult {
  connected: boolean;
  botCount?: number;
  sampleBots?: Array<{ bot_id: string; bot_name: string }>;
  error?: string;
}

interface IntegrationSettingsAdminTabProps {
  settings: IntegrationSettingsSnapshot;
  settingsSaving: boolean;
  canManageIntegrations: boolean;
  cozeTestResult: CozeConnectionResult | null;
  updateSetting: (key: IntegrationSettingKey, value: string) => void;
  testConnection: () => void | Promise<void>;
  saveCozeSettings: () => void;
  saveSmtpSettings: () => void;
}

const inputCls = "w-full px-3 py-2.5 bg-[var(--card)] border border-[var(--border)] rounded-xl text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)] transition-colors placeholder-[var(--muted-foreground)]";
const labelCls = "block text-sm text-[var(--secondary-foreground)] mb-1.5";
const cardCls = "bg-[var(--card)] rounded-2xl p-6 border border-[var(--border)]";
const btnPrimary = "px-4 py-2.5 bg-[var(--card)] text-[var(--foreground)] border border-[var(--border)] rounded-xl text-sm font-semibold hover:bg-[var(--accent)] hover:border-[var(--primary)]/30 transition-colors";

export function IntegrationSettingsAdminTab({
  settings,
  settingsSaving,
  canManageIntegrations,
  cozeTestResult,
  updateSetting,
  testConnection,
  saveCozeSettings,
  saveSmtpSettings,
}: IntegrationSettingsAdminTabProps) {
  return (
    <div>
                <h2 className="text-lg font-semibold text-[var(--foreground)] mb-4">模型与外部服务</h2>
                {/* Coze API Connection */}
                <div className={cardCls}>
                  <h3 className="font-semibold text-[var(--foreground)] mb-1">智能体平台连接</h3>
                  <p className="text-xs text-[var(--muted-foreground)] mb-3">标准 Coze 平台在这里配置；扣子编程连接随具体智能体单独保存。</p>
    
                  {/* Simple 2-step guide */}
                  <div className="mb-4 p-3 rounded-lg border border-[var(--brand)]/20 bg-[var(--brand)]/5 text-xs space-y-3">
                    <p className="text-[var(--foreground)] font-medium text-sm">你是哪种开发方式？</p>
                    <div className="flex gap-2.5">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-[var(--brand)] text-[var(--foreground)] text-xs flex items-center justify-center font-bold">A</span>
                      <div>
                        <span className="text-[var(--foreground)] font-medium">coze.cn 平台搭建</span>
                        <div className="text-[var(--secondary-foreground)] mt-0.5">
                          填写下方“模型与外部服务” → 测试连接成功 → 智能体管理 → “从平台导入”
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2.5">
                      <span className="shrink-0 w-6 h-6 rounded-full bg-[var(--brand)] text-[var(--foreground)] text-xs flex items-center justify-center font-bold">B</span>
                      <div>
                        <span className="text-[var(--foreground)] font-medium">code.coze.cn 扣子编程搭建</span>
                        <div className="text-[var(--secondary-foreground)] mt-0.5">
                          智能体管理 → “添加智能体” → 选择“编程智能体” → 填写该智能体自己的 API 地址、Token 和 Project ID
                        </div>
                      </div>
                    </div>
                  </div>
    
                  <div className="grid grid-cols-1 gap-4">
                    <div>
                      <label className={labelCls}>API 地址</label>
                      <input value={settings.coze_api_base_url} onChange={(e) => updateSetting("coze_api_base_url", e.target.value)} className={inputCls} placeholder="https://api.coze.cn" />
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1">默认 https://api.coze.cn，一般无需修改</p>
                    </div>
                    <div>
                      <label className={labelCls}>
                        API Token (密钥)
                        <span className="ml-2 text-[10px] text-[var(--brand)] font-normal">必填</span>
                      </label>
                      <div className="relative">
                        <input value={settings.coze_api_token} onChange={(e) => updateSetting("coze_api_token", e.target.value)} className={inputCls} type="password" placeholder={settings.coze_api_token_configured ? "已配置；留空保留原密钥" : "粘贴你的 Personal Access Token"} />
                      </div>
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1">
                        智能体平台 → <a href="https://www.coze.cn/open/api" target="_blank" rel="noopener" className="text-[var(--brand)] underline">个人设置 → API 令牌</a> → 生成新令牌（勾选 Bot 读取）
                      </p>
                    </div>
                    <div>
                      <label className={labelCls}>
                        工作空间 ID
                        <span className="ml-2 text-[10px] text-[var(--muted-foreground)] font-normal">选填</span>
                      </label>
                      <input value={settings.coze_workspace_id} onChange={(e) => updateSetting("coze_workspace_id", e.target.value)} className={inputCls} placeholder="不填则自动搜索所有空间的智能体" />
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1">
                        如需限定空间：打开 <a href="https://www.coze.cn/space" target="_blank" rel="noopener" className="text-[var(--brand)] underline">智能体工作空间</a>，地址栏 <code className="text-[var(--brand)]">/space/</code> 后的数字。留空则搜索全部
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-col gap-3 mt-4">
                    <div className="flex items-center gap-4">
                      <button onClick={testConnection} disabled={!canManageIntegrations || settingsSaving} className={`${btnPrimary} disabled:opacity-50`}>测试连接</button>
                      <span className="text-xs text-[var(--muted-foreground)]">修改后需手动保存</span>
                    <button onClick={saveCozeSettings} disabled={settingsSaving || !canManageIntegrations} className="px-4 py-1.5 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] font-bold text-xs hover:opacity-90 transition disabled:opacity-50">
                      {settingsSaving ? "保存中..." : "保存"}
                    </button>
                      {cozeTestResult && (
                        <div className={`text-sm flex items-center gap-2 ${cozeTestResult.connected ? "text-[var(--success)]" : "text-[var(--destructive)]"}`}>
                          <span className={`w-2 h-2 rounded-full ${cozeTestResult.connected ? "bg-[var(--success)]" : "bg-[var(--destructive)]"}`}></span>
                          {cozeTestResult.connected
                            ? `已连接，发现 ${cozeTestResult.botCount ?? 0} 个智能体`
                            : cozeTestResult.error || "连接失败"}
                        </div>
                      )}
                    </div>
                    {cozeTestResult && cozeTestResult.connected && (cozeTestResult.botCount ?? 0) > 0 && cozeTestResult.sampleBots && (
                      <div className="p-2.5 rounded-lg border border-[var(--brand)]/20 bg-[var(--brand)]/5 text-xs text-[var(--secondary-foreground)]">
                        <p className="font-medium text-[var(--foreground)] mb-1.5">发现智能体预览（前 {cozeTestResult.sampleBots.length} 个）：</p>
                        <div className="space-y-1.5">
                          {cozeTestResult.sampleBots.map((bot) => (
                            <div key={bot.bot_id} className="flex items-center gap-2">
                              <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand)]" />
                              <span className="text-[var(--foreground)]">{bot.bot_name}</span>
                              <span className="text-[var(--muted-foreground)] text-[10px]">{bot.bot_id}</span>
                            </div>
                          ))}
                        </div>
                        {(cozeTestResult.botCount ?? 0) > 5 && (
                          <p className="mt-1.5 text-[var(--muted-foreground)]">...共 {cozeTestResult.botCount} 个，前往“智能体管理”Tab → 批量导入</p>
                        )}
                        <p className="mt-2 text-[var(--brand)]">连接成功！请切换到“智能体管理”Tab → 点击“从平台批量导入”</p>
                      </div>
                    )}
                    {cozeTestResult && cozeTestResult.connected && (cozeTestResult.botCount ?? 0) === 0 && (
                      <div className="p-2.5 rounded-lg border border-yellow-800/40 bg-yellow-900/10 text-xs text-yellow-400">
                        <p className="font-medium mb-1">连接成功，但发现 0 个智能体</p>
                        <ul className="list-disc ml-4 space-y-0.5 text-yellow-400/80">
                          <li>如果填了工作空间 ID — 请确认是否正确，或留空自动搜索全部空间</li>
                          <li>Token 权限不足 — 确保生成令牌时勾选了“Bot 读取”权限</li>
                          <li>智能体平台还没有创建智能体 — 请先在对应平台创建</li>
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
    
                {/* ── 邮件服务配置 ── */}
                <div className="mt-6 p-4 rounded-lg border border-[var(--border)] bg-[var(--card)]">
                  <h3 className="font-semibold text-[var(--foreground)] mb-1 flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${settings.email_smtp_user ? "bg-[var(--success)]" : "bg-[var(--destructive)]"}`}></span>
                    邮件服务配置
                    <span className="text-[10px] font-normal text-[var(--muted-foreground)]">注册验证码/登录验证码发送</span>
                  </h3>
                  <p className="text-[11px] text-[var(--muted-foreground)] mb-3">
                    配置 SMTP 邮件服务，用于发送注册和登录验证码。支持 QQ邮箱、163邮箱、Gmail 等常见邮箱。
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className={labelCls}>
                        SMTP 服务器地址
                        <span className="ml-2 text-[10px] text-[var(--muted-foreground)] font-normal">必填</span>
                      </label>
                      <input
                        value={settings.email_smtp_host}
                        onChange={(e) => updateSetting("email_smtp_host", e.target.value)}
                        className={inputCls}
                        placeholder="smtp.qq.com"
                      />
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1">QQ邮箱: smtp.qq.com | 163邮箱: smtp.163.com | Gmail: smtp.gmail.com</p>
                    </div>
                    <div>
                      <label className={labelCls}>SMTP 端口</label>
                      <input
                        value={settings.email_smtp_port}
                        onChange={(e) => updateSetting("email_smtp_port", e.target.value)}
                        className={inputCls}
                        placeholder="465"
                      />
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1">SSL加密: 465 | STARTTLS: 587</p>
                    </div>
                    <div>
                      <label className={labelCls}>
                        SMTP 用户名（邮箱）
                        <span className="ml-2 text-[10px] text-[var(--muted-foreground)] font-normal">必填</span>
                      </label>
                      <input
                        value={settings.email_smtp_user}
                        onChange={(e) => updateSetting("email_smtp_user", e.target.value)}
                        className={inputCls}
                        placeholder="your@qq.com"
                        type="email"
                      />
                    </div>
                    <div>
                      <label className={labelCls}>
                        SMTP 授权码
                        <span className="ml-2 text-[10px] text-[var(--muted-foreground)] font-normal">必填</span>
                      </label>
                      <input
                        value={settings.email_smtp_pass}
                        onChange={(e) => updateSetting("email_smtp_pass", e.target.value)}
                        className={inputCls}
                        type="password"
                        placeholder={settings.email_smtp_pass_configured ? "已配置；留空保留原授权码" : "邮箱授权码（非登录密码）"}
                      />
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1">QQ邮箱: 设置 → 账户 → POP3/SMTP → 生成授权码</p>
                    </div>
                    <div className="md:col-span-2">
                      <label className={labelCls}>
                        发件人名称
                        <span className="ml-2 text-[10px] text-[var(--muted-foreground)] font-normal">选填</span>
                      </label>
                      <input
                        value={settings.email_from}
                        onChange={(e) => updateSetting("email_from", e.target.value)}
                        className={inputCls}
                        placeholder='如：安哥自媒体文案操盘手'
                      />
                      <p className="text-[10px] text-[var(--muted-foreground)] mt-1">收件人看到的发件人名称。留空则使用“基本设置”中的平台名称</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 mt-4">
                    <span className="text-xs text-[var(--muted-foreground)]">修改后需手动保存</span>
                    <button onClick={saveSmtpSettings} disabled={settingsSaving || !canManageIntegrations} className="px-4 py-1.5 rounded-lg bg-[var(--primary)] text-[var(--primary-foreground)] font-bold text-xs hover:opacity-90 transition disabled:opacity-50">
                      {settingsSaving ? "保存中..." : "保存"}
                    </button>
                    {settings.email_smtp_user ? (
                      <div className="text-sm flex items-center gap-2 text-[var(--success)]">
                        <span className="w-2 h-2 rounded-full bg-[var(--success)]"></span>
                        已配置
                      </div>
                    ) : (
                      <div className="text-sm flex items-center gap-2 text-[var(--destructive)]">
                        <span className="w-2 h-2 rounded-full bg-[var(--destructive)]"></span>
                        未配置
                      </div>
                    )}
                  </div>
                </div>
    
              </div>
  );
}
