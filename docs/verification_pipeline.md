# Verification Pipeline

The verification pipeline runs asynchronously after a doctor submits documents via the portal. It is the core of the Meayar platform.

## Full Lifecycle

```
1. Tenant creates session  ──► POST /api/verifications
                                └─► Verification { status: "pending", sessionToken: "...", portalUrl: "..." }

2. Tenant redirects doctor ──► GET {portalUrl}?token={sessionToken}

3. Doctor uploads documents ──► POST /api/portal/documents/upload  (X-Session-Token header)
                                 └─► Document records created, files uploaded to R2

4. Doctor submits           ──► POST /api/portal/submit
                                 └─► Verification status: "queued"
                                 └─► BullMQ job enqueued: { queue: "verifications", name: "verify_doctor" }

5. BullMQ worker picks up   ──► VerificationProcessor.process(job)
                                 └─► status: "processing"
                                 └─► AiClientService.runPipeline(verificationId, documents)
                                 └─► AI service processes documents (see AI service README)
                                 └─► Score + decision returned

6. Score mapped to decision:
   score ≥ autoApproveThreshold (default 85)   ──► "approved"
   score ≥ manualReviewThreshold (default 60)  ──► "manual_review"
   score < manualReviewThreshold               ──► "rejected"

7. Result persisted         ──► Verification { status: "completed", score, decision, completedAt }
                                 └─► VerificationStep rows for each pipeline step
                                 └─► VerificationReport created if manual_review or rejected
                                 └─► AuditLog row written

8. Result delivered:
   a. Webhook              ──► Svix fires verification.completed (or .failed)
   b. SSE stream           ──► Redis PUBLISH "verification:{id}" → subscribed SSE clients
   c. Portal redirect      ──► signedRedirectUrl attached to verification
                                └─► HMAC-SHA256(PORTAL_SIGNING_SECRET, "{verificationId}|{decision}|{ts}")
```

## BullMQ Configuration

| Setting | Value |
|---|---|
| Queue name | `verifications` |
| Job name | `verify_doctor` |
| Attempts | `3` |
| Backoff | `exponential`, initial `5000ms` |
| Concurrency | `5` per worker instance |

Jobs are persisted in Redis. If the API restarts mid-job, the job is retried from the beginning.

## AI Client Service

`AiClientService` is an HTTP client that calls the AI microservice. It:

1. Generates presigned R2 URLs for each document (so the AI service can download files without credentials).
2. POSTs to `POST /api/pipeline` on the AI service with the presigned URLs and verification metadata.
3. Streams or polls the result.
4. Maps the AI response fields (`trust_score`, `final_decision`, `steps`) to Prisma model shapes.

Communication is authenticated with the `INTERNAL_API_KEY` header (`X-Internal-Key`), validated by `InternalKeyGuard` on the AI service side.

## Processor Error Handling

| Scenario | Behaviour |
|---|---|
| AI service returns 5xx | BullMQ retries (up to 3 attempts with exponential backoff) |
| AI service returns 4xx (bad payload) | Job marked `failed`, no retry |
| Unhandled exception in processor | BullMQ marks job `failed`, writes AuditLog error entry |
| All retries exhausted | `verification.failed` webhook fired |

## SSE (Server-Sent Events) Stream

Tenants can subscribe to real-time updates:

```
GET /api/verifications/:id/stream
Authorization: Bearer {token}   OR   x-api-key: {apiKey}
```

The controller opens a Redis `SUBSCRIBE` on channel `verification:{id}`. Each step completion, status change, and final result is published to this channel by the processor. The SSE response streams `data: {...}\n\n` events to the client.

The stream is self-closing: after the `completed` / `failed` event, the processor publishes a `done` marker and the controller ends the response.

## Signed Redirect URL

After pipeline completion, the portal redirects the doctor to the tenant's `redirectUrl` with a tamper-proof signature:

```
{redirectUrl}?verificationId={id}&decision={decision}&ts={unixTs}&sig={hmac}
```

Signature: `HMAC-SHA256(PORTAL_SIGNING_SECRET, "{verificationId}|{decision}|{ts}")`

The tenant's server can verify the signature to trust the result without an API call.
