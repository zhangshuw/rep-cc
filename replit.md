# Free AI API Proxy (free-sclaude)

## Overview

A free AI reverse proxy that exposes both OpenAI and Anthropic API formats, backed by Replit AI Integrations. No personal API keys needed — usage is billed to your Replit credits. Protect your proxy with a `PROXY_API_KEY` secret.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **AI**: Replit AI Integrations (OpenAI + Anthropic, no personal keys needed)

## Artifacts

- **api-portal** (previewPath: `/`) — React + Vite frontend portal showing connection details, endpoints, models, and setup guide
- **api-server** (previewPath: `/api`, `/v1`) — Express 5 backend serving both the REST API and the AI proxy routes

## Proxy Endpoints

All proxy endpoints are under `/v1/` and require `Authorization: Bearer <PROXY_API_KEY>` or `x-api-key` header.

- `GET /v1/models` — list all available models (OpenAI + Anthropic)
- `POST /v1/chat/completions` — OpenAI-compatible endpoint, supports all models (streaming + tool calls)
- `POST /v1/messages` — Anthropic Messages API native format, supports all models (streaming + tool calls)

## Supported Models

**OpenAI:** `gpt-5.2`, `gpt-5-mini`, `gpt-5-nano`, `o4-mini`, `o3`
**Anthropic:** `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`

## Secrets / Environment Variables

- `PROXY_API_KEY` — Required. A secret key clients must send to authenticate with the proxy.
- `AI_INTEGRATIONS_OPENAI_BASE_URL` / `AI_INTEGRATIONS_OPENAI_API_KEY` — Auto-configured by Replit AI Integrations.
- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` / `AI_INTEGRATIONS_ANTHROPIC_API_KEY` — Auto-configured by Replit AI Integrations.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## CherryStudio Setup

1. Settings → Model Providers → add new provider
2. Select "OpenAI" for `/v1/chat/completions` or "Anthropic" for `/v1/messages`
3. Set Base URL to your deployment domain and API Key to your `PROXY_API_KEY`
4. Pick any model and start chatting

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
