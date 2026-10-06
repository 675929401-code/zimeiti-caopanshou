import nextTs from 'eslint-config-next/typescript';
import nextVitals from 'eslint-config-next/core-web-vitals';
import { defineConfig, globalIgnores } from 'eslint/config';

const syntaxRules = [
  {
    selector: 'JSXOpeningElement[name.name="head"]',
    message:
      '禁止使用 head 标签，优先使用 metadata。三方 CSS、字体等资源可以在 globals.css 中顶部通过 @import 引入或者使用 next/font；preload, preconnect, dns-prefetch 通过 ReactDOM 的 preload、preconnect、dns-prefetch 方法引入；json-ld 可阅读 https://nextjs.org/docs/app/guides/json-ld',
  },
];

const nextConfigRestrictedSyntaxRules = [
  {
    selector:
      'Property[key.name=/^(root|outputFileTracingRoot)$/] > Literal[value=/^\\//]',
    message:
      '禁止在 next.config 中写死绝对路径，请改用 path.resolve(__dirname, ...)、import.meta.dirname 或 process.cwd() 动态拼接。',
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Keep React/Next rules on the same file set where eslint-config-next
    // registers its flat-config plugins. Without this scope, ESLint also
    // applies react/* rules to unrelated files such as .cjs and rejects the
    // configuration before linting any source.
    files: ['**/*.{js,jsx,mjs,ts,tsx,mts,cts}'],
    rules: {
      'react-hooks/set-state-in-effect': 'off',
      // 这些规则在当前历史代码中主要是风格/React Compiler 迁移噪声。
      // 交付门禁保留构建、类型检查、受限语法和专项安全脚本为硬错误；
      // legacy 规则先降为 warning，避免把旧代码大面积机械改写成新风险。
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@next/next/no-html-link-for-pages': 'warn',
      'prefer-const': 'warn',
      'react/no-unescaped-entities': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
      'no-restricted-syntax': ['error', ...syntaxRules],
    },
  },
  {
    files: ['next.config.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...nextConfigRestrictedSyntaxRules],
    },
  },
  {
    // PM2 and a few Node entrypoints intentionally use CommonJS. Requiring
    // ESM syntax in a .cjs file would make the runtime format self-contradictory.
    files: ['**/*.cjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Node verification scripts use `module` as an isolated vm fixture object.
    // The Next.js browser/module global restriction does not apply to them.
    files: ['scripts/**/*.mjs'],
    rules: {
      '@next/next/no-assign-module-variable': 'off',
    },
  },
  // ─── 模块边界护栏 ───
  // 组件层不应直接引用底层 lib（应通过 context/hook/api-client），新代码强制走正确路径
  {
    files: ['src/components/**/*.tsx', 'src/components/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'warn',
        {
          patterns: [
            {
              group: ['@/lib/billing', '@/lib/revenue', '@/lib/security', '@/lib/prompt-guard'],
              message: '组件不应直接引用底层 lib，应通过 context hook 或 api-client 间接调用。如确需使用，请在同行添加 // eslint-disable-next-line 注释说明原因。',
            },
          ],
        },
      ],
    },
  },
  // API路由不应直接引用其他业务域的内部实现（应通过该域的公共API）
  {
    files: ['src/app/api/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'warn',
        {
          patterns: [
            {
              group: ['@/app/api/**/route'],
              message: 'API路由不应跨路由引用，应抽取共享逻辑到 @/lib/ 或 @/storage/。如确需引用，请添加 // eslint-disable-next-line。',
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    '.next-*/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Build artifacts:
    'server.js',
    'dist/**',
    'coverage/**',
    'playwright-report/**',
    'test-results/**',
    // Script files (CommonJS):
    'scripts/**/*.js',
    // Local verification / Codex scratch artifacts:
    '.codex-temp/**',
    '.codex-artifacts/**',
    '.codex-evidence/**',
    '.codex-runtime/**',
    '.codex-snapshots/**',
    '.codex-task-snapshots/**',
    '.codex-backups/**',
    '.codex-runtime-backups/**',
    '.tmp-e2e/**',
    '.codex-screenshots/**',
    '.verification/**',
    '.runtime/**',
    'tmp/**',
    '.tmp-*/**',
    'tests/**',
    'test-*.js',
    'research/**',
    'research-output/**',
    'artifacts/**',
    'evidence-archive/**',
    '任务快照/**',
    '备份快照/**',
    '%SystemDrive%/**',
    '--output=.codex-evidence/**',
    // Historical paid/live canary scripts are kept as evidence runners and
    // should not block static source delivery lint.
    'scripts/run-*.ts',
    'scripts/resume-*.ts',
    // Non-project directories (from remote repo merge):
    'main-site/**',
    'voice-studio/**',
    'voice-platform/**',
    'docs/**',
    'backups/**',
    '项目备份/**',
    // 智音工坊集成代码（来自外部项目，放宽检查）
    'src/components/voice-studio/**',
    'src/lib/voice-platform/**',
    'src/app/voice-studio/**',
    'src/app/api/tts/**',
    'src/app/api/reference-audio/**',
    'src/app/api/license/**',
    'src/app/api/audio-generate/**',
    'src/app/api/voices/**',
    'src/app/api/voice/link-clone/**',
  ]),
]);

export default eslintConfig;
