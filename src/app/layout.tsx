import type { Metadata, Viewport } from "next";
import { Toaster } from "@/components/ui/sonner";
import "@xyflow/react/dist/style.css";
import "./globals.css";
import "./theme-polish.css";
import "./free-canvas-original.css";
import "./voice-studio/voice-studio.css";
import "./vs-workbench.css";
import "./theme-lattice.css";
import "./theme-crystal-aurora.css";
import "./theme-soft-white.css";
// Final cross-theme readability and responsive guards intentionally load last.
import "./ui-shell-fixes.css";
// Chat-only visual layer. It is scoped by data-chat-surface and must remain
// after the shared shell guards so the three themes render one glass surface.
import "./chat-glass-continuity.css";
import { AppProvider } from "@/contexts/app-context";
import { ErrorBoundary } from "@/components/error-boundary";
import { VersionChecker } from "@/components/version-checker";
import { ThemeInit } from "@/components/theme-init";
import { DiagnosticSentry } from "@/components/diagnostic-sentry";
import { SecondaryPageReturnGuard } from "@/components/secondary-page-return-guard";
import { AnnouncementPopup } from "@/components/announcement-popup";
import { AccountNotificationCenter } from "@/components/account-notification-center";
import { SecurityInterruptionDialog } from "@/components/security-interruption-dialog";
import { MemberFeatureBoundary, MemberPermissionProvider } from "@/components/member-permission-boundary";
import {
  DEFAULT_MODE_PREFERENCE,
  DEFAULT_THEME,
  LIGHT_THEMES,
  THEME_MODE_PREFERENCES,
  VALID_THEMES,
  resolveRenderedTheme,
  resolveThemeModeForTheme,
} from "@/lib/themes";
import { readPlatformAppearance } from "@/lib/server/platform-appearance";
import { readPublishedPlatformBranding } from "@/lib/server/brand-authority";

const SERIALIZED_VALID_THEMES = JSON.stringify(VALID_THEMES);
const SERIALIZED_LIGHT_THEMES = JSON.stringify(LIGHT_THEMES);
const SERIALIZED_MODE_PREFERENCES = JSON.stringify(THEME_MODE_PREFERENCES);
const SERIALIZED_DEFAULT_THEME = JSON.stringify(DEFAULT_THEME);
const SERIALIZED_DEFAULT_MODE_PREFERENCE = JSON.stringify(DEFAULT_MODE_PREFERENCE);

