import { createHmac } from 'crypto';
import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@shared/prisma/prisma.service';
import { DocumentsService } from '@modules/documents/documents.service';
import { VerificationsService } from '@modules/verifications/verifications.service';
import { CacheService } from '@shared/cache/cache.service';
import type { UploadDocumentDto } from '@modules/documents/dto/upload-document.dto';

@Injectable()
export class PortalService {
  private readonly logger = new Logger(PortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly documents: DocumentsService,
    private readonly verifications: VerificationsService,
    private readonly cache: CacheService,
  ) {}

  // ─── Validate a session token and return verification + doctor context ────

  async getSession(token: string) {
    const verification = await this.prisma.verification.findUnique({
      where: { sessionToken: token },
      include: {
        doctor: {
          select: {
            id: true,
            fullNameFr: true,
            fullNameAr: true,
            nationalIdNumber: true,
          },
        },
        documents: {
          select: { id: true, docType: true, uploadedAt: true },
          orderBy: { uploadedAt: 'asc' },
        },
      },
    });

    if (!verification) throw new NotFoundException('Session not found');

    // Only block expired sessions that are still pending — completed/failed
    // sessions must remain readable so the portal can show the result.
    if (
      verification.status === 'pending' &&
      verification.sessionExpiresAt &&
      verification.sessionExpiresAt < new Date()
    ) {
      throw new UnauthorizedException('Session has expired');
    }

    const result: {
      verificationId: string;
      status: string;
      doctor: (typeof verification)['doctor'];
      documents: (typeof verification)['documents'];
      expiresAt: string | null;
      signedRedirectUrl: string | null;
    } = {
      verificationId: verification.id,
      status: verification.status,
      doctor: verification.doctor,
      documents: verification.documents,
      expiresAt: verification.sessionExpiresAt?.toISOString() ?? null,
      signedRedirectUrl: null,
    };

    // Attach signed redirect URL once the pipeline has completed
    if (
      verification.status === 'completed' &&
      verification.redirectUrl &&
      verification.decision
    ) {
      result.signedRedirectUrl = this.buildSignedRedirectUrl(
        verification.id,
        verification.decision,
        verification.redirectUrl,
      );
    }

    return result;
  }

  // ─── Upload a document on behalf of the doctor ────────────────────────────

  async uploadDocument(
    verificationId: string,
    tenantId: string,
    file: Express.Multer.File,
    dto: Omit<UploadDocumentDto, 'verificationId'>,
  ) {
    return this.documents.upload(file, { ...dto, verificationId }, tenantId);
  }

  // ─── Bulk upload: upload multiple documents in one request ───────────────
  // Each entry in `metaList` maps 1-to-1 with the corresponding file in `files`.
  // Results are returned per-file so the portal can report partial failures.

  async bulkUploadDocuments(
    verificationId: string,
    tenantId: string,
    files: Express.Multer.File[],
    metaList: Array<{ docType: string; templateId?: string }>,
  ) {
    const results = await Promise.allSettled(
      files.map((file, i) => {
        const meta = metaList[i] ?? metaList[metaList.length - 1];
        return this.documents.upload(
          file,
          { ...meta, verificationId },
          tenantId,
        );
      }),
    );

    const uploaded: unknown[] = [];
    const failed: Array<{ index: number; error: string }> = [];

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        uploaded.push(result.value);
      } else {
        const message =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        failed.push({ index, error: message });
      }
    });

    return { uploaded, failed, total: files.length };
  }

  // ─── Submit: enqueue the pipeline job ─────────────────────────────────────

  async submit(verificationId: string, tenantId: string) {
    // Atomic: move status from 'pending' → 'queued' in a single UPDATE.
    // If count === 0 the verification was already submitted (or doesn't exist).
    const updated = await this.prisma.verification.updateMany({
      where: { id: verificationId, tenantId, status: 'pending' },
      data: { status: 'queued' },
    });

    if (updated.count === 0) {
      // Distinguish not-found from already-submitted for a cleaner error message
      const exists = await this.prisma.verification.findUnique({
        where: { id: verificationId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Verification not found');
      throw new ConflictException(
        'Verification has already been submitted or is no longer pending',
      );
    }

    await this.verifications.enqueueVerification(verificationId, tenantId);
    this.logger.log(`Portal submit: enqueued verification ${verificationId}`);
    return { submitted: true };
  }

  // ─── Build HMAC-signed redirect URL ──────────────────────────────────────
  // Format: redirectUrl?verificationId=xxx&status=yyy&ts=unix&sig=hmac_hex
  // Tenants verify: HMAC-SHA256(secret, "verificationId|status|ts")

  buildSignedRedirectUrl(
    verificationId: string,
    decision: string,
    redirectUrl: string,
  ): string {
    const ts = Math.floor(Date.now() / 1_000).toString();
    const secret = this.config.get<string>('app.portalSigningSecret') ?? '';

    if (!secret) {
      this.logger.warn(
        'PORTAL_SIGNING_SECRET is not set — redirect URL signature will be weak',
      );
    }

    const payload = `${verificationId}|${decision}|${ts}`;
    const sig = createHmac('sha256', secret).update(payload).digest('hex');

    const url = new URL(redirectUrl);
    url.searchParams.set('verificationId', verificationId);
    url.searchParams.set('status', decision);
    url.searchParams.set('ts', ts);
    url.searchParams.set('sig', sig);
    return url.toString();
  }

  // ─── Validate session token for SSE / unauthenticated portal endpoints ───

  async getVerificationIdFromToken(token: string): Promise<string> {
    const verification = await this.prisma.verification.findUnique({
      where: { sessionToken: token },
      select: { id: true, sessionExpiresAt: true },
    });

    if (!verification) throw new NotFoundException('Session not found');

    if (
      verification.sessionExpiresAt &&
      verification.sessionExpiresAt < new Date()
    ) {
      throw new UnauthorizedException('Session has expired');
    }

    return verification.id; // SSE only used while pending/running — expiry is correct here
  }

  // ─── SSE subscription (delegates to cache) ───────────────────────────────

  subscribeToVerification(
    verificationId: string,
    callback: (message: unknown) => void,
  ): () => void {
    return this.cache.subscribe(`verification:${verificationId}`, callback);
  }
}
