# Create Rejelly：一键脚手架

## 是什么

`create-rejelly` 是 Rejelly 的官方脚手架，在几秒内生成一个可运行的 Rejelly 项目。生成的项目基于内置的模板，并会根据你选择的模型适配器自动注入对应源码与配置。

## 使用方式

在希望创建项目的目录下执行：

```bash
pnpm create rejelly
# 或
npx create-rejelly
```

按提示输入：

1. **Project name**：项目目录名，默认 `rejelly-app`
2. **Which template would you like?**：项目模板
   - **Basic (chat)**：基础对话模板，适合快速上手
   - **Router**：路由模式模板，适合多子 Agent 分发场景
3. **Which model adapter would you like to start with?**：首选模型适配器
   - **OpenAI (GPT)**：使用 OpenAI API（含兼容接口）
   - **Gemini (Google)**：使用 Google Gemini API

若目录已存在会提示错误并退出；请更换名称后重新执行。取消交互则退出。

## 生成后的步骤

```bash
cd <项目名>
pnpm install
```

编辑项目根目录下的 **.env**，填入你选择的适配器所需的环境变量：

| 适配器 | 必填 | 可选 |
|--------|------|------|
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL_ID`（默认见模板）、`OPENAI_BASE_URL` |
| Gemini  | `GEMINI_API_KEY`（或 `GOOGLE_API_KEY`） | `GEMINI_MODEL_ID`（默认见模板） |

然后启动：

```bash
pnpm start
```

## 后续扩展

- 需要更换或增加模型适配器时，直接安装对应包即可，例如：`pnpm add @rejelly/adapter-openai`、`pnpm add @rejelly/adapter-mcp`。
- 更多 API 与用法见 [API 文档](/zh/api/) 与 [介绍](/zh/guide/)。
