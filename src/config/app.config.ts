import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  port: parseInt(process.env.PORT ?? '8000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',
  // ── Portal ────────────────────────────────────────────────────────────────
  // Base URL of the doctor-facing portal frontend (e.g. https://verify.meayar.dz)
  portalBaseUrl:
    process.env.PORTAL_BASE_URL ?? 'https://frontend.bensefiayazid.workers.dev',
  // Secret used to HMAC-sign the redirect URL returned to the tenant after completion.
  // Set to a long random string in production. Tenants use this to verify the redirect.
  portalSigningSecret: process.env.PORTAL_SIGNING_SECRET ?? '',
  // How long a session token is valid for (hours). Default: 1 hour.
  portalSessionTtlHours: parseInt(
    process.env.PORTAL_SESSION_TTL_HOURS ?? '1',
    10,
  ),
}));
