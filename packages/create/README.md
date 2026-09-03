# create-rejelly

> Scaffold a new Rejelly app in seconds.

## Usage

```bash
npm create rejelly@latest
```

For automation or other non-interactive environments, pass every required value:

```bash
npm create rejelly@latest my-app -- --template basic --adapter openai
```

Available templates are `basic` and `router`; adapters are `openai` and `gemini`. Use `--yes` to apply defaults (`rejelly-app`, `basic`, and `openai`) for values you omit:

```bash
npm create rejelly@latest my-app -- --yes
```

When stdin is non-interactive, incomplete arguments fail immediately instead of waiting for a prompt. Run `create-rejelly --help` for all options.

## AI guidance

Generated projects include both a root `AGENTS.md` and a portable `.agents/skills/rejelly` Skill. The Skill bundles a release-matched snapshot of the Rejelly documentation for progressive, offline reference by compatible coding agents.

## Documentation

Quick start: **https://docs.rejelly.dev/en/guide/create**

## License

Apache-2.0 © waht41
