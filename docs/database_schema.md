# Database Schema

The Meayar database is a single PostgreSQL schema with 13 models. All multi-tenant data is isolated by `tenantId` at the application layer (every query filters on the authenticated user's ID).

## Entity Relationship Overview

```
User (tenant)
├── ApiKey[]              — developer API keys
├── Doctor[]              — doctors managed by this tenant
├── Verification[]        — verification sessions
├── WebhookEndpoint[]     — registered webhook listeners
├── TenantConfig?         — scoring thresholds and workflow config
├── VerificationReport[]  — reports reviewed by this user
└── ReviewComment[]       — inline review comments

Doctor
└── Verification[]

Verification
├── VerificationStep[]    — per-step results from the AI pipeline
├── Document[]            — uploaded files (R2 paths)
├── AuditLog[]            — immutable event trail
└── VerificationReport?   — AI-generated review report

DocumentTemplate
├── DocumentTemplateField[]
└── Document[]

VerificationReport
└── ReviewComment[]
```

## Model Reference

### `User` — tenant accounts

| Column | Type | Notes |
|---|---|---|
| `id` | `String (cuid)` | Primary key |
| `email` | `String` | Unique |
| `password_hash` | `String` | bcrypt |
| `company_name` | `String` | Display name |
| `plan_tier` | `String` | `free`, `pro`, `enterprise` |
| `created_at` | `DateTime` | |

### `ApiKey` — tenant API keys

| Column | Type | Notes |
|---|---|---|
| `id` | `String (cuid)` | |
| `user_id` | `String` | FK → `users.id` |
| `name` | `String` | Human label |
| `key_hash` | `String` | bcrypt of full key |
| `key_prefix` | `String` | First 16 chars of key (`sk_live_XXXXXXXX`) — used for lookup |
| `permissions` | `String[]` | e.g. `["verifications:read","verifications:write"]` |
| `is_active` | `Boolean` | |
| `last_used_at` | `DateTime?` | |

> **Key format**: `sk_live_` + 32 random hex chars = 40 chars total. `key_prefix` stores the first 16 chars. The guard uses `slice(0, 16)` to look up the candidate row before bcrypt comparison.

### `Doctor`

| Column | Type | Notes |
|---|---|---|
| `id` | `String (cuid)` | |
| `tenant_id` | `String` | FK → `users.id` |
| `full_name_fr` | `String` | French name |
| `full_name_ar` | `String?` | Arabic name |
| `national_id_number` | `String` | Unique per tenant (`@@unique([tenant_id, national_id_number])`) |
| `status` | `String` | `pending`, `verified`, `flagged` |

### `Verification`

| Column | Type | Notes |
|---|---|---|
| `id` | `String (cuid)` | |
| `doctor_id` | `String` | FK → `doctors.id` |
| `tenant_id` | `String` | FK → `users.id` |
| `status` | `String` | `pending` → `queued` → `processing` → `completed` / `failed` / `manual_review` |
| `score` | `Float?` | 0–100 trust score |
| `decision` | `String?` | `approved`, `rejected`, `manual_review` |
| `session_token` | `String?` | 64 hex chars — portal auth token (unique) |
| `session_expires_at` | `DateTime?` | Portal token TTL |
| `redirect_url` | `String?` | Tenant-supplied URL for portal post-completion redirect |
| `started_at` | `DateTime` | |
| `completed_at` | `DateTime?` | |

### `VerificationStep`

One row per AI pipeline step (e.g. `ocr`, `authenticity`, `extraction`, `consistency`, `scraping`, `scoring`).

| Column | Type | Notes |
|---|---|---|
| `step_type` | `String` | |
| `status` | `String` | `pending`, `running`, `completed`, `failed` |
| `result_json` | `Json?` | Step-specific output |
| `confidence` | `Float?` | |

### `Document`

| Column | Type | Notes |
|---|---|---|
| `file_path` | `String` | Cloudflare R2 object key |
| `doc_type` | `String` | e.g. `national_id`, `diploma`, `cnas` |
| `ocr_result_json` | `Json?` | Raw OCR output |
| `authenticity_score` | `Float?` | |

### `DocumentTemplate` / `DocumentTemplateField`

System or tenant-specific templates that define expected fields and validation rules for each document type. `is_system = true` templates are seeded and shared across all tenants.

### `AuditLog`

Immutable append-only log of all significant actions on a verification. Written by the processor, guards, and service methods.

### `WebhookEndpoint`

| Column | Type | Notes |
|---|---|---|
| `svix_endpoint_id` | `String` | Internal Svix ID — never exposed to the tenant |
| `event_types` | `String[]` | e.g. `["verification.completed","verification.failed"]` |

### `TenantConfig`

Per-tenant scoring thresholds:

| Column | Default | Description |
|---|---|---|
| `auto_approve_threshold` | `85` | Score ≥ this → `approved` |
| `manual_review_threshold` | `60` | Score between 60–84 → `manual_review` |

Scores below `manual_review_threshold` → `rejected`.

### `VerificationReport`

Created automatically when a pipeline ends in `manual_review` or `rejected`. Contains AI-generated markdown explaining the decision. A human reviewer reads it and submits a final `decision` (`approved`, `rejected`, `resubmit`).

### `ReviewComment`

Inline comments added to a report by the reviewer during manual review.

## Indexing Notes

- `doctors`: `@@unique([tenant_id, national_id_number])` — prevents duplicate doctors per tenant.
- `verifications.session_token`: unique index — allows O(1) portal session lookup.
- All FK columns are indexed automatically by Prisma.
