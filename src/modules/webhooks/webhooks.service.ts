import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Svix } from 'svix';
import { PrismaService } from '@shared/prisma/prisma.service';
import { WebhookEventType } from './event-types';
import { CreateEndpointDto } from './dto/create-endpoint.dto';
import { UpdateEndpointDto } from './dto/update-endpoint.dto';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  private readonly svix: Svix | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const apiKey = this.config.get<string>('webhooks.svixApiKey');
    if (apiKey) {
      const serverUrl = this.config.get<string>('webhooks.svixServerUrl');
      this.svix = new Svix(apiKey, serverUrl ? { serverUrl } : undefined);
    } else {
      this.logger.warn('SVIX_API_KEY not set — webhooks disabled');
    }
  }

  // ─── Lazy Svix app provisioning ───────────────────────────────────────────
  // Called only when a tenant registers their first endpoint.
  // uid = tenantId makes the call idempotent — safe to call on every endpoint
  // creation because Svix returns the existing app if the uid already exists.

  private async ensureApp(tenantId: string): Promise<void> {
    if (!this.svix) return;
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: tenantId },
        select: { companyName: true },
      });
      await this.svix.application.create({
        name: user?.companyName ?? tenantId,
        uid: tenantId,
      });
    } catch (err) {
      this.logger.error(
        `Failed to provision Svix app for tenant ${tenantId}: ${err}`,
      );
      throw err; // let createEndpoint surface this as a 500
    }
  }

  // ─── Endpoint CRUD ────────────────────────────────────────────────────────

  async createEndpoint(tenantId: string, dto: CreateEndpointDto) {
    this.requireSvix();
    // Idempotent — creates the Svix app on first endpoint registration,
    // returns the existing one on subsequent calls.
    await this.ensureApp(tenantId);

    // filterTypes: undefined means "all events"; empty array means "nothing" in Svix
    const filterTypes =
      dto.eventTypes && dto.eventTypes.length > 0 ? dto.eventTypes : undefined;

    const svixEndpoint = await this.svix!.endpoint.create(tenantId, {
      url: dto.url,
      description: dto.description,
      filterTypes,
    });

    return this.prisma.webhookEndpoint.create({
      data: {
        tenantId,
        url: dto.url,
        description: dto.description,
        eventTypes: dto.eventTypes ?? [],
        svixEndpointId: svixEndpoint.id,
      },
      select: this.safeSelect,
    });
  }

  listEndpoints(tenantId: string) {
    return this.prisma.webhookEndpoint.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: this.safeSelect,
    });
  }

  async getEndpoint(tenantId: string, id: string) {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id, tenantId },
      select: this.safeSelect,
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
    return endpoint;
  }

  async updateEndpoint(tenantId: string, id: string, dto: UpdateEndpointDto) {
    this.requireSvix();
    const endpoint = await this.findOrFail(tenantId, id);
    const current = await this.svix!.endpoint.get(
      tenantId,
      endpoint.svixEndpointId,
    );

    // Preserve existing filterTypes (null/undefined = all events) unless caller explicitly changes them
    let filterTypes: string[] | undefined;
    if (dto.eventTypes !== undefined) {
      filterTypes = dto.eventTypes.length > 0 ? dto.eventTypes : undefined;
    } else {
      // keep whatever is already set in Svix (null means all events — leave undefined to not touch it)
      filterTypes = current.filterTypes ?? undefined;
    }

    await this.svix!.endpoint.update(tenantId, endpoint.svixEndpointId, {
      url: dto.url ?? current.url,
      description:
        dto.description !== undefined ? dto.description : current.description,
      filterTypes,
      disabled:
        dto.isActive !== undefined
          ? !dto.isActive
          : (current.disabled ?? false),
    });

    return this.prisma.webhookEndpoint.update({
      where: { id },
      data: {
        ...(dto.url ? { url: dto.url } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.eventTypes !== undefined ? { eventTypes: dto.eventTypes } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      select: this.safeSelect,
    });
  }

  async deleteEndpoint(tenantId: string, id: string) {
    this.requireSvix();
    const endpoint = await this.findOrFail(tenantId, id);
    // Delete from DB first — if Svix fails we can retry; if DB fails after Svix
    // succeeds we'd have a dangling svixEndpointId with no way to recover.
    await this.prisma.webhookEndpoint.delete({ where: { id } });
    await this.svix!.endpoint.delete(tenantId, endpoint.svixEndpointId);
  }

  // ─── Secret management ────────────────────────────────────────────────────

  async getEndpointSecret(tenantId: string, id: string) {
    this.requireSvix();
    const endpoint = await this.findOrFail(tenantId, id);
    const { key } = await this.svix!.endpoint.getSecret(
      tenantId,
      endpoint.svixEndpointId,
    );
    return { secret: key };
  }

  async rotateEndpointSecret(tenantId: string, id: string) {
    this.requireSvix();
    const endpoint = await this.findOrFail(tenantId, id);
    await this.svix!.endpoint.rotateSecret(
      tenantId,
      endpoint.svixEndpointId,
      {},
    );
    const { key } = await this.svix!.endpoint.getSecret(
      tenantId,
      endpoint.svixEndpointId,
    );
    return { secret: key };
  }

  // ─── Delivery attempts ────────────────────────────────────────────────────

  async listDeliveries(tenantId: string, id: string) {
    this.requireSvix();
    const endpoint = await this.findOrFail(tenantId, id);
    return this.svix!.messageAttempt.listByEndpoint(
      tenantId,
      endpoint.svixEndpointId,
    );
  }

  // ─── Send event (fire-and-forget) ─────────────────────────────────────────
  // tenantId is the Svix app UID — no DB lookup required.

  send(
    tenantId: string,
    eventType: WebhookEventType,
    payload: unknown,
    eventId?: string,
  ): void {
    if (!this.svix) return;
    this.svix.message
      .create(tenantId, {
        eventType,
        payload: payload as Record<string, unknown>,
        ...(eventId ? { eventId } : {}),
      })
      .catch((err) => {
        this.logger.error(
          `Failed to deliver webhook ${eventType} to tenant ${tenantId}: ${err}`,
        );
      });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private requireSvix(): void {
    if (!this.svix)
      throw new NotFoundException('Webhooks are not configured on this server');
  }

  private async findOrFail(
    tenantId: string,
    id: string,
  ): Promise<{ id: string; svixEndpointId: string }> {
    const endpoint = await this.prisma.webhookEndpoint.findFirst({
      where: { id, tenantId },
      select: { id: true, svixEndpointId: true },
    });
    if (!endpoint) throw new NotFoundException('Webhook endpoint not found');
    return endpoint;
  }

  // svixEndpointId is never returned to tenants
  private readonly safeSelect = {
    id: true,
    url: true,
    description: true,
    eventTypes: true,
    isActive: true,
    createdAt: true,
  } as const;
}
