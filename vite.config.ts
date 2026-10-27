import { defineConfig } from 'vite-plus'

/**
 * 仓库级工具链配置（Vite+）：lint（Oxlint）、fmt（Oxfmt）、test（Vitest）都在这里；
 * 各应用自己的 Vite / 打包配置在 apps/<name>/vite.config.ts。
 */
export default defineConfig({
  // pre-commit 只检查暂存文件：格式和 lint 能自动修的直接修好再提交
  staged: {
    '*.{ts,tsx,mts,cts,js,mjs,cjs,json,jsonc,css,html,yml,yaml,md}': 'vp check --fix',
    '*.md': 'markdownlint --fix',
  },
  lint: {
    plugins: ['typescript', 'react', 'jsx-a11y', 'unicorn', 'oxc'],
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    categories: { correctness: 'error' },
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      // 沿用 Biome recommended 里我们实际依赖的规则
      'typescript/no-explicit-any': 'error',
      'react/no-danger': 'error',
      'react/no-array-index-key': 'error',
      'jsx-a11y/no-autofocus': 'error',
      'jsx-a11y/media-has-caption': 'error',
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/anchor-is-valid': 'error',
      'jsx-a11y/click-events-have-key-events': 'error',
      'jsx-a11y/no-static-element-interactions': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',
      'jsx-a11y/no-redundant-roles': 'error',
      'jsx-a11y/label-has-associated-control': 'error',
      'react/button-has-type': 'error',
      'react/jsx-key': 'error',
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'typescript/require-array-sort-compare': ['error', { ignoreStringArrays: true }],
      // 类型感知规则里对本项目误报多的：组件 props 用方法签名、unknown 值转字符串
      'typescript/unbound-method': 'off',
      'typescript/no-base-to-string': 'off',
      'typescript/restrict-template-expressions': 'off',
      // 自定义的列表框、对话框、状态条用 role（Base UI 和手写组件都是这样），不强制换原生元素
      'jsx-a11y/prefer-tag-over-role': 'off',
      'jsx-a11y/no-noninteractive-element-interactions': 'off',
      'jsx-a11y/control-has-associated-label': 'off',
      // 遍历时会改动集合，[...map.keys()] 这类拷贝是有意的
      'unicorn/no-useless-spread': 'off',
      // React Compiler 系规则：项目没有启用 React Compiler
      'react/refs': 'off',
      'react/set-state-in-effect': 'off',
      'react/use-memo': 'off',
      'react/immutability': 'off',
    },
    ignorePatterns: ['**/dist/**', '**/dist-e2e/**', 'apps/server/drizzle/**'],
    options: { typeAware: true },
  },
  fmt: {
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    endOfLine: 'lf',
    singleQuote: true,
    jsxSingleQuote: false,
    semi: false,
    trailingComma: 'all',
    arrowParens: 'always',
    proseWrap: 'preserve',
    embeddedLanguageFormatting: 'off',
    sortPackageJson: false,
    // 代码用单引号；样式表、文档和配置文件保持双引号
    overrides: [
      {
        files: ['**/*.css', '**/*.md', '**/*.yaml', '**/*.yml', '**/*.html'],
        options: { singleQuote: false },
      },
    ],
    ignorePatterns: ['pnpm-lock.yaml', 'apps/server/drizzle/**', '**/dist/**', '**/dist-e2e/**'],
  },
  test: {
    projects: ['packages/*', 'apps/*'],
    coverage: {
      include: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        '**/*.gen.ts',
        '**/testing.ts',
        '**/testing/**',
        // Child-process test drivers are terminated with SIGKILL before V8 can flush coverage.
        'apps/server/src/runs/fixtures/submission-crash.child.ts',
        'apps/server/src/runs/fixtures/output-spool-crash.child.ts',
      ],
      reporter: ['text-summary', 'html', 'json-summary'],
      reportOnFailure: true,
      thresholds: {
        lines: 52,
        statements: 49,
        functions: 42,
        branches: 42,
        'packages/flow/src/{graph,key,schedule}.ts': {
          perFile: true,
          lines: 100,
          statements: 95,
          functions: 100,
          branches: 90,
        },
        'apps/server/src/runs/runs.ts': {
          lines: 95,
          statements: 90,
          functions: 95,
          branches: 80,
        },
        'apps/web/src/api/listSnapshot.ts': { 100: true },
        'apps/desktop/src/{prefs,preload,activity,downloads,window-state}.ts': {
          perFile: true,
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 90,
        },
      },
    },
  },
})
