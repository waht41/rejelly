---
layout: home

hero:
  name: Rejelly
  text: Agent Framework
  tagline: 受 React 启发的 Agent 框架:Agent 即函数,用 Hooks 构建 LLM 应用
  actions:
    - theme: brand
      text: 开始使用
      link: /zh/guide/
    - theme: alt
      text: API 文档
      link: /zh/api

features:
  - title: Agent 即函数
    details: createAgent 包一个接收 props 的异步函数，输入进、结果出
  - title: Hook 式构建 Prompt
    details: equip 系列（system / instruction / tool / memory）就地聚合，告别字符串拼接与显式 ctx
  - title: 契约式输出
    details: promptAgent 配合 Zod Schema 定义并校验 LLM 的输出结构
  - title: reborn 重建上下文
    details: 跨轮次不追加历史，每轮用最新 Memory 重新渲染 Prompt——面向目标

---