// The platform default is live configuration, so the root layout must not be
// frozen at build time. This read is public appearance only; no secret setting
// is serialized into the document.
export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export async function generateMetadata(): Promise<Metadata> {
  try {
    const branding = await readPublishedPlatformBranding();
    const name = branding.brand.name || "自媒体操盘手";
    const title = branding.brand.seo.title || name;
    const description = branding.brand.seo.description
      || branding.brand.description
      || "AI 内容经营系统";
    const squareLogo = branding.assets.logo_square?.url;
    const socialImage = branding.assets.social_share?.url || squareLogo;
    const favicon = branding.assets.favicon?.url || squareLogo;
    return {
      title: { default: title, template: `%s | ${name}` },
      description,
      keywords: ["自媒体", "内容经营", "智能体", "AI协作", "多智能体"],
      ...(favicon || squareLogo ? {
        icons: {
          ...(favicon ? { icon: favicon } : {}),
          ...(squareLogo ? { apple: squareLogo } : {}),
        },
      } : {}),
      openGraph: {
        type: "website",
        title,
        description,
        siteName: name,
        ...(socialImage ? { images: [{ url: socialImage }] } : {}),
      },
      twitter: {
        card: branding.assets.social_share?.url ? "summary_large_image" : "summary",
        title,
        description,
        ...(socialImage ? { images: [socialImage] } : {}),
      },
      robots: { index: true, follow: true },
    };
  } catch {
    return {
      title: { default: "自媒体操盘手", template: "%s | 自媒体操盘手" },
      description: "AI 内容经营系统",
      keywords: ["自媒体", "内容经营", "智能体", "AI协作"],
      robots: { index: true, follow: true },
    };
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const platformAppearance = await readPlatformAppearance();
  const rootTheme = platformAppearance.theme;
  const rootModePreference = platformAppearance.modePreference;
  const rootMode = resolveThemeModeForTheme(rootTheme, rootModePreference, true);
  const rootRenderedTheme = resolveRenderedTheme(rootTheme, rootModePreference, rootMode);

  return (
    <html
      lang="zh-CN"
      data-theme-selection={rootTheme}
      data-theme={rootRenderedTheme}
      data-mode-preference={rootModePreference}
      data-mode={rootMode}
      data-platform-theme-authoritative={platformAppearance.authoritative ? "true" : "false"}
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <body className="antialiased">
        {/*
          扣子沙箱在 <html> 和 <head> 之间注入 lf-cdn.coze.cn 的 script，
          page-editor-general-web 会创建全屏覆盖层导致 React 应用被遮挡（空白页）。
          此脚本只处理外部沙箱编辑器注入：
          1. 移除 coze script 标签（阻止其继续执行）
          2. 移除带明确编辑器标记的外部遮罩节点
          3. 恢复 body 和 Next/React 根节点可见
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
              var artifactSelector='script[src*="coze-space"],script[src*="coze-webapp"],[id*="page-editor-general-web"],[class*="page-editor-general-web"],[id*="coze-space"],[class*="coze-space"],[id*="coze-webapp"],[class*="coze-webapp"]';
              var visibleRootSelector='#__next,main,.app-shell,.landing-page';
              var inSandboxFrame=false;
              try{inSandboxFrame=window.self!==window.top}catch(e){inSandboxFrame=true}
              var hasCozeSignal=!!document.querySelector(artifactSelector+',script[src*="lf-cdn.coze.cn"]');
              var hasCozeReferrer=false;
              var hasCozeHost=false;
              try{
                var currentHost=window.location.hostname;
                var referrerHost=document.referrer?new URL(document.referrer).hostname:'';
                hasCozeReferrer=/(^|\\.)coze\\.(cn|com|site)$/.test(referrerHost);
                hasCozeHost=/(^|\\.)coze\\.(cn|com|site)$/.test(currentHost);
              }catch(e){}
              if(!inSandboxFrame||(!hasCozeSignal&&!hasCozeReferrer&&!hasCozeHost))return;

              var mo=null;
              var idleTimer=0;
              var maxTimer=0;
              var domReady=document.readyState!=='loading';

              function restoreVisible(el){
                if(!el||!el.style)return false;
                var restored=false;
                if(el.style.overflow==='hidden'){el.style.overflow='';restored=true}
                if(el.style.display==='none'){el.style.display='';restored=true}
                if(el.style.visibility==='hidden'){el.style.visibility='';restored=true}
                if(el.style.opacity==='0'){el.style.opacity='';restored=true}
                return restored;
              }
              function isVisibleRoot(el){
                return !!(el&&el.nodeType===1&&(el===document.body||(el.matches&&el.matches(visibleRootSelector))));
              }

              function removeArtifact(el){
                if(!el||el.nodeType!==1||!el.matches||!el.matches(artifactSelector))return false;
                if(el.tagName==='HTML'||el.tagName==='HEAD'||el.tagName==='BODY')return false;
                if(el.parentNode)el.parentNode.removeChild(el);
                return true;
              }

              function observeVisibleRoot(el){
                if(!mo||!isVisibleRoot(el))return;
                mo.observe(el,{attributes:true,attributeFilter:['style']});
              }

              function inspectAddedNode(node){
                if(!node||node.nodeType!==1)return false;
                var handled=removeArtifact(node);
                if(handled)return true;
                if(isVisibleRoot(node)){
                  restoreVisible(node);
                  observeVisibleRoot(node);
                  handled=true;
                }
                if(node.querySelectorAll){
                  node.querySelectorAll(artifactSelector).forEach(function(el){
                    if(removeArtifact(el))handled=true;
                  });
                  node.querySelectorAll(visibleRootSelector).forEach(function(el){
                    restoreVisible(el);
                    observeVisibleRoot(el);
                    handled=true;
                  });
                }
                return handled;
              }

              function inspectChangedNode(node){
                if(!node||node.nodeType!==1)return false;
                if(removeArtifact(node))return true;
                if(isVisibleRoot(node)){
                  return restoreVisible(node);
                }
                return false;
              }

              function inspectExisting(){
                document.querySelectorAll(artifactSelector).forEach(removeArtifact);
                restoreVisible(document.body);
                observeVisibleRoot(document.body);
                document.querySelectorAll(visibleRootSelector).forEach(function(el){
                  restoreVisible(el);
                  observeVisibleRoot(el);
                });
              }

              function stopObserver(){
                if(mo){mo.disconnect();mo=null}
                if(idleTimer){window.clearTimeout(idleTimer);idleTimer=0}
                if(maxTimer){window.clearTimeout(maxTimer);maxTimer=0}
                document.removeEventListener('DOMContentLoaded',onDomReady);
              }

              function scheduleIdleDisconnect(){
                if(!domReady||!mo)return;
                if(idleTimer)window.clearTimeout(idleTimer);
                idleTimer=window.setTimeout(stopObserver,500);
              }

              function onDomReady(){
                domReady=true;
                scheduleIdleDisconnect();
              }

              if(!domReady)document.addEventListener('DOMContentLoaded',onDomReady,{once:true});

              // 沙箱内只检查 MutationRecord 指向的新增/变更节点，避免每次全量扫描 document。
              mo=new MutationObserver(function(mutations){
                var handled=false;
                mutations.forEach(function(mutation){
                  if(mutation.type==='childList'){
                    mutation.addedNodes.forEach(function(node){
                      if(inspectAddedNode(node))handled=true;
                    });
                  }else if(mutation.type==='attributes'&&inspectChangedNode(mutation.target)){
                    handled=true;
                  }
                });
                if(handled)scheduleIdleDisconnect();
              });
              mo.observe(document.documentElement,{childList:true,subtree:true});
              inspectExisting();
              maxTimer=window.setTimeout(stopObserver,3000);
              scheduleIdleDisconnect();
            })();`,
          }}
        />
        {/*
          Google Fonts 通过客户端动态加载（见 agent-marketplace.tsx 的 loadGoogleFonts），
          不在此处使用 <link> 或 CSS @import，避免扣子端构建超时。
        */}
        {/*
          内联脚本：在 React hydrate 之前应用已经由服务端或上一轮账号校验
          确认的外观，防止首屏先显示硬编码主题再闪回。
        */}
        <script dangerouslySetInnerHTML={{ __html: `
          try {
            var allowedThemes = ${SERIALIZED_VALID_THEMES};
            var lightThemes = ${SERIALIZED_LIGHT_THEMES};
            var allowedModePreferences = ${SERIALIZED_MODE_PREFERENCES};
            var cachedPlatformTheme = localStorage.getItem('platform_theme');
            var serverTheme = document.documentElement.getAttribute('data-theme-selection');
            var serverModePreference = document.documentElement.getAttribute('data-mode-preference');
            var serverIsAuthoritative = document.documentElement.getAttribute('data-platform-theme-authoritative') === 'true';
            var platformTheme = serverIsAuthoritative && allowedThemes.indexOf(serverTheme) >= 0
              ? serverTheme
              : (allowedThemes.indexOf(cachedPlatformTheme) >= 0
                ? cachedPlatformTheme
                : (allowedThemes.indexOf(serverTheme) >= 0 ? serverTheme : ${SERIALIZED_DEFAULT_THEME}));
            var cachedPlatformMode = localStorage.getItem('platform_theme_mode');
            var platformModePreference = serverIsAuthoritative && allowedModePreferences.indexOf(serverModePreference) >= 0
              ? serverModePreference
              : (allowedModePreferences.indexOf(cachedPlatformMode) >= 0
                ? cachedPlatformMode
                : ${SERIALIZED_DEFAULT_MODE_PREFERENCE});
            var hasAuthSession = !!localStorage.getItem('auth_token');
            var cachedUserTheme = localStorage.getItem('user_theme_preference');
            var cachedUserMode = localStorage.getItem('user_theme_mode_preference');
            var hasValidatedUserAppearance = hasAuthSession
              && allowedThemes.indexOf(cachedUserTheme) >= 0
              && allowedModePreferences.indexOf(cachedUserMode) >= 0;
            var selectedTheme = hasValidatedUserAppearance ? cachedUserTheme : platformTheme;
            var selectedModePreference = hasValidatedUserAppearance ? cachedUserMode : platformModePreference;
            var selectedMode = lightThemes.indexOf(selectedTheme) >= 0 ? 'light' : 'dark';
            var renderedTheme = selectedTheme;
            if (serverIsAuthoritative) {
              localStorage.setItem('platform_theme', platformTheme);
              localStorage.setItem('platform_theme_mode', platformModePreference);
            }
            localStorage.setItem('app_theme', selectedTheme);
            localStorage.setItem('app_mode', selectedMode);
            document.documentElement.setAttribute('data-theme-selection', selectedTheme);
            document.documentElement.setAttribute('data-theme', renderedTheme);
            document.documentElement.setAttribute('data-mode-preference', selectedModePreference);
            document.documentElement.setAttribute('data-mode', selectedMode);
          } catch(e) {}
        ` }} />
        {/*
          表单提交防护 + Hydration备份登录
          1. 始终阻止 form 的默认提交行为（我们不需要浏览器原生表单提交）
          2. 如果 React hydration 正常，React 的 onSubmit 会通过事件委托处理
          3. 如果 React hydration 不完整（慢速网络等），通过原生 JS 直接调用登录 API
          
          执行时机：使用 setTimeout(0) 延迟到下一个事件循环，
          确保 React 的事件委托（如果存在）先处理完 submit 事件并设置标志。
        */}
        <script dangerouslySetInnerHTML={{ __html: `
          document.addEventListener('submit', function(e) {
            var form = e.target;
            if (form.tagName !== 'FORM') return;

            // 始终阻止默认提交行为
            e.preventDefault();

            // 延迟到下一事件循环检查 React 是否已处理
            // 如果 React hydration 正常，React 的 onSubmit 会同步执行并设置标志
            setTimeout(function() {
              // 如果 React 已处理，跳过
              if (window.__reactSubmitHandled) {
                window.__reactSubmitHandled = false;
                return;
              }

              // 该兜底只服务登录/安全验证表单。普通业务表单由 React
              // onSubmit 处理；不得把剧本、Agent、提示词等表单误判为
              // hydration 失败后强制刷新，否则会丢失输入和真实响应状态。
              var isAuthFallbackForm = form.hasAttribute('data-react-managed') && !!(
                (form.querySelector('input[name="account"]') && form.querySelector('input[name="password"]')) ||
                (form.querySelector('input[name="email"]') && form.querySelector('input[name="emailCode"]')) ||
                form.querySelector('input[name="securityAnswer"]')
              );
              if (!isAuthFallbackForm) return;

              // React 未处理 → hydration 不完整，手动处理登录
              console.warn('[FormGuard] React hydration不完整，使用原生登录备份');

              // 查找输入值
              var accountInput = form.querySelector('input[name="account"]');
              var passwordInput = form.querySelector('input[name="password"]');
              var emailInput = form.querySelector('input[name="email"]');
              var emailCodeInput = form.querySelector('input[name="emailCode"]');
              var securityAnswerInput = form.querySelector('input[name="securityAnswer"]');

              var btn = form.querySelector('button[type="submit"]');
              var origBtnText = btn ? btn.textContent : '';

              // 安全问题验证
              if (securityAnswerInput) {
                var answer = securityAnswerInput.value;
                if (!answer.trim()) return;
                try {
                  var savedAccount = localStorage.getItem('last_login_account') || '';
                  var authPasswordInput = document.querySelector('form[data-react-managed] input[name="password"]');
                  var pw = authPasswordInput ? authPasswordInput.value : '';
                  if (btn) { btn.textContent = '验证中...'; btn.disabled = true; }
                  fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phone: savedAccount, password: pw, securityAnswer: answer })
                  }).then(function(r) { return r.json(); }).then(function(d) {
                    if (d.success) {
                      localStorage.setItem('auth_token', d.token);
                      localStorage.setItem('auth_user', JSON.stringify(d.user));
                      window.location.href = '/';
                    } else {
                      alert(d.error || '验证失败');
                      if (btn) { btn.textContent = origBtnText; btn.disabled = false; }
                    }
                  }).catch(function() {
                    alert('网络错误，请稍后重试');
                    if (btn) { btn.textContent = origBtnText; btn.disabled = false; }
                  });
                } catch(ex) {}
                return;
              }

              // 邮箱登录
              if (emailInput && emailCodeInput) {
                var email = emailInput.value;
                var code = emailCodeInput.value;
                if (!email || !code) return;
                if (btn) { btn.textContent = '登录中...'; btn.disabled = true; }
                fetch('/api/auth/login-email', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ email: email, code: code })
                }).then(function(r) { return r.json(); }).then(function(d) {
                  if (d.success) {
                    localStorage.setItem('auth_token', d.token);
                    localStorage.setItem('auth_user', JSON.stringify(d.user));
                    localStorage.setItem('last_login_email', email);
                    localStorage.setItem('last_login_mode', 'email');
                    window.location.href = '/';
                  } else {
                    alert(d.error || '登录失败');
                    if (btn) { btn.textContent = origBtnText; btn.disabled = false; }
                  }
                }).catch(function() {
                  alert('网络错误，请稍后重试');
                  if (btn) { btn.textContent = origBtnText; btn.disabled = false; }
                });
                return;
              }

              // 账号密码登录
              if (accountInput && passwordInput) {
                var account = accountInput.value;
                var password = passwordInput.value;
                if (!account || !password) return;
                if (btn) { btn.textContent = '登录中...'; btn.disabled = true; }
                fetch('/api/auth/login', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ phone: account, password: password })
                }).then(function(r) { return r.json(); }).then(function(d) {
                  if (d.success) {
                    localStorage.setItem('auth_token', d.token);
                    localStorage.setItem('auth_user', JSON.stringify(d.user));
                    localStorage.setItem('last_login_account', account);
                    localStorage.setItem('last_login_mode', 'account');
                    window.location.href = '/';
                  } else if (d.code === 'REGION_VERIFY_REQUIRED') {
                    alert('需要安全验证，请刷新页面后重试');
                    location.reload();
                  } else if (d.code === 'NO_PASSWORD_SET') {
                    alert('该账号未设置密码，请使用邮箱登录');
                    if (btn) { btn.textContent = origBtnText; btn.disabled = false; }
                  } else {
                    alert(d.error || '账号或密码错误');
                    if (btn) { btn.textContent = origBtnText; btn.disabled = false; }
                  }
                }).catch(function() {
                  alert('网络错误，请稍后重试');
                  if (btn) { btn.textContent = origBtnText; btn.disabled = false; }
                });
                return;
              }

            }, 0);
          }, true); // capture 阶段，确保最先拦截
        ` }} />
        {/* 安全的 outline 覆盖：移除沙箱设计编辑器的 hover 虚线框，不干预事件系统 */}
        <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: `
          (function() {
            // 检测是否在沙箱iframe中（Coze平台的设计编辑器只在iframe中激活）
            var isInSandbox = window !== window.top;
            if (!isInSandbox) return;
            
            // 1. 移除编辑器注入的contenteditable属性
            var observer = new MutationObserver(function(mutations) {
              mutations.forEach(function(m) {
                if (m.type === 'attributes' && m.attributeName === 'contenteditable') {
                  m.target.removeAttribute('contenteditable');
                }
                // 2. 移除编辑器注入的浮动工具栏（fixed/absolute定位，高z-index，小尺寸）
                if (m.type === 'childList' && m.addedNodes) {
                  m.addedNodes.forEach(function(node) {
                    if (node.nodeType === 1) {
                      var style = window.getComputedStyle(node);
                      var rect = node.getBoundingClientRect();
                      // 编辑器工具栏特征：fixed/absolute定位，z-index>1000，宽度<500px
                      if ((style.position === 'fixed' || style.position === 'absolute') && 
                          parseInt(style.zIndex) > 1000 && 
                          rect.width < 500 && rect.height < 200 &&
                          rect.width > 50 && rect.height > 20) {
                        // 检查是否包含编辑器特征（字体选择、字号等）
                        var text = node.textContent || '';
                        if (text.includes('Font') || text.includes('字体') || 
                            text.includes('Size') || text.includes('Bold') ||
                            node.querySelector('[class*="font"], [class*="size"]')) {
                          node.remove();
                        }
                      }
                    }
                  });
                }
              });
            });
            observer.observe(document.documentElement, {
              attributes: true,
              childList: true,
              subtree: true,
              attributeFilter: ['contenteditable']
            });
            
            // 3. 定期检查并移除编辑器注入的style标签
            setInterval(function() {
              var styles = document.querySelectorAll('style');
              styles.forEach(function(s) {
                var text = s.textContent || '';
                // 编辑器style特征：包含outline dashed或特定class
                if (text.includes('outline') && text.includes('dashed') && 
                    (text.includes('#00') || text.includes('blue') || text.includes('rgb(0'))) {
                  s.remove();
                }
              });
            }, 500);
          })();
        ` }} />
        {/* 沙箱 page-editor 覆盖层清理：延迟检测并移除编辑器创建的全屏遮罩/覆盖层 */}
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            function cleanupEditorOverlay() {
              try {
                // 检测并移除 page-editor 创建的全屏覆盖层
                // 特征：fixed/absolute 定位 + 高 z-index(>999) + 全屏尺寸 + 透明/半透明背景
                var all = document.querySelectorAll('div, section, aside');
                for (var i = 0; i < all.length; i++) {
                  var el = all[i];
                  var style = window.getComputedStyle(el);
                  var rect = el.getBoundingClientRect();
                  var z = parseInt(style.zIndex);
                  // 编辑器覆盖层特征：高z-index + 几乎全屏 + 不是页面内容
                  if (z > 999 && rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.9) {
                    // 检查是否是页面自身内容（有文字或有子内容）
                    var text = (el.textContent || '').trim();
                    var childCount = el.children.length;
                    // 如果元素本身几乎没文字内容，且background透明/半透明，很可能是编辑器覆盖层
                    var bg = style.backgroundColor;
                    var isTransparentBg = bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' || bg === '';
                    if (text.length < 50 && isTransparentBg) {
                      console.warn('[SandboxCleaner] 移除疑似编辑器覆盖层:', el, 'z-index:', z, 'size:', rect.width+'x'+rect.height);
                      el.style.display = 'none';
                      el.style.pointerEvents = 'none';
                      el.style.zIndex = '-1';
                    }
                  }
                }
              } catch(e) {}
            }
            // 页面加载后延迟检测
            if (document.readyState === 'complete') {
              setTimeout(cleanupEditorOverlay, 1000);
            } else {
              window.addEventListener('load', function() {
                setTimeout(cleanupEditorOverlay, 1000);
                // 3秒后再检测一次（page-editor可能延迟创建覆盖层）
                setTimeout(cleanupEditorOverlay, 3000);
              });
            }
          })();
        ` }} />
        <ThemeInit />
        <AppProvider>
          <MemberPermissionProvider>
            <SecondaryPageReturnGuard />
            <ErrorBoundary>
              <MemberFeatureBoundary>{children}</MemberFeatureBoundary>
            </ErrorBoundary>
            <ErrorBoundary>
              <SecurityInterruptionDialog />
            </ErrorBoundary>
            <ErrorBoundary>
              <AnnouncementPopup />
            </ErrorBoundary>
            <ErrorBoundary>
              <AccountNotificationCenter />
            </ErrorBoundary>
            <Toaster position="top-center" richColors />
            <DiagnosticSentry />
            <VersionChecker />
          </MemberPermissionProvider>
        </AppProvider>
      </body>
    </html>
  );
}
