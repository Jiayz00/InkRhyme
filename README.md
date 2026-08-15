# InkRhyme

> 交互式 AI 写作工作台 — 从一个想法到一本完结小说

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Jiayz00/InkRhyme?style=flat&logo=github&color=yellow)](https://github.com/Jiayz00/InkRhyme/stargazers)

InkRhyme 是一个基于 Electron 的桌面 AI 写作工作台，专为长篇小说创作设计。它提取了 [InkOS](https://github.com/Narcooo/inkos) 的写作引擎核心，在此基础上重新设计了交互层和性能架构。

## 特性

- **对话式创作**：与 AI 自由对话，在合适的时机将内容固化为结构化卡片（选题卡、情节卡、伏笔卡等）
- **画布视图**：卡片作为可视化节点拖拽连线，展示情节线和伏笔网络
- **灵活工作流**：推荐路径引导但不强制——随时跳步、回退、并行编辑
- **完整写作流水线**：规划 → 上下文装配 → 正文生成 → 状态结算 → 一致性审计 → 修订 → 后处理
- **性能优化**：锁释放 fire-and-forget、State Validator 本地规则快路径、审计阶段共享缓存
- **混合持久化**：Markdown 真相文件 + SQLite 索引层，兼顾引擎复用和 UI 查询性能
- **多 LLM 支持**：通过 OpenAI 兼容接口接入任意模型

## 快速开始

### 环境要求

- Node.js ≥ 20（推荐 22+，需要 `node:sqlite` 支持）
- pnpm ≥ 9

### 安装

```bash
git clone https://github.com/Jiayz00/InkRhyme.git
cd InkRhyme
pnpm install
pnpm build
```

### 配置 LLM

在项目根目录的 `inkos.json` 中配置：

```json
{
  "llm": {
    "provider": "openai",
    "service": "custom",
    "baseUrl": "https://your-api-endpoint/v1",
    "model": "your-model-name",
    "apiKey": "your-api-key",
    "apiFormat": "chat",
    "stream": true
  }
}
```

或通过环境变量：

```bash
export INKOS_LLM_API_KEY="your-api-key"
export INKOS_LLM_BASE_URL="https://your-api-endpoint/v1"
export INKOS_LLM_MODEL="your-model-name"
```

### 启动桌面应用

```bash
pnpm dev:desktop
```

在应用中输入项目路径，加载书籍列表，点击「Write Next Chapter」即可开始写作。

### 命令行测试

```bash
# 验证写作流水线（需要配置 LLM）
node --input-type=module -e "
import { PipelineRunner, StateManager, createLLMClient, loadProjectConfig } from './packages/core/dist/index.js';
const config = await loadProjectConfig('.');
const state = new StateManager('.');
const book = await state.loadBookConfig('your-book-id');
const pipeline = new PipelineRunner({
  client: createLLMClient(config.llm),
  model: config.llm.model,
  projectRoot: '.',
  defaultLLMConfig: config.llm,
});
const result = await pipeline.writeNextChapter('your-book-id', 3000);
console.log(result);
"
```

## 项目结构

```
packages/
  core/      # @inkrhyme/core — 写作引擎（纯逻辑，无 UI）
    src/
      models/          # 领域模型（Book, Chapter, State 等）
      agents/          # 写作 Agent（planner, composer, writer, settler, auditor, reviser）
      pipeline/        # 流水线编排
        runner.ts              # 主编排器
        pipeline-helpers.ts    # 持久化辅助（从 runner 拆分）
        artifact-builder.ts    # 规划+上下文组装（从 runner 拆分）
        importer.ts            # 章节导入（从 runner 拆分）
      llm/             # LLM 抽象层（单点 seam，绑定 pi-ai）
      state/           # 文件 I/O + 运行时状态 + SQLite 索引层
        index-db.ts            # InkRhyme 新增的 UI 查询索引
      agent/           # 对话式 agent 表层（pi-agent-core）
      materials/       # 写作素材 RAG
      genres/          # 题材画像
      utils/           # 写作支撑工具集
  desktop/   # @inkrhyme/desktop — Electron 桌面应用
    src/
      main/            # Electron 主进程 + IPC
      preload/         # 上下文桥
      renderer/        # React 前端（Vite）
      shared/          # 主进程↔渲染进程共享类型
  cli/       # @actalk/inkos — 原始 CLI（保留参考，将被移除）
  studio/    # @actalk/inkos-studio — 原始 Web 工作台（保留参考，将被移除）
```

## 性能优化

InkRhyme 相对 InkOS 的性能改进：

| 优化项 | 效果 |
|--------|------|
| 锁释放 fire-and-forget | 每章省 2 秒 |
| State Validator 本地规则快路径 | 每章省 1 次 LLM 调用 |
| 审计阶段共享上下文缓存 | 每章省 10-12 次重复磁盘读取 |
| runner.ts 模块拆分 | 3937→3346 行（-15%），3 个模块提取 |

## 致谢

InkRhyme 基于 [InkOS](https://github.com/Narcooo/inkos)（AGPL-3.0）构建，感谢原作者的贡献。

## 许可证

[AGPL-3.0](LICENSE)
