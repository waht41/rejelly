# Create Rejelly: One-Command Scaffolding

## What It Is

`create-rejelly` is the official Rejelly scaffolding tool, generating a runnable Rejelly project in seconds. The generated project is based on built-in templates and automatically injects the corresponding source code and configuration based on your chosen model adapter.

## Usage

Run the following in the directory where you want to create the project:

```bash
pnpm create rejelly
# or
npx create-rejelly
```

Follow the prompts:

1. **Project name**: Directory name for the project, defaults to `rejelly-app`
2. **Which template would you like?**: Project template
   - **Basic (chat)**: Basic chat template, great for getting started quickly
   - **Router**: Router pattern template, suitable for multi-sub-agent dispatching
3. **Which model adapter would you like to start with?**: Preferred model adapter
   - **OpenAI (GPT)**: Uses OpenAI API (including compatible endpoints)
   - **Gemini (Google)**: Uses Google Gemini API

If the directory already exists, the CLI reports an error and exits; choose a different name and run it again. Canceling the interactive prompt also exits.

## Post-Generation Steps

```bash
cd <project-name>
pnpm install
```

Edit the **.env** file in the project root, filling in the required environment variables for your chosen adapter:

| Adapter | Required | Optional |
|---------|----------|----------|
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL_ID` (default per template), `OPENAI_BASE_URL` |
| Gemini  | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `GEMINI_MODEL_ID` (default per template) |

Then start:

```bash
pnpm start
```

## Extending Later

- To switch or add model adapters, simply install the corresponding package, e.g.: `pnpm add @rejelly/adapter-openai`, `pnpm add @rejelly/adapter-mcp`.
- For more APIs and usage, see the [API docs](/en/api/) and [Introduction](/en/guide/).
