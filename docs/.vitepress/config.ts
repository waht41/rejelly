import { join } from "node:path";
import { defineConfig } from "vitepress";
import { generateLlmTxt } from "./utils/generate-llm";

export default defineConfig({
  title: "Rejelly",
  description:
    "A React-inspired Agent framework where Agents are functions with Hooks for building LLM applications",

  // Browser-tab favicon (shares the Rejelly mark with the header logo, copied from devtool-ui)
  head: [["link", { rel: "icon", type: "image/svg+xml", href: "/logo.svg" }]],

  // Omit `.html` from URLs (dev + generated links); build emits `path/index.html`
  cleanUrls: true,

  // Emit sitemap.xml at build so search engines discover every page (absolute URLs)
  sitemap: {
    hostname: "https://docs.rejelly.dev",
  },

  // Work-in-progress notes: keep out of the built site (llm.txt exclusion lives in generate-llm.ts)
  srcExclude: ["draft/**"],

  buildEnd: async (siteConfig: any) => {
    // Generate llm.txt during build
    generateLlmTxt(siteConfig.srcDir, join(siteConfig.outDir, "llm.txt"));
  },

  themeConfig: {
    logo: "/logo.svg",

    sidebar: {
      "/en/guide/": [
        {
          text: "Getting Started",
          items: [
            { text: "Introduction", link: "/en/guide/" },
            { text: "Quick Start", link: "/en/guide/create" },
            { text: "Example Index", link: "/en/guide/example" },
          ],
        },
        {
          text: "Deep Dive",
          items: [
            { text: "Event System", link: "/en/guide/event" },
            { text: "DevTool", link: "/en/guide/devtool" },
          ],
        },
      ],
      "/en/api/": [
        {
          text: "Overview",
          items: [{ text: "Overview", link: "/en/api/" }],
        },
        {
          text: "Core Runtime",
          items: [
            { text: "Core", link: "/en/api/core" },
            { text: "Equip (Context & State)", link: "/en/api/equip" },
            { text: "Expect (Output & Validation)", link: "/en/api/expect" },
            { text: "Effect", link: "/en/api/effect" },
            { text: "Flow", link: "/en/api/flow" },
            { text: "Budget", link: "/en/api/budget" },
            { text: "Policy", link: "/en/api/policy" },
          ],
        },
        {
          text: "Adapter / Integration",
          items: [
            { text: "Adapter (Overview)", link: "/en/api/adapter/" },
            { text: "Model Adapter", link: "/en/api/adapter/model" },
            { text: "MCP", link: "/en/api/adapter/mcp" },
            { text: "LangChain", link: "/en/api/adapter/langchain" },
            { text: "Limit Model", link: "/en/api/limit-model" },
          ],
        },
        {
          text: "Debug & Replay",
          items: [
            { text: "Debug", link: "/en/api/debug" },
            { text: "Time Travel", link: "/en/api/time-travel" },
            { text: "Testing", link: "/en/api/testing" },
          ],
        },
      ],
      "/zh/guide/": [
        {
          text: "开始",
          items: [
            { text: "介绍", link: "/zh/guide/" },
            { text: "快速开始", link: "/zh/guide/create" },
            { text: "示例索引", link: "/zh/guide/example" },
          ],
        },
        {
          text: "深入",
          items: [
            { text: "事件系统", link: "/zh/guide/event" },
            { text: "DevTool 调试", link: "/zh/guide/devtool" },
          ],
        },
      ],
      "/zh/api/": [
        {
          text: "总览",
          items: [{ text: "概览", link: "/zh/api/" }],
        },
        {
          text: "基础运行时",
          items: [
            { text: "Core (核心定义)", link: "/zh/api/core" },
            { text: "Equip (上下文与状态)", link: "/zh/api/equip" },
            { text: "Expect (输出与验证)", link: "/zh/api/expect" },
            { text: "Effect (副作用)", link: "/zh/api/effect" },
            { text: "Flow (控制流)", link: "/zh/api/flow" },
            { text: "Budget 机制", link: "/zh/api/budget" },
            { text: "Policy", link: "/zh/api/policy" },
          ],
        },
        {
          text: "适配器 / 集成",
          items: [
            { text: "Adapter (总览)", link: "/zh/api/adapter/" },
            { text: "Model Adapter", link: "/zh/api/adapter/model" },
            { text: "MCP", link: "/zh/api/adapter/mcp" },
            { text: "LangChain", link: "/zh/api/adapter/langchain" },
            { text: "Limit Model (限流)", link: "/zh/api/limit-model" },
          ],
        },
        {
          text: "副作用、调试与回放",
          items: [
            { text: "Debug (调试)", link: "/zh/api/debug" },
            { text: "时间旅行", link: "/zh/api/time-travel" },
            { text: "Testing (测试工具)", link: "/zh/api/testing" },
          ],
        },
      ],
    },

    socialLinks: [{ icon: "github", link: "https://github.com/waht41/rejelly" }],

    footer: {
      message:
        'Released under the Apache License 2.0. <a href="/llm.txt" target="_blank" download="llm.txt" style="color: var(--vp-c-text-2); text-decoration: none; margin-left: 0.5rem;">llm.txt</a>',
      copyright: "Copyright © 2026 waht41",
    },

    search: {
      provider: "local",
    },
  },

  // Per-locale nav: /en/ pages show the English nav, /zh/ pages the Chinese one,
  // each with its own locale-prefixed `API` link. The shared themeConfig above
  // (sidebar/logo/footer/search) is merged in for both. VitePress also renders a
  // language-switch dropdown from these labels and maps the current path across locales.
  locales: {
    en: {
      label: "English",
      lang: "en-US",
      themeConfig: {
        nav: [
          { text: "Guide", link: "/en/guide/" },
          { text: "API", link: "/en/api/" },
        ],
      },
    },
    zh: {
      label: "简体中文",
      lang: "zh-CN",
      themeConfig: {
        nav: [
          { text: "指南", link: "/zh/guide/" },
          { text: "API", link: "/zh/api/" },
        ],
      },
    },
  },

  markdown: {
    lineNumbers: true,
  },
});
