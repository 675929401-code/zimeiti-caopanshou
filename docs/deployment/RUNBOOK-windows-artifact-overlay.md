# 运行手册：Windows 本机构建制品的完整 next 包覆盖（一次性修复）

> 记录于 2026-10-08，R000868 / web-direct-v4.1-83a457d 生产部署。
> 永久方案是 GitHub Actions Linux CI 构建（见 deploy.yml），本手册仅为 Windows 本机构建制品的应急修复参考。

## 问题

Windows 上 `next build` 的 NFT trace 裁剪 `.next/standalone` 的 node_modules 时可能漏掉运行时必需文件
（实例：`next/dist/lib/metadata/get-metadata-route.js`）。
本地预览用 `next start`（完整 node_modules）发现不了；服务器 standalone 候选进程启动即崩溃：
`Cannot find module '../../../lib/metadata/get-metadata-route'`。

## 修复步骤

1. 本地打包完整 next 包（pnpm 路径按实际版本调整）：

   ```bash
   cd "<项目>/node_modules/.pnpm/next@<版本标识>/node_modules"
   tar -czf next-full-overlay.tar.gz next
   ```

2. 上传服务器后，解开原制品，替换裁剪版 next：

   ```bash
   tar -xzf <制品>.tar.gz -C work
   rm -rf "work/node_modules/.pnpm/next@<版本标识>/node_modules/next"
   tar -xzf next-full-overlay.tar.gz -C "work/node_modules/.pnpm/next@<版本标识>/node_modules"
   # 校验关键文件存在
   ls "work/node_modules/.pnpm/next@<版本标识>/node_modules/next/dist/lib/metadata/get-metadata-route.js"
   tar -czf <制品>-fixed.tar.gz -C work .
   ```

3. 正常执行 `scripts/deploy-activate.sh`（候选验证 → 原子切换 → PM2 reload）。

## 判断标准

- 候选进程在 5100 端口通过 `/api/version` 校验即说明模块完整；
- 若仍报 `Cannot find module`，按同样思路检查是否为其他被裁剪的包——永久解法是不要在不受控的 Windows 环境构建生产制品。
