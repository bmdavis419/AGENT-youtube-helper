# AGENT-youtube-helper - Agentuity AI Agent Project

## Build/Lint/Test Commands
- `bun run build` - Build the project using Agentuity
- `bun run dev` - Start development server with hot reload
- `agentuity dev` - Run in development mode with Agentuity Console
- `bun run format` - Format code using Biome
- `bun run lint` - Lint code using Biome
- `agentuity deploy` - Deploy to Agentuity Cloud
- No test scripts defined currently

## Architecture
- Agentuity AI agent project using Bun runtime
- Entry point: `index.ts` (Agentuity SDK runner)
- Agents located in `src/agents/` directory
- Current agents: `comments-watcher`, `health-demo`
- Uses Google APIs, OpenAI AI SDK, and Zod for validation
- Bundled output in `.agentuity/` directory

## Code Style & Conventions
- TypeScript with strict mode enabled
- Biome formatter: 2 spaces, single quotes, trailing commas (ES5), semicolons
- Import organization enabled
- Use `@agentuity/sdk` types: `AgentRequest`, `AgentResponse`, `AgentContext`
- Agents export default async function named `Agent`
- Use `ctx.logger.info()` for logging
- ESNext modules with bundler resolution
