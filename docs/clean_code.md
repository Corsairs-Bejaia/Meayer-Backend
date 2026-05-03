# Clean Code Structure

## Project Layout

```
backend/
├── src/
│   ├── app.module.ts          # Root module — imports all feature modules
│   ├── main.ts                # Bootstrap: global pipes, guards, Swagger setup
│   │
│   ├── config/                # Config factories (registered with @nestjs/config)
│   │   ├── app.config.ts
│   │   ├── database.config.ts
│   │   ├── jwt.config.ts
│   │   ├── redis.config.ts
│   │   ├── services.config.ts
│   │   └── storage.config.ts
│   │
│   ├── core/                  # Framework-level cross-cutting concerns
│   │   ├── decorators/        # @CurrentUser, @Public, @RequirePermission
│   │   ├── filters/           # HttpExceptionFilter, PrismaExceptionFilter
│   │   ├── guards/            # JwtAuthGuard (global), ApiKeyGuard, FlexAuthGuard
│   │   ├── interceptors/      # LoggingInterceptor, ResponseTransformInterceptor
│   │   └── utils/             # hash, crypto, pagination helpers
│   │
│   ├── modules/               # Feature modules (one folder per domain)
│   │   ├── auth/
│   │   ├── users/
│   │   ├── verifications/
│   │   ├── doctors/
│   │   ├── documents/
│   │   ├── templates/
│   │   ├── reports/
│   │   ├── api-keys/
│   │   ├── webhooks/
│   │   ├── portal/
│   │   └── dashboard/
│   │
│   └── shared/                # @Global providers re-exported once
│       ├── prisma/            # PrismaModule, PrismaService
│       ├── cache/             # CacheModule (ioredis)
│       └── storage/           # StorageModule, StorageService (R2)
│
├── prisma/
│   ├── schema.prisma
│   ├── seed.ts
│   └── migrations/
│
└── docs/                      # This folder
```

## Path Aliases

Configured in `tsconfig.json`:

| Alias | Resolves to |
|---|---|
| `@modules/*` | `src/modules/*` |
| `@shared/*` | `src/shared/*` |
| `@core/*` | `src/core/*` |
| `@config/*` | `src/config/*` |

Always use path aliases for imports across folder boundaries. Never use `../../../../` relative paths.

```typescript
// ✅ Correct
import { PrismaService } from '@shared/prisma/prisma.service';
import { JwtAuthGuard } from '@core/guards/jwt-auth.guard';
import { CreateVerificationDto } from '@modules/verifications/dto';

// ❌ Avoid
import { PrismaService } from '../../../shared/prisma/prisma.service';
```

## Module Conventions

Each feature module follows this structure:

```
modules/verifications/
├── verifications.module.ts        # Module decorator, imports, providers
├── verifications.controller.ts    # Route handlers, Swagger decorators
├── verifications.service.ts       # Business logic, Prisma calls
├── verifications.processor.ts     # BullMQ processor (if async job)
└── dto/
    ├── create-verification.dto.ts
    ├── update-verification.dto.ts
    └── index.ts                   # Re-export all DTOs
```

## DTO Patterns

- All DTOs use `class-validator` decorators.
- The global `ValidationPipe` runs with `whitelist: true` — unknown properties are stripped silently.
- `transform: true` auto-coerces types (string → number, string → boolean).

```typescript
export class CreateVerificationDto {
  @IsString()
  @IsNotEmpty()
  doctorName: string;

  @IsString()
  @IsOptional()
  redirectUrl?: string;
}
```

## Response Shape

All responses are wrapped by `ResponseTransformInterceptor`:

```json
{
  "success": true,
  "data": { ... },
  "meta": { "timestamp": "...", "path": "/api/verifications" }
}
```

Errors follow `HttpExceptionFilter`:

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid API key"
  }
}
```

## Guard Hierarchy

Guards are applied in this order:

1. **`JwtAuthGuard`** — global, applied to every route.
2. **`@Public()`** — decorator that tells `JwtAuthGuard` to skip this route.
3. **`FlexAuthGuard`** — for routes that accept both JWT and API key. Applied with `@Public() @UseGuards(FlexAuthGuard)` to disable the global JWT guard and substitute the flex guard.
4. **`ApiKeyGuard`** — used directly inside `FlexAuthGuard` for the API key branch.

## Naming Conventions

| Item | Convention | Example |
|---|---|---|
| Module files | kebab-case | `api-keys.module.ts` |
| Class names | PascalCase | `ApiKeysService` |
| DTOs | PascalCase + Dto suffix | `CreateVerificationDto` |
| Prisma models | PascalCase singular | `Verification`, `Doctor` |
| DB columns | snake_case | `tenant_id`, `created_at` |
| Env variables | SCREAMING_SNAKE | `JWT_SECRET`, `R2_BUCKET` |
| Config namespace | camelCase | `jwt.secret`, `storage.bucket` |
