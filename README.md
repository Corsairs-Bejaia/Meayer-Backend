# Innobyte Trust — Backend API

Medical credential verification platform for Algeria. A multi-tenant SaaS that allows healthcare organisations (hospitals, clinics, health-tech platforms) to verify doctor credentials programmatically against national Algerian documentation standards.

**Stack**: NestJS 11 · Prisma 7 · PostgreSQL (Neon) · Redis (BullMQ + SSE) · Cloudflare R2

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Project Structure](#project-structure)
3. [Database Schema](#database-schema)
4. [API Reference](#api-reference)
5. [Authentication & Authorization](#authentication--authorization)
6. [Verification Pipeline](#verification-pipeline)
7. [Environment Variables](#environment-variables)
8. [Getting Started](#getting-started)
9. [Development Scripts](#development-scripts)
10. [Configuration](#configuration)
11. [Security](#security)
12. [Deployment](#deployment)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      NestJS API  :8000                      │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │   Auth   │  │  Doctors │  │  Verify  │  │ Dashboard │  │
│  │  Module  │  │  Module  │  │  Module  │  │  Module   │  │
│  └──────────┘  └──────────┘  └────┬─────┘  └───────────┘  │
│                                   │                         │
│  ┌────────────────────────────────▼────────────────────┐   │
│  │                  Shared Layer (@Global)              │   │
│  │   PrismaModule · StorageModule · CacheModule        │   │
│  └──────────────────┬───────────────┬──────────────────┘   │
└─────────────────────┼───────────────┼──────────────────────┘
                      │               │
          ┌───────────▼──┐   ┌────────▼────────┐
          │  Neon / PG   │   │  Redis Cloud    │
          │  (Prisma 7)  │   │  BullMQ + SSE   │
          └──────────────┘   └─────────────────┘
```

### Key Architectural Decisions

| Concern | Choice | Rationale |
|---------|--------|-----------|
| ORM | Prisma 7 (WASM client) | Type-safe queries, Neon-compatible via `@prisma/adapter-pg` |
| Queue | BullMQ over Redis | Durable job processing, retry logic, step-level persistence |
| Real-time | SSE over WebSockets | One-directional verification updates; simpler infra |
| Storage | Cloudflare R2 | S3-compatible, no egress fees, presigned URL support |
| Auth | JWT (access + refresh) + API Key | Dashboard users use JWT; API integrators use API keys |
| Multi-tenancy | Tenant ID on every row | Row-level isolation; single-schema, single-database |

---

## Project Structure

```
backend/
├── prisma/
│   ├── schema.prisma           # Database schema (11 models)
│   ├── seed.ts                 # System document template seeder
│   └── migrations/             # Applied migration history
├── prisma.config.ts            # Prisma CLI datasource config
├── src/
│   ├── main.ts                 # Bootstrap: Helmet, CORS, Swagger, ValidationPipe
│   ├── app.module.ts           # Root module — imports all feature modules
│   │
│   ├── config/                 # @nestjs/config typed configuration
│   │   ├── app.config.ts       # PORT, NODE_ENV, FRONTEND_URL
│   │   ├── database.config.ts  # DATABASE_URL
│   │   ├── redis.config.ts     # REDIS_URL
│   │   ├── jwt.config.ts       # JWT_SECRET, JWT_EXPIRY, JWT_REFRESH_EXPIRY
│   │   ├── storage.config.ts   # R2 credentials and bucket
│   │   └── services.config.ts  # AI_SERVICE_URL, SCRAPING_SERVICE_URL, INTERNAL_API_KEY
│   │
│   ├── core/                   # Cross-cutting concerns — no business logic
│   │   ├── decorators/
│   │   │   ├── current-user.decorator.ts   # @CurrentUser() — extracts JWT payload
│   │   │   ├── public.decorator.ts         # @Public() — bypasses JwtAuthGuard
│   │   │   └── require-permission.decorator.ts  # @RequirePermission('verifications:write')
│   │   ├── filters/
│   │   │   ├── http-exception.filter.ts    # Standardised error envelope
│   │   │   └── prisma-exception.filter.ts  # P2002 → 409, P2025 → 404, etc.
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts           # Global guard (APP_GUARD)
│   │   │   ├── api-key.guard.ts            # x-api-key header guard
│   │   │   └── internal-key.guard.ts       # Service-to-service guard
│   │   ├── interceptors/
│   │   │   ├── response-transform.interceptor.ts  # { success, data, meta }
│   │   │   └── logging.interceptor.ts             # Request/response logging
│   │   └── utils/
│   │       ├── hash.util.ts        # bcrypt helpers
│   │       ├── crypto.util.ts      # API key generation (uuid + prefix)
│   │       └── pagination.util.ts  # Cursor/offset pagination helpers
│   │
│   ├── shared/                 # @Global() injectable services
│   │   ├── prisma/
│   │   │   ├── prisma.service.ts   # PrismaClient with @prisma/adapter-pg
│   │   │   └── prisma.module.ts
│   │   ├── storage/
│   │   │   ├── storage.service.ts  # R2 upload, presigned URL generation
│   │   │   └── storage.module.ts
│   │   └── cache/
│   │       ├── cache.service.ts    # ioredis publisher + subscriber
│   │       └── cache.module.ts
│   │
│   └── modules/                # Feature modules
│       ├── auth/               # Register, login, refresh, /me
│       ├── api-keys/           # CRUD for tenant API keys
│       ├── users/              # User profile management
│       ├── templates/          # Document template CRUD + field management
│       ├── documents/          # File upload (magic-byte validated) + presigned URLs
│       ├── verifications/      # Verification lifecycle + SSE stream
│       ├── dashboard/          # Stats, activity feed, chart data
│       └── doctors/            # Doctor CRUD, search, NIN uniqueness
└── test/                       # Jest unit + e2e test scaffolding
```

---

## Database Schema

11 models across a single PostgreSQL schema. All primary keys are CUID strings. All timestamps are UTC.

```
users
 ├── api_keys          (1:N)
 ├── doctors           (1:N) — NIN unique per tenant
 ├── verifications     (1:N)
 │    ├── verification_steps  (1:N)
 │    ├── documents           (1:N)
 │    ├── audit_logs          (1:N)
 │    └── webhook_deliveries  (1:N)
 ├── tenant_configs    (1:1)
 └── webhook_deliveries (1:N)

document_templates
 ├── document_template_fields  (1:N)
 └── documents                 (1:N — template used for a document)
```

### Model Summary

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `User` | `email`, `companyName`, `planTier` | Tenant root entity |
| `ApiKey` | `keyHash`, `keyPrefix`, `permissions[]`, `rateLimit` | Keys are hashed (SHA-256); only prefix stored in plain text |
| `Doctor` | `nationalIdNumber`, `fullNameFr`, `fullNameAr`, `status` | NIN unique per tenant |
| `Verification` | `status`, `score`, `decision`, `workflowConfigJson` | Statuses: `pending`, `processing`, `approved`, `rejected`, `manual_review` |
| `VerificationStep` | `stepType`, `status`, `resultJson`, `confidence` | One row per pipeline step |
| `DocumentTemplate` | `slug`, `docType`, `isSystem`, `fieldsSchemaJson` | 6 system templates seeded |
| `DocumentTemplateField` | `fieldName`, `fieldLabelFr`, `fieldLabelAr`, `fieldType` | Bilingual field labels |
| `Document` | `docType`, `filePath`, `ocrResultJson`, `authenticityScore` | `filePath` is the R2 object key |
| `AuditLog` | `action`, `actor`, `detailsJson`, `timestamp` | Immutable; one per lifecycle event |
| `WebhookDelivery` | `url`, `payload`, `status`, `attempts`, `responseCode` | Retry-capable delivery log |
| `TenantConfig` | `autoApproveThreshold`, `manualReviewThreshold`, `webhookUrl` | Per-tenant workflow tuning |

### System Document Templates (seeded)

| Slug | Name (FR) | Fields |
|------|-----------|--------|
| `national_id` | Carte Nationale d'Identité | 8 |
| `medical_diploma` | Diplôme de Docteur en Médecine | 10 |
| `cnas_affiliation` | Attestation d'affiliation CNAS | 8 |
| `work_agreement` | Convention / Contrat de travail | 9 |
| `chifa_card` | Carte Chifa | 5 |
| `medical_authorization` | Ordonnance médicale / Autorisation d'exercer | 7 |

---

## API Reference

### Base URL
```
http://localhost:8000/api
```

Interactive Swagger docs are available at `http://localhost:8000/api/docs` in non-production environments.

### Response Envelope

All responses are wrapped by the global `ResponseTransformInterceptor`:

```json
{
  "success": true,
  "data": { },
  "meta": {
    "timestamp": "2026-05-02T12:00:00.000Z"
  }
}
```

Paginated responses include:
```json
{
  "success": true,
  "data": [],
  "meta": {
    "total": 42,
    "page": 1,
    "limit": 20,
    "totalPages": 3
  }
}
```

Error responses:
```json
{
  "success": false,
  "error": {
    "code": "CONFLICT",
    "message": "Email already in use"
  },
  "meta": {
    "timestamp": "2026-05-02T12:00:00.000Z"
  }
}
```

---

### Auth — `/api/auth`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/register` | Public | Register a new tenant account |
| `POST` | `/auth/login` | Public | Login, returns access + refresh tokens |
| `POST` | `/auth/refresh` | Public | Exchange refresh token for new access token |
| `GET` | `/auth/me` | JWT | Returns the current user profile |

**Register body:**
```json
{
  "email": "admin@clinic.dz",
  "password": "min8chars",
  "companyName": "Clinique El Shifa"
}
```

**Login response:**
```json
{
  "accessToken": "eyJ...",
  "refreshToken": "eyJ...",
  "user": { "id": "...", "email": "...", "companyName": "..." }
}
```

---

### API Keys — `JWT /api/api-keys`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api-keys` | Create a new API key (key returned once in plain text) |
| `GET` | `/api-keys` | List all active keys for the current tenant |
| `DELETE` | `/api-keys/:id` | Revoke a key |

**Create body:**
```json
{
  "name": "Production Integration",
  "permissions": ["verifications:read", "verifications:write"],
  "rateLimit": 500
}
```

---

### Doctors — `JWT /api/doctors`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/doctors` | Register a new doctor under the tenant |
| `GET` | `/doctors` | List with search + status filter + pagination |
| `GET` | `/doctors/:id` | Doctor detail with last 10 verifications |
| `PUT` | `/doctors/:id` | Update doctor profile |
| `DELETE` | `/doctors/:id` | Remove a doctor |

**Query params for `GET /doctors`:**

| Param | Type | Description |
|-------|------|-------------|
| `search` | string | Case-insensitive match on name (FR/AR) or NIN |
| `status` | string | Filter by `pending`, `approved`, `rejected` |
| `page` | number | Default: 1 |
| `limit` | number | Default: 20, max: 100 |

---

### Verifications — `JWT /api/verifications`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/verifications` | JWT | Create and enqueue a verification job |
| `GET` | `/verifications` | JWT | List verifications with status filter + pagination |
| `GET` | `/verifications/:id` | JWT | Full verification detail with steps and documents |
| `GET` | `/verifications/:id/stream` | Public | SSE stream for real-time step updates |

**Create body:**
```json
{
  "doctorId": "clxxxx",
  "workflowConfig": {
    "steps": ["ai_extraction", "cnas_check"]
  }
}
```

**SSE Stream** — `GET /verifications/:id/stream`

Emits `text/event-stream` events as each pipeline step completes. No authentication required (the verification ID acts as an unguessable token). Heartbeat sent every 25 seconds to keep connections alive.

```
data: {"step":"ai_extraction","status":"completed","confidence":0.94}

data: {"step":"cnas_check","status":"completed","result":{"status":"skipped"}}

data: {"event":"completed","score":0.94,"decision":"approved"}
```

---

### Documents — `JWT /api/documents`

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/documents/upload` | Upload a document file (`multipart/form-data`) |
| `GET` | `/documents/verification/:verificationId` | List documents for a verification |
| `GET` | `/documents/:id/url` | Get a presigned R2 download URL (15 min expiry) |

**Upload constraints:**
- Accepted MIME types: `image/jpeg`, `image/png`, `application/pdf`
- Validated by magic bytes (not just the `Content-Type` header)
- Maximum file size: 20 MB
- Files stored at `{tenantId}/{verificationId}/{docType}/{uuid}.{ext}` in R2

---

### Templates — `JWT /api/templates`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/templates` | List all templates (system + tenant-owned) |
| `GET` | `/templates/:id` | Template detail with all fields |
| `POST` | `/templates` | Create a custom template |
| `PUT` | `/templates/:id` | Update a custom template |
| `DELETE` | `/templates/:id` | Delete a custom template (own only) |
| `POST` | `/templates/:id/fields` | Add a field to a template |
| `PUT` | `/templates/:id/fields/:fieldId` | Update a field |
| `DELETE` | `/templates/:id/fields/:fieldId` | Remove a field |
| `POST` | `/templates/:id/field-positions` | Save visual field position map |
| `POST` | `/templates/:id/sample-image` | Upload a sample document image |

---

### Dashboard — `JWT /api/dashboard`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/dashboard/stats` | KPI counts: doctors, verifications by status, API keys, MoM growth |
| `GET` | `/dashboard/activity` | Paginated audit log for the tenant |
| `GET` | `/dashboard/chart` | Daily verification volume by decision (last N days) |

---

## Authentication & Authorization

### JWT Flow

```
POST /auth/login
  → { accessToken (15m), refreshToken (7d) }

All protected requests:
  Authorization: Bearer <accessToken>

Token expiry:
  POST /auth/refresh  { refreshToken }
  → { accessToken, refreshToken }
```

### API Key Auth

For programmatic/integration access. Pass in the request header:
```
x-api-key: it_live_xxxxxxxxxxxxxxxxxxxxxxxx
```

API keys have per-key permission scopes and rate limits stored in the database. The raw key is only returned once at creation time. The stored value is a SHA-256 hash.

### Guard Hierarchy

| Guard | Applied | Bypassed by |
|-------|---------|-------------|
| `JwtAuthGuard` | Global (`APP_GUARD`) | `@Public()` decorator |
| `ApiKeyGuard` | Applied manually on API-facing controllers | — |
| `InternalKeyGuard` | Applied on service-to-service endpoints | — |

### Permission Scopes

```
verifications:read
verifications:write
documents:read
documents:write
templates:read
```

Enforced via `@RequirePermission('verifications:write')` on controller methods.

---

## Verification Pipeline

### Job Flow

```
POST /verifications
  └─ Creates Verification record (status: pending)
  └─ Enqueues BullMQ job on queue: "verifications"

BullMQ Worker (VerificationProcessor)
  │
  ├─ Step 1: ai_extraction
  │    Calls AI microservice → stores extracted fields + confidence
  │    (TODO: wire AiClientService.runPipeline())
  │
  ├─ Step 2: cnas_check
  │    Calls scraping microservice → stores CNAS affiliation status
  │    (TODO: wire ScrapingClientService.verifyCnas())
  │
  ├─ Scoring
  │    score = ai_extraction.confidence
  │    decision:
  │      score ≥ autoApproveThreshold   → "approved"
  │      score ≥ manualReviewThreshold  → "manual_review"
  │      otherwise                      → "rejected"
  │
  └─ Completion
       Updates Verification (status, score, decision, completedAt)
       Creates AuditLog entry
       Publishes to Redis channel "verification:{id}"
       → SSE subscribers receive the update immediately
```

### Verification Statuses

| Status | Meaning |
|--------|---------|
| `pending` | Created, not yet picked up by the worker |
| `processing` | Worker is actively running steps |
| `approved` | Score ≥ auto-approve threshold |
| `manual_review` | Score between thresholds — requires human review |
| `rejected` | Score below manual-review threshold |

### Default Thresholds (configurable per tenant in `TenantConfig`)

| Threshold | Default |
|-----------|---------|
| Auto-approve | 85 |
| Manual review | 60 |

---

## Environment Variables

Copy `.env.example` to `.env` and fill in all values before starting the server.

```bash
cp .env.example .env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: `8000`) |
| `NODE_ENV` | Yes | `development` \| `production` \| `test` |
| `FRONTEND_URL` | Yes | Allowed CORS origin (exact URL, no trailing slash) |
| `DATABASE_URL` | Yes | PostgreSQL connection string — Neon format: `postgresql://user:pass@ep-xxx.neon.tech/db?sslmode=require` |
| `REDIS_URL` | Yes | Redis connection string — `redis://default:pass@host:port` |
| `JWT_SECRET` | Yes | Min 64 random characters — generate with `openssl rand -hex 32` |
| `JWT_EXPIRY` | No | Access token TTL (default: `15m`) |
| `JWT_REFRESH_EXPIRY` | No | Refresh token TTL (default: `7d`) |
| `R2_ACCOUNT_ID` | Yes | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | Yes | R2 API token key ID |
| `R2_SECRET_ACCESS_KEY` | Yes | R2 API token secret |
| `R2_BUCKET` | Yes | R2 bucket name |
| `R2_PUBLIC_URL` | No | Public R2 URL (if the bucket has public access enabled) |
| `AI_SERVICE_URL` | No | AI microservice base URL (default: `http://localhost:8001`) |
| `SCRAPING_SERVICE_URL` | No | CNAS scraping microservice base URL (default: `http://localhost:8002`) |
| `INTERNAL_API_KEY` | Yes | Shared secret for service-to-service calls — generate with `openssl rand -hex 32` |
| `SUMSUB_APP_TOKEN` | No | Sumsub KYC app token (reserved, not yet active) |
| `SUMSUB_SECRET_KEY` | No | Sumsub KYC secret (reserved, not yet active) |

> **Security**: Never commit `.env` to version control. Use a secrets manager (Doppler, HashiCorp Vault, or platform-native env injection) in production.

---

## Getting Started

### Prerequisites

| Tool | Minimum Version |
|------|----------------|
| Node.js | 22 |
| npm | 10 |
| PostgreSQL | Neon (serverless) or local ≥ 15 |
| Redis | Redis Cloud or local ≥ 7 |

### Installation

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in DATABASE_URL, REDIS_URL, and JWT_SECRET at minimum

# 3. Generate Prisma client
npx prisma generate

# 4. Apply database migrations
npx prisma migrate deploy

# 5. Seed system document templates
npm run db:seed

# 6. Start development server
npm run start:dev
```

The API will be available at `http://localhost:8000/api`.  
Swagger UI: `http://localhost:8000/api/docs`

### First API Request

```bash
# Register a tenant
curl -s -X POST http://localhost:8000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@clinic.dz","password":"password123","companyName":"Clinique Test"}'

# Login and capture the access token
TOKEN=$(curl -s -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@clinic.dz","password":"password123"}' \
  | jq -r '.data.accessToken')

# Hit a protected endpoint
curl -s http://localhost:8000/api/auth/me \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

## Development Scripts

| Script | Description |
|--------|-------------|
| `npm run start:dev` | Start with file-watcher (TypeScript watch + hot reload) |
| `npm run start:debug` | Start with Node.js inspector attached |
| `npm run start:prod` | Run compiled output from `dist/src/main.js` |
| `npm run build` | Compile TypeScript via `nest build` → `dist/` |
| `npm run lint` | Run ESLint with auto-fix across `src/` |
| `npm run format` | Run Prettier on all TypeScript source files |
| `npm run db:seed` | Run `prisma/seed.ts` to insert the 6 system document templates |
| `npm test` | Run Jest unit tests |
| `npm run test:watch` | Jest in watch mode |
| `npm run test:cov` | Jest with HTML coverage report |
| `npm run test:e2e` | Run end-to-end tests |

### Prisma CLI Reference

```bash
# Create and apply a new migration (development only)
npx prisma migrate dev --name <migration_name>

# Apply pending migrations to the database (CI / production)
npx prisma migrate deploy

# Open Prisma Studio (browser-based database GUI)
npx prisma studio

# Regenerate Prisma client after schema changes
npx prisma generate

# Reset database and rerun all migrations (destructive — development only)
npx prisma migrate reset
```

---

## Configuration

All environment variables are loaded by `@nestjs/config` through typed, namespaced configuration factories in `src/config/`. Each file exports a `registerAs()` function that maps environment variables to a validated, typed object.

```typescript
// Injecting config in a service
constructor(private readonly config: ConfigService) {}

const port = this.config.get<number>('app.port');       // app.config.ts
const jwtSecret = this.config.get<string>('jwt.secret'); // jwt.config.ts
```

### TypeScript Path Aliases

| Alias | Resolves to |
|-------|-------------|
| `@core/*` | `src/core/*` |
| `@config/*` | `src/config/*` |
| `@shared/*` | `src/shared/*` |
| `@modules/*` | `src/modules/*` |

Aliases are registered in both `tsconfig.json` (for compilation) and via `tsconfig-paths` (for `ts-node` runtime resolution).

---

## Security

| Layer | Mechanism |
|-------|-----------|
| **HTTP headers** | `helmet` sets CSP, HSTS, X-Frame-Options, and more |
| **CORS** | Restricted to the exact `FRONTEND_URL` origin |
| **Input validation** | `class-validator` + `ValidationPipe(whitelist: true)` — unknown fields are stripped, not passed through |
| **Authentication** | JWT HS256 with short-lived access tokens (15 min default) |
| **Password storage** | `bcrypt` with cost factor 10 |
| **API key storage** | SHA-256 hash stored; only the short prefix is stored in plain text for display |
| **File validation** | Magic-byte inspection of the first 4 bytes (JPEG `FFD8FF`, PNG `89504E47`, PDF `25504446`) — Content-Type header alone is not trusted |
| **File size** | 20 MB hard limit enforced in Multer configuration |
| **Rate limiting** | `@nestjs/throttler` global limiter; per-key rate limits enforced in `ApiKeyGuard` |
| **Tenant isolation** | Every service-layer query is explicitly scoped by `tenantId` — no cross-tenant data access is possible through the API |
| **Error sanitisation** | `PrismaExceptionFilter` maps DB-level errors to safe HTTP status codes without leaking internal messages |

### Prisma Exception Mapping

| Prisma Code | HTTP Status | Cause |
|-------------|-------------|-------|
| `P2002` | `409 Conflict` | Unique constraint violation |
| `P2025` | `404 Not Found` | Record not found |
| `P2003` | `400 Bad Request` | Foreign key constraint failure |
| `P2016` | `400 Bad Request` | Query interpretation error |

---

## Deployment

### Build for Production

```bash
npm run build
# Output: dist/src/main.js

NODE_ENV=production node dist/src/main.js
```

### Production Readiness Checklist

- [ ] `NODE_ENV=production` is set — disables Swagger UI and enables production error handling
- [ ] `JWT_SECRET` is at least 64 random characters (`openssl rand -hex 32`)
- [ ] `INTERNAL_API_KEY` is at least 64 random characters, shared with AI and scraping services
- [ ] `DATABASE_URL` points to a production-isolated Neon project or branch
- [ ] Redis `maxmemory-policy` is set to `noeviction` (required by BullMQ)
- [ ] R2 bucket CORS policy allows only the production `FRONTEND_URL`
- [ ] Migrations applied via `npx prisma migrate deploy` — never `migrate dev` in production
- [ ] `db:seed` has been run exactly once on the production database

### Docker Example

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
ENV NODE_ENV=production
EXPOSE 8000
CMD ["node", "dist/src/main.js"]
```

---

## Deferred Modules

The following modules are scaffolded in `app.module.ts` (commented out) pending their upstream service dependencies:

| Module | Dependency | Status |
|--------|-----------|--------|
| `WebhooksModule` | Svix webhook delivery service | Pending Svix integration |
| `AiClientModule` | AI microservice at `AI_SERVICE_URL` | Stubs in `verification.processor.ts` |
| `ScrapingClientModule` | CNAS scraping service at `SCRAPING_SERVICE_URL` | Stubs in `verification.processor.ts` |

The `VerificationProcessor` already contains clearly marked `// TODO` comments at both call sites. Activating these modules requires only uncommenting the imports in `app.module.ts` and injecting the respective services into the processor.

---

## License

Private — all rights reserved. Innobyte, Algeria.
