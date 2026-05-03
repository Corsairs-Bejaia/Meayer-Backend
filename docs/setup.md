# Installation & Setup

This guide will help you get the Meayar backend running on your local machine.

## Prerequisites

- **Node.js 20+**
- **npm 10+**
- **PostgreSQL** — or a [Neon](https://neon.tech) serverless connection string
- **Redis** — local instance or [Upstash](https://upstash.com)
- **Cloudflare R2** bucket (or any S3-compatible storage)

## Local Development Setup

### 1. Clone and enter directory

```bash
git clone <repository-url>
cd backend
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Fill in all required values. At minimum you need:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (pooler URL for runtime) |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | At least 64 random characters |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | R2 API token key ID |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |
| `R2_BUCKET` | R2 bucket name |
| `PORTAL_BASE_URL` | URL of the portal frontend (default: `http://localhost:3001`) |
| `PORTAL_SIGNING_SECRET` | Secret for signing redirect URLs |
| `SVIX_API_KEY` | Svix API key for webhook delivery |
| `AI_SERVICE_URL` | URL of the AI microservice (default: `http://localhost:8001`) |
| `INTERNAL_API_KEY` | Shared secret for backend → AI service calls |

### 4. Generate Prisma client

```bash
npx prisma generate
```

### 5. Apply database migrations

For local development with a direct connection (not pooler):
```bash
npx prisma migrate dev
```

For production or pooled connections (no shadow DB needed):
```bash
npx prisma migrate deploy
```

> **Neon note**: `migrate dev` requires a direct (non-pooler) connection URL because it creates a shadow database. Set `DATABASE_URL` to the direct endpoint (`ep-xxx.c-5.us-east-1.aws.neon.tech`) when running `migrate dev`, then switch back to the pooler URL for runtime.

### 6. Seed system document templates

```bash
npm run db:seed
```

This creates the 6 built-in `DocumentTemplate` records (national ID, diploma, CNAS attestation, etc.) that the AI pipeline references.

### 7. Start the development server

```bash
npm run start:dev
```

Server starts at `http://localhost:8000`.
Swagger UI at `http://localhost:8000/api/docs`.

## Prisma CLI Reference

```bash
# Create a new migration
npx prisma migrate dev --name <migration_name>

# Apply migrations to production DB
npx prisma migrate deploy

# Open Prisma Studio (DB browser)
npx prisma studio

# Re-generate the Prisma client after schema changes
npx prisma generate

# Reset DB + re-apply all migrations (destructive — dev only)
npx prisma migrate reset
```

## Development Scripts

| Script | Description |
|---|---|
| `npm run start:dev` | Start with file watching (ts-node) |
| `npm run start:debug` | Start with debugger attached |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start:prod` | Run compiled output |
| `npm run lint` | ESLint check |
| `npm run format` | Prettier format |
| `npm run db:seed` | Run `prisma/seed.ts` |
