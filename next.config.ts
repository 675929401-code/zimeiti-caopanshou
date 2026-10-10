import type { NextConfig } from 'next';

const deploymentVersion = process.env.DEPLOYMENT_VERSION?.trim();

const nextConfig: NextConfig = {
  // The isolated local-data preview must never share the active dev cache.
  // Production and all other values retain Next's normal output directory.
  distDir: process.env.LOCAL_ACCEPTANCE_PREVIEW === "true" && [".next-local-acceptance", ".next-local-acceptance-next"].includes(process.env.LOCAL_VALIDATION_DIST_DIR || "")
    ? process.env.LOCAL_VALIDATION_DIST_DIR
    : process.env.NODE_ENV === 'development' && process.env.LOCAL_VALIDATION_DIST_DIR === '.next-validation'
    ? '.next-validation'
    : '.next',
  // 生产发布只交付 Next.js traced runtime，不再把完整 node_modules 复制到服务器。
  // Web 构建器固定从项目根执行；保留 Next 的默认 tracing root，避免动态 cwd 让 NFT 追踪整个工作树。
  output: 'standalone',
  // video-postprocess intentionally discovers a packaged FFmpeg binary at
  // runtime. Without an explicit boundary, Node File Trace treats that dynamic
  // lookup as permission to copy the whole checkout (including backups and
  // research material) into the production standalone directory. Public assets
  // and FFmpeg are materialized explicitly by prepare-next-standalone-assets.
  outputFileTracingExcludes: {
    '/*': [
      './.codex-backups/**/*',
      './.codex-evidence/**/*',
      './.codex-snapshots/**/*',
      './.logs/**/*',
      './.runtime/**/*',
      './.tmp-e2e/**/*',
      './.codex-temp/**/*',
      './.next-validation/**/*',
      './.next-local-acceptance/**/*',
      './.next-local-acceptance-next/**/*',
      './--output=.codex-evidence/**/*',
      './%SystemDrive%/**/*',
      './artifacts/**/*',
      './assets/**/*',
      './backups/**/*',
      './data/**/*',
      './deploy/**/*',
      './docs/**/*',
      './evidence-archive/**/*',
      './prompts/**/*',
      './research/**/*',
      './research-output/**/*',
      // Mutable runtime state (including generated gateway and signing keys)
      // is mounted outside every release. It must never enter Next's traced
      // standalone tree from a developer checkout.
      './runtime/**/*',
      './scripts/**/*',
      './src/**/*',
      './supabase/**/*',
      './tests/**/*',
      './voice-platform/**/*',
      './任务快照/**/*',
      './备份快照/**/*',
    ],
  },
  // Next 16 使用 deploymentId 处理滚动发布期间的 RSC/Server Action 版本偏斜。
  // BUILD_ID 是框架内部构建标识，发布身份由 commit + deploymentId + provenance 共同证明。
  deploymentId: deploymentVersion || undefined,
  // 隐藏 X-Powered-By 响应头，不暴露技术栈
  poweredByHeader: false,
  // 跳过构建时的 TypeScript 类型检查（Turbopack 在某些环境下会生成不存在的 .next/types/validator.ts）
  typescript: {
    ignoreBuildErrors: true,
  },
  // 生产构建跳过 source map 生成（减少 30%+ 构建内存 + 加快构建速度）
  productionBrowserSourceMaps: false,
  // 服务端外部包：不打包进 bundle，运行时动态加载（减少构建内存）
  // 原生模块（含 .node 二进制）+ 大型 SDK + 可选依赖
  serverExternalPackages: [
    'cos-nodejs-sdk-v5',
    'coze-coding-dev-sdk',
    'dotenv',
    'sharp',
    '@img/sharp-*',
    'onnxruntime-node',
    'better-sqlite3',
    'bcrypt',
    'pg-native',
    'utf-8-validate',
    'bufferutil',
  ],
  // Pin the workspace to this checkout. Letting Next infer it on this Windows
  // host can make the watcher crawl the entire F: drive and delay first paint.
  turbopack: { root: process.cwd() },
  allowedDevOrigins: [
    // 本地 Codex 沙箱与浏览器开发入口。
    // 缺少这两项时，Next.js 会拒绝 HMR WebSocket 的 Origin，
    // 页面虽然能打开，但保存源码后无法可靠热更新。
    '127.0.0.1',
    'localhost',
    'zyuani8.com',
    'www.zyuani8.com',
    'zycheni9.com',
    'www.zycheni9.com',
    '0fb80e6a-09a8-42a8-b7bb-aadbfdeef5e5.dev.coze.site',
    '0fb80e6a-09a8-42a8-b7bb-aadbfdeef5e5-5000.dev.coze.site',
  ],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*',
        pathname: '/**',
      },
    ],
  },
  // These two public sections were retired from the Manju workbench. Keep the
  // former URLs useful by sending saved bookmarks straight to the workbench.
  redirects: async () => [
    // Retired standalone utility URLs now enter the matching tab in the
    // consolidated toolbox. Keep these at the config layer so bookmarks get a
    // real redirect before the legacy page component or app shell can mount.
    {
      source: '/extract',
      destination: '/tools?tab=text',
      permanent: false,
    },
    {
      source: '/formatter',
      destination: '/tools?tab=format',
      permanent: false,
    },
    {
      source: '/segmenter',
      destination: '/tools?tab=segment',
      permanent: false,
    },
    {
      source: '/inspiration',
      destination: '/youcai/inspiration',
      permanent: false,
    },
    // App Router redirects can fall back to a streamed HTTP 200 shell after a
    // parent layout has flushed. Config-level redirects run before rendering,
    // so saved chat aliases receive a real HTTP 307 without mounting the app.
    {
      source: '/tools/chat',
      destination: '/tools/text/text-chat',
      permanent: false,
    },
    {
      source: '/tools/canvas',
      destination: '/storyboard-workbench?legacy=canvas-entry',
      permanent: false,
    },
    {
      source: '/youcai/tools/chat',
      destination: '/youcai/tools/text/text-chat',
      permanent: false,
    },
    {
      source: '/youcai/creative-horizon',
      destination: '/youcai',
      permanent: true,
    },
    {
      source: '/youcai/navigation',
      destination: '/youcai',
      permanent: true,
    },
    {
      source: '/creative-horizon',
      destination: '/youcai',
      permanent: true,
    },
    {
      source: '/navigation',
      destination: '/youcai',
      permanent: true,
    },
  ],
  // 智音工坊完整版（独立 Next.js 服务，端口 5001）
  rewrites: async () => [
    {
      source: '/voice-platform/:path*',
      destination: 'http://localhost:5001/voice-platform/:path*',
    },
  ],
  headers: async () => [
    {
      source: '/avatars/optimized/:path*',
      headers: [
        {
          key: 'Cache-Control',
          value: 'public, max-age=31536000, immutable',
        },
      ],
    },
    {
      source: '/youcai-media/v1/thumbnails/:path*',
      headers: [
        {
          key: 'Cache-Control',
          value: 'public, max-age=31536000, immutable',
        },
      ],
    },
    {
      source: '/youcai-media/v1/posters/:path*',
      headers: [
        {
          key: 'Cache-Control',
          value: 'public, max-age=31536000, immutable',
        },
      ],
    },
    {
      source: '/youcai-media/v1/canvas-showcases/derived/:path*',
      headers: [
        {
          key: 'Cache-Control',
          value: 'public, max-age=31536000, immutable',
        },
      ],
    },
    {
      source: '/short-drama/:path*',
      headers: [
        {
          key: 'Cache-Control',
          value: 'public, max-age=31536000, immutable',
        },
      ],
    },
    {
      source: '/product-assets/:path*',
      headers: [
        {
          key: 'Cache-Control',
          value: 'public, max-age=31536000, immutable',
        },
      ],
    },
  ],
  experimental: {
    // Reduce webpack's peak retained heap in the constrained Linux release
    // builder. This is Next.js' supported low-memory compilation mode.
    webpackMemoryOptimizations: true,
    // Match the audited Nginx ceiling. Individual authenticated upload routes
    // enforce smaller limits before buffering (digital human requests: 102 MiB).
    proxyClientMaxBodySize: "200mb",
    // 限制 webpack 并行编译线程数（降低峰值内存，防止沙箱 OOM）
    // 默认值 = CPU 核数，沙箱 4 核 → 4 线程同时编译 → 峰值内存 4x
    // 限制 2 线程 → 峰值减半，构建稍慢但不会 OOM
    cpus: 2,
    optimizePackageImports: [
      'lucide-react',
      '@radix-ui/react-icons',
      'recharts',
      'date-fns',
      'drizzle-orm',
    ],
  },
  webpack: (config, { isServer, nextRuntime, webpack, dev }) => {
    // 生产构建禁用 source map 以减少内存
    if (process.env.NODE_ENV === 'production') {
      config.devtool = false;
    }
    if (!isServer || nextRuntime !== 'nodejs') {
      // instrumentation.ts 会在多运行时编译。H3 生命周期只在 Node.js
      // 启动时动态加载，客户端/Edge 编译不应尝试解析 COS SDK 依赖的
      // Node 内置模块，否则会把 fs/path/stream/crypto 误判为缺失。
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...config.resolve.fallback,
        assert: false,
        buffer: false,
        child_process: false,
        crypto: false,
        dns: false,
        fs: false,
        http: false,
        https: false,
        net: false,
        os: false,
        path: false,
        querystring: false,
        stream: false,
        tls: false,
        url: false,
        util: false,
        zlib: false,
      };
      config.plugins = config.plugins || [];
      config.plugins.push(
        // The media queue runtime now also owns Commerce's Node 24 SQLite
        // worker. Keep that whole process-only graph out of Edge/browser
        // instrumentation; register() already returns before this import there.
        new webpack.IgnorePlugin({ resourceRegExp: /media-queue-worker-runtime$/ }),
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
          resource.request = resource.request.replace(/^node:/, '');
        }),
      );
    }
    if (!isServer && !dev) {
      // 将大型库拆分为独立 chunk，避免阻塞首屏加载
      config.optimization = config.optimization || {};
      config.optimization.splitChunks = {
        chunks: 'all',
        cacheGroups: {
          // Markdown 渲染库（仅聊天页面需要，延迟加载）
          markdown: {
            test: /[\\/]node_modules[\\/](remark|rehype|unified|bail|is-plain-obj|trough|vfile|unist|micromark)[\\/]/,
            name: 'markdown',
            priority: 30,
            reuseExistingChunk: true,
          },
          // 语法高亮（仅代码块需要）
          highlight: {
            test: /[\\/]node_modules[\\/](highlight\.js|lowlight|refractor)[\\/]/,
            name: 'highlight',
            priority: 25,
            reuseExistingChunk: true,
          },
          // Radix UI 组件
          radix: {
            test: /[\\/]node_modules[\\/]@radix-ui[\\/]/,
            name: 'radix',
            priority: 20,
            reuseExistingChunk: true,
          },
          // Lucide 图标
          lucide: {
            test: /[\\/]node_modules[\\/]lucide-react[\\/]/,
            name: 'lucide',
            priority: 20,
            reuseExistingChunk: true,
          },
        },
      };
    }
    return config;
  },
};

export default nextConfig;
