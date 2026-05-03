# Deployment Guide

This document explains how to deploy the Meayar backend to a production environment.

## Deploying to Railway

The repository is pre-configured for [Railway](https://railway.app/).

### 1. Prerequisites

- A Railway account.
- Your project pushed to a GitHub repository.
- A provisioned Neon PostgreSQL database and Redis instance.
- A Cloudflare R2 bucket.
- A Svix organisation and API key.

### 2. Steps to deploy

1. **Connect to GitHub**: In Railway, create "New Project" → "Deploy from GitHub repo" → select the `backend/` root.
2. **Set the start command**: `node dist/main.js` (or let Railway use the `Procfile` if present).
3. **Set the build command**: `npm install && npm run build`.
4. **Configure environment variables** (see table below).
5. **Deploy**: Railway builds the image and starts the service.

### 3. Environment variables

| Variable | Example / Notes |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `8000` |
| `DATABASE_URL` | Neon **pooler** URL — `postgresql://user:pass@ep-xxx-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require` |
| `REDIS_URL` | `redis://default:pass@host:6379` |
| `JWT_SECRET` | ≥ 64 random characters |
| `JWT_EXPIRY` | `15m` |
| `JWT_REFRESH_EXPIRY` | `7d` |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | R2 API token |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |
| `R2_BUCKET` | Bucket name |
| `R2_PUBLIC_URL` | Public base URL for R2 (if bucket is public) |
| `PORTAL_BASE_URL` | `https://frontend.bensefiayazid.workers.dev` |
| `PORTAL_SIGNING_SECRET` | ≥ 32 random characters |
| `SVIX_API_KEY` | `sk_...` or `testsk_...` |
| `SVIX_SERVER_URL` | Optional — set for EU region: `https://api.eu.svix.com` |
| `AI_SERVICE_URL` | Railway internal URL of the AI service |
| `INTERNAL_API_KEY` | Shared secret used by backend → AI service headers |
| `APP_NAME` | `Meayar` |
| `API_PREFIX` | `api` |

### 4. Running migrations on deploy

> **Critical**: Use the **direct** (non-pooler) Neon URL for `prisma migrate deploy`. The pooler does not support the `CREATE SCHEMA` and advisory lock calls that migration runs require.

Set a separate `DATABASE_DIRECT_URL` environment variable pointing to the direct endpoint:

```
DATABASE_DIRECT_URL=postgresql://user:pass@ep-dry-firefly-ampe92gn.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require
```

Update `prisma/schema.prisma` to reference both:
```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DATABASE_DIRECT_URL")
}
```

Run in a Railway one-off job or during the build step:
```bash
npx prisma migrate deploy
```

### 5. Monitoring

- **Health check**: `GET /api/health` — Railway can be configured to hit this for zero-downtime deploys.
- **Logs**: Real-time logs in the Railway dashboard.
- **Swagger**: Disabled in production (`NODE_ENV=production` hides internal docs). Public spec available at `/api/docs/json`.

## Manual Docker Deployment

```bash
# Build image
docker build -t meayar-backend .

# Run container
docker run -d \
  -p 8000:8000 \
  --env-file .env \
  meayar-backend
```

## Neon Pooler vs Direct URL

| Use case | URL type |
|---|---|
| Runtime queries (NestJS app) | **Pooler** URL (`ep-xxx-pooler.c-5.aws.neon.tech`) |
| `prisma migrate deploy` | **Direct** URL (`ep-xxx.c-5.aws.neon.tech`) |
| `prisma migrate dev` | **Direct** URL |
| `prisma studio` | Either |

The pooler URL keeps connections efficient through PgBouncer. The direct URL is needed for DDL statements and advisory locks during migrations.
