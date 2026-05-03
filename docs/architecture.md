# System Architecture

The Meayar backend is a **modular NestJS monolith** with clear boundaries between public API surfaces, internal pipeline processing, and shared infrastructure.

## High-Level Workflow

1. **Session creation**: Tenant calls `POST /verifications` with doctor info → backend generates a session token and returns a `portalUrl`.
2. **Document upload**: Doctor is redirected to the portal, uploads documents via `POST /portal/documents/upload` using a `X-Session-Token` header.
3. **Pipeline enqueue**: Doctor submits via `POST /portal/submit` → verification moves `pending → queued` → BullMQ job enqueued.
4. **AI processing**: `VerificationProcessor` picks up the job, calls the AI microservice, maps the result to a score + decision.
5. **Result delivery**: Webhook fires via Svix. Portal SSE stream receives the `completed` event. Signed redirect URL is attached to the session.

## Module Map

```
NestJS API (:8000)
│
├── Public surfaces
│   ├── AuthModule          — register, login, refresh, /me
│   ├── PortalModule        — session token–authenticated portal endpoints
│   └── (Swagger /api/docs, /api/docs/json)
│
├── Developer API (JWT + API Key via FlexAuthGuard)
│   ├── VerificationsModule — create sessions, list, get, SSE stream
│   ├── WebhooksModule      — endpoint CRUD, secret management
│   └── ApiKeysModule       — key generation and revocation
│
├── Dashboard (JWT only)
│   ├── DashboardModule     — stats, activity feed, chart data
│   ├── DoctorsModule       — doctor CRUD and search
│   ├── DocumentsModule     — document management
│   ├── ReportsModule       — review queue, decisions, comments
│   ├── TemplatesModule     — document template CRUD
│   └── UsersModule         — profile management
│
├── Async pipeline
│   └── VerificationProcessor (BullMQ worker)
│       └── AiClientModule  — HTTP client to AI microservice
│
└── Shared (@Global)
    ├── PrismaModule        — Prisma 7 client with @prisma/adapter-pg
    ├── StorageModule       — Cloudflare R2 upload + presigned URLs
    └── CacheModule         — ioredis publish/subscribe for SSE
```

## Key Architectural Decisions

| Concern | Choice | Rationale |
|---|---|---|
| ORM | Prisma 7 | Type-safe queries, WASM client for Neon pooler compatibility |
| Queue | BullMQ + Redis | Durable job processing, automatic retries, step-level persistence |
| Real-time | SSE via Redis pub/sub | One-directional updates; no WebSocket infra needed |
| Storage | Cloudflare R2 | S3-compatible, no egress fees, presigned URL support for AI service |
| Auth | JWT + API Key + Session Token | Three separate surfaces, each appropriate to its consumer |
| Multi-tenancy | `tenantId` on every row | Row-level isolation in a single schema |
| Webhook delivery | Svix | Managed retries, signing, delivery dashboard |

## Infrastructure

```
┌──────────────────────────────────────────────────────────┐
│                    NestJS API :8000                       │
└────────────────────┬──────────────────┬──────────────────┘
                     │                  │
          ┌──────────▼──────┐  ┌────────▼──────────┐
          │  Neon (Postgres) │  │  Redis Cloud       │
          │  Prisma 7        │  │  BullMQ + SSE      │
          └──────────────────┘  └────────────────────┘
                     │
          ┌──────────▼──────┐
          │  Cloudflare R2   │
          │  Document files  │
          └──────────────────┘
                     │
          ┌──────────▼──────┐
          │  AI Microservice │
          │  (Railway)       │
          └──────────────────┘
                     │
          ┌──────────▼──────┐
          │  Svix            │
          │  Webhook delivery│
          └──────────────────┘
```
