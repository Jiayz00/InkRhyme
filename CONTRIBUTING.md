# Contributing

## Setup

```bash
git clone https://github.com/Jiayz00/InkRhyme.git
cd InkRhyme
pnpm install
pnpm build
```

Node ≥ 20（推荐 22+），pnpm ≥ 9。

## 项目结构

```
packages/
  core/      # @inkrhyme/core — 写作引擎
  desktop/   # @inkrhyme/desktop — Electron 桌面应用
  cli/       # 原始 CLI（保留参考）
  studio/    # 原始 Web 工作台（保留参考）
```

Monorepo 由 pnpm workspace 管理。`desktop` 依赖 `core`（`workspace:*`）。

## 开发

```bash
pnpm build                    # 构建所有包
pnpm dev                      # 所有包 watch 模式
pnpm dev:desktop              # 启动 Electron 桌面应用（开发模式）
pnpm --filter @inkrhyme/core test        # core 单元测试
pnpm --filter @inkrhyme/core typecheck   # core 类型检查
pnpm --filter @inkrhyme/desktop typecheck # desktop 类型检查
```

## 提交规范

```
<type>: <description>
```

类型：`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`

保持提交原子性——每个提交一个逻辑变更。

## PR 检查清单

- [ ] `pnpm build` 通过
- [ ] `pnpm test` 通过
- [ ] `pnpm typecheck` 通过
- [ ] 新功能有测试
- [ ] 提交信息遵循上述规范

## 代码风格

- TypeScript, strict mode
- 2 空格缩进
- 不可变模式：`{ ...obj, key: value }` 而非 mutation
- 函数 < 50 行，文件 < 800 行
- 错误必须暴露，不得静默吞掉

## 测试

测试使用 Vitest，与源码同目录的 `__tests__/` 中。

```bash
pnpm --filter @inkrhyme/core test    # Core 测试
```

涉及 LLM 流水线的功能，mock LLM 调用——不要在测试中发真实 API 请求。

## 问题？

Open an issue: https://github.com/Jiayz00/InkRhyme/issues
