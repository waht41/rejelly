# Coding Agent 模式

> 中文 | [English](README.md)

本示例演示一个**小而真实的 coding agent**：在沙箱工作区里 探索 → 编辑 → 运行 → 验证，由单次 `promptChat` 调用驱动。没有 plan/act 状态机——循环由框架提供，你真正需要定制的东西（工具、策略、提示词）都是这个目录里的普通代码。

## 运行

在 `examples` 根目录下：

```bash
pnpm run start -- --module=coding-agent --example=fix-bug
```

或从菜单中选择 **Coding Agent**，再选一个场景：

- `scaffold` —— 空工作区：写出 `fizzbuzz.js`，用 node 运行并确认输出正确。
- `fix-bug` —— 预置了一个失败测试的工作区：运行测试、定位 bug、用最小的 `edit_file` 修改修复、重跑直到通过。

每次运行都会创建一个全新的临时工作区（启动时打印路径），agent 永远碰不到你的真实文件。写入类工具会在终端里请求 **y/N** 确认——试着拒绝一次，观察 agent 读到拒绝结果后如何调整策略。

## 思路

三个部分，每个都刻意保持小：

1. **原生工具很便宜**（`tools.ts`）：coding 的五个原语——`list_files`、`read_file`、`write_file`、`edit_file`、`run_command`——就是普通的 `{ name, description, parameters, handler }` 对象，每个几十行，用一个普通的工厂闭包绑定到沙箱根目录。没有注册表，没有装饰器。

2. **策略是中间件，不是工具代码**（`approval.ts`）：一个日志中间件 + 一个人工审批门，按工具挂载。只读/写入的分界线就是肉眼可见的一行：

```typescript
for (const tool of createCodingTools(props.workspace)) {
  equipTool(tool, {
    middleware: MUTATING_TOOL_NAMES.has(tool.name)
      ? [consoleToolLogger, approvalGate] // 先记录，再过审批门
      : [consoleToolLogger],              // 只读工具自由放行
  });
}
```

拒绝时**返回**一个字符串而不是抛异常：拒绝变成一条模型能读到的普通工具结果，模型可以据此绕行，而不是让整次运行崩掉。

3. **循环是白送的**（`coding-agent.ts`）：装配好工具后，一次调用就跑完 模型决策 → 工具执行 → 结果回填 的完整循环，直到模型以纯文本作答，上限由 `maxTurnSteps` 约束：

```typescript
const { data: summary } = await promptChat({
  message: { role: "user", content: props.task },
});
```

系统提示词里只强调一个习惯——它是 coding agent 和"代码生成器"的分水岭：**改完代码必须运行验证**，没看到命令输出之前不许宣称成功。

## 说明

- **为什么用原生工具而不是 MCP？** 文件类工具完全可以换成官方的 `server-filesystem` MCP server（接入方式见 `01-basics/mcp-integration`）。这里选择原生实现，一是因为"定义工具有多轻"本身就是被演示的对象；二是 `run_command` 没有官方 MCP server，而它恰恰是审批门最需要出场的地方。
- **调试**：加 `--review` 运行并打开 devtool，agent 行为出乎意料时可以回放完整 trace——每一次工具调用、每一轮模型输出。
