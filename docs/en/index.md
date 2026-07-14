---
layout: home

hero:
  name: Rejelly
  text: Agent Framework
  tagline: A React-inspired Agent framework where Agents are functions with Hooks for building LLM applications
  actions:
    - theme: brand
      text: Get Started
      link: /en/guide/
    - theme: alt
      text: API Docs
      link: /en/api

features:
  - title: Agent as a Function
    details: createAgent wraps an async function receiving props — input goes in, result comes out
  - title: Prompt Building with Hooks
    details: equip family (system / instruction / tool / memory) aggregates in place, no more string concatenation or explicit ctx
  - title: Contract-Driven Output
    details: promptAgent with Zod Schema defines and validates LLM output structure
  - title: reborn Rebuilds Context
    details: Instead of appending history across rounds, each round re-renders the Prompt with fresh Memory — goal-oriented.

---