import type { Metadata } from "next";
import { ArrowLeft, Download } from "lucide-react";
import { PUBLISHING_PLUGIN_DOWNLOADS } from "@/lib/publishing-native";
import styles from "./plugin-guide.module.css";

export const metadata: Metadata = {
  title: "发布插件安装教程",
  description: "发布工作台浏览器插件安装、授权、域名配置与平台账号连接教程。",
};

export default function PluginGuidePage() {
  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <a className={styles.back} href="/publish-center">
            <ArrowLeft size={15} />
            返回发布工作台
          </a>
          <span className={styles.crumb}>发布工作台 / 插件安装教程</span>
        </div>
      </header>

      <div className={styles.layout}>
        <article className={styles.article}>
          <p className={styles.eyebrow}>发布工作台 · 浏览器插件</p>
          <h1>发布插件安装教程</h1>
          <p className={styles.meta}>适用于插件 v{PUBLISHING_PLUGIN_DOWNLOADS.version} · 更新于 2026-11-11</p>

          <section id="overview">
            <h2>教程概览</h2>
            <p>
              发布工作台使用浏览器插件复用你当前浏览器中的平台登录态，把作品发布到小红书、微信视频号和抖音。本站不会要求你填写平台密码，也不需要把 Cookie 交给网页。
            </p>
            <p>
              这份教程覆盖从下载安装、仅授权、配置本站域名，到回到发布工作台检测并连接账号的完整流程。只需要安装一次，以后更新插件时按本页步骤替换旧版即可。
            </p>
            <div className={styles.callout}>
              <strong>只从本页下载</strong>
              <span>不要使用聊天群、网盘或陌生链接里的修改版插件。安装前可核对下方 SHA-256。</span>
            </div>
            <div className={styles.downloadBox}>
              <div>
                <h3>下载最新版插件</h3>
                <p>v{PUBLISHING_PLUGIN_DOWNLOADS.version} · Windows / Chrome / Edge · CRX 安装包</p>
              </div>
              <a href={PUBLISHING_PLUGIN_DOWNLOADS.direct} download={`aitoearn-extension-v${PUBLISHING_PLUGIN_DOWNLOADS.version}.crx`}>
                <Download size={17} />
                下载插件 v{PUBLISHING_PLUGIN_DOWNLOADS.version}
              </a>
            </div>
            <p className={styles.hash}>SHA-256：{PUBLISHING_PLUGIN_DOWNLOADS.sha256}</p>
          </section>

          <section id="prepare">
            <h2>准备工作</h2>
            <ul>
              <li>一台电脑，使用 Chrome 或 Edge 浏览器；手机浏览器不能安装扩展。</li>
              <li>同一个浏览器里已经登录要发布的平台账号，例如抖音、小红书或视频号。</li>
              <li>当前网站地址是 <code>https://zyuani8.com</code>；本地预览通常是 <code>http://127.0.0.1:5000</code>。</li>
              <li>如果浏览器开了“下载前询问保存位置”，下载时会先弹出系统保存窗口；否则文件会进入默认下载目录。</li>
            </ul>
          </section>

          <section id="install">
            <h2>第一步：安装插件</h2>
            <ol>
              <li>
                <strong>下载安装包。</strong> 点击本页的“下载插件”按钮，保存 <code>aitoearn-extension-v{PUBLISHING_PLUGIN_DOWNLOADS.version}.crx</code>。
              </li>
              <li>
                <strong>打开扩展管理页。</strong> Chrome 地址栏输入 <code>chrome://extensions</code>；Edge 输入 <code>edge://extensions</code>。
              </li>
              <li>
                <strong>开启开发者模式。</strong> 打开扩展页右上角的“开发者模式”开关。
              </li>
              <li>
                <strong>拖入 CRX 文件。</strong> 把下载的 <code>.crx</code> 文件拖到扩展页面中间，按浏览器提示确认安装。不要直接双击文件。
              </li>
              <li>
                <strong>确认插件已启用。</strong> 在扩展列表中看到 AiToEarn 插件，并确认开关为开启状态。
              </li>
            </ol>
            <p className={styles.note}>Chrome 可能提示“无法从该网站添加扩展”。这是非商店 CRX 的常规限制，请确认已开启开发者模式后，用拖入方式安装。</p>
          </section>

          <section id="authorize">
            <h2>第二步：选择“仅授权”</h2>
            <p>
              打开插件侧栏或选项页，点击 <strong>Authorize Only（仅授权）</strong>。这个模式不要求登录 AiToEarn 网页账号，但仍然允许本站调用插件的发布能力。
            </p>
            <ul>
              <li>不要选择需要登录 AiToEarn 账号的模式。</li>
              <li>不要授予与本站无关的网站来源。</li>
              <li>授权后刷新发布中心或本教程页，让插件重新注入页面。</li>
            </ul>
            <p className={styles.note}>仅授权只影响插件登录方式；你仍然需要在本站登录自己的账号，并在同一浏览器登录目标平台。</p>
          </section>

          <section id="origin">
            <h2>第三步：配置本站域名</h2>
            <p>
              在插件的“允许注入的域名”中填写发布工作台的来源。正式环境填写：
            </p>
            <pre><code>https://zyuani8.com/</code></pre>
            <p>
              本地预览填写：
            </p>
            <pre><code>http://127.0.0.1:5000/</code></pre>
            <p>
              每行一个地址，只填写你信任的站点。这里不是抖音、小红书或视频号的网址。点击 <strong>Confirm and authorize（确认并授权）</strong>，然后刷新本站。
            </p>
            <p className={styles.note}>
              新版扩展（3.3.x）把这一步放在侧栏「仅授权」弹窗的“允许注入的域名”输入框。只点“仅授权”而不填本站域名，扩展不会向本站注入 Web API，页面会一直显示“未检测到”；这不是插件没安装。保存域名并确认后务必刷新本页；必要时重启浏览器再检测。
            </p>
          </section>

          <section id="connect">
            <h2>第四步：连接平台账号</h2>
            <ol>
              <li>回到发布工作台的“平台账号”页面。</li>
              <li>页面检测到插件后，点击目标平台的“连接账号”，再选择“浏览器插件发布”。</li>
              <li>如果账号已在同一浏览器登录目标平台，插件会读取账号摘要；这里读取的是平台账号，不是 360 浏览器账号。</li>
              <li>如果页面提示“未检测到”，先完成第三步的域名注入并刷新本页，再点左下角“重新检测”。</li>
            </ol>
            <div className={styles.callout}>
              <strong>没有安装插件时会怎样？</strong>
              <span>平台账号页会显示“未检测到浏览器发布插件”，连接浏览器类平台会直接带你回到本教程，不会让你在缺少插件时继续授权。</span>
            </div>
            <p>
              官方 API 平台不需要浏览器插件，例如快手当前走官方授权/API 通道；这类平台的连接方式与浏览器插件不同，请以平台卡片上的说明为准。
            </p>
          </section>

          <section id="platforms">
            <h2>平台支持范围</h2>
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr><th>平台</th><th>视频</th><th>图文</th><th>主要要求</th></tr>
                </thead>
                <tbody>
                  <tr><td>小红书</td><td>支持</td><td>支持，最多 9 张</td><td>视频需要封面</td></tr>
                  <tr><td>微信视频号</td><td>支持</td><td>暂不支持</td><td>视频需要封面</td></tr>
                  <tr><td>抖音</td><td>支持</td><td>支持，1～35 张</td><td>标题、正文和话题按平台限制</td></tr>
                </tbody>
              </table>
            </div>
            <p>平台规则会调整，实际可发布能力以发布工作台账号卡片和平台提示为准。</p>
          </section>

          <section id="faq">
            <h2>常见问题</h2>
            <h3>下载后找不到文件</h3>
            <p>打开浏览器下载记录，查看文件保存位置。Windows Chrome/Edge 默认通常在用户目录的 <code>Downloads</code>；也可以在浏览器设置中开启“下载前询问保存位置”。</p>
            <h3>浏览器不允许安装 CRX</h3>
            <p>确认扩展页已开启“开发者模式”，并且是拖入扩展页面而不是双击文件。仍被拦截时，换用 Chrome/Edge 最新版，或先移除旧版插件再安装。</p>
            <h3>安装后仍提示未检测到插件</h3>
            <p>刷新发布工作台；确认插件已启用；在本页重新下载最新版。仍不行时重启浏览器，或在扩展页移除旧版后重新安装。</p>
            <h3>如何更新插件</h3>
            <p>回到本页下载最新版，在扩展页移除旧版后重新安装，再回平台账号页点“重新检测”。不要同时保留多个旧版本。</p>
          </section>
        </article>
      </div>
    </main>
  );
}
