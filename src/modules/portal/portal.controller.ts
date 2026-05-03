import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  UploadedFiles,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiConsumes,
  ApiBody,
  ApiHeader,
} from '@nestjs/swagger';
import { Public } from '@core/decorators/public.decorator';
import { SessionTokenGuard } from '@core/guards/session-token.guard';
import { SessionVerification } from '@core/decorators/session-verification.decorator';
import type { SessionContext } from '@core/guards/session-token.guard';
import { ALLOWED_DOC_TYPES } from '@modules/documents/dto/upload-document.dto';
import { IsString, IsOptional, IsIn, IsArray, ValidateNested, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { PortalService } from './portal.service';

// ── Minimal upload DTO (verificationId comes from the session) ────────────────

class PortalUploadDto {
  @ApiProperty({ enum: ALLOWED_DOC_TYPES })
  @IsString()
  @IsIn(ALLOWED_DOC_TYPES)
  docType!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  templateId?: string;
}

// ── Bulk upload item (one entry per file) ────────────────────────────────────

class BulkUploadItemDto {
  @ApiProperty({ enum: ALLOWED_DOC_TYPES })
  @IsString()
  @IsIn(ALLOWED_DOC_TYPES)
  docType!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  templateId?: string;
}

class PortalBulkUploadDto {
  @ApiProperty({
    description:
      'JSON-encoded array of metadata objects, one per file. ' +
      'Example: `[{"docType":"diploma"},{"docType":"national_id"}]`',
    type: 'string',
  })
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => BulkUploadItemDto)
  metadata!: BulkUploadItemDto[];
}

// ─────────────────────────────────────────────────────────────────────────────

@Public() // all portal routes bypass JwtAuthGuard
@ApiTags('Portal')
@Controller('portal')
export class PortalController {
  constructor(private readonly portalService: PortalService) {}

  // ── GET /portal/session/:token ────────────────────────────────────────────

  @Get('session/:token')
  @ApiOperation({
    summary: 'Fetch portal session',
    description:
      'Returns the verification status, doctor info, and uploaded documents ' +
      'for the given session token. When the pipeline has `status: completed` ' +
      'and a `redirectUrl` was provided, `signedRedirectUrl` is populated — ' +
      'the portal frontend should redirect the doctor there immediately.',
  })
  @ApiParam({
    name: 'token',
    description: '64-char hex session token from the portal URL',
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Session data' })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Session not found',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Session expired',
  })
  getSession(@Param('token') token: string) {
    return this.portalService.getSession(token);
  }

  // ── POST /portal/documents/upload ─────────────────────────────────────────

  @Post('documents/upload')
  @UseGuards(SessionTokenGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 20 * 1024 * 1024 },
      storage: undefined, // memory storage
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload a document from the portal',
    description:
      'Uploads a document (JPEG / PNG / PDF, max 20 MB) and attaches it to the ' +
      'verification bound to the session. Authenticate with `X-Session-Token`.',
  })
  @ApiHeader({
    name: 'X-Session-Token',
    description: '64-char hex session token',
    required: true,
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'docType'],
      properties: {
        file: { type: 'string', format: 'binary' },
        docType: { type: 'string', enum: [...ALLOWED_DOC_TYPES] },
        templateId: { type: 'string' },
      },
    },
  })
  @ApiResponse({ status: HttpStatus.CREATED, description: 'Document uploaded' })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Invalid or expired session',
  })
  uploadDocument(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: PortalUploadDto,
    @SessionVerification() session: SessionContext,
  ) {
    return this.portalService.uploadDocument(
      session.verificationId,
      session.tenantId,
      file,
      dto,
    );
  }

  // ── POST /portal/documents/bulk-upload ────────────────────────────────────

  @Post('documents/bulk-upload')
  @UseGuards(SessionTokenGuard)
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      limits: { fileSize: 20 * 1024 * 1024 },
      storage: undefined, // memory storage
    }),
  )
  @ApiConsumes('multipart/form-data')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Bulk-upload multiple documents from the portal',
    description:
      'Upload up to **10 files** in a single request and attach them to the ' +
      'verification bound to the session.\n\n' +
      'Supply a `metadata` field containing a **JSON-encoded array** of ' +
      '`{docType, templateId?}` objects, one entry per file (indexed by position).\n\n' +
      'Results are returned per-file: `uploaded` lists successes, `failed` lists ' +
      'any errors by file index so the portal can report partial failures.',
  })
  @ApiHeader({
    name: 'X-Session-Token',
    description: '64-char hex session token',
    required: true,
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['files', 'metadata'],
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          maxItems: 10,
        },
        metadata: {
          type: 'string',
          description:
            'JSON array of {docType, templateId?}, one per file',
          example: '[{"docType":"diploma"},{"docType":"national_id"}]',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Bulk upload result',
    schema: {
      example: {
        uploaded: [{ id: 'clx9doc00001', docType: 'diploma' }],
        failed: [{ index: 1, error: 'Unsupported file type. Allowed: JPEG, PNG, PDF' }],
        total: 2,
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Invalid or expired session',
  })
  async bulkUploadDocuments(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('metadata') rawMetadata: string,
    @SessionVerification() session: SessionContext,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }

    let metaList: Array<{ docType: string; templateId?: string }>;
    try {
      metaList = JSON.parse(rawMetadata) as typeof metaList;
    } catch {
      throw new BadRequestException(
        'metadata must be a valid JSON array of {docType, templateId?} objects',
      );
    }

    if (!Array.isArray(metaList) || metaList.length === 0) {
      throw new BadRequestException('metadata must be a non-empty array');
    }

    return this.portalService.bulkUploadDocuments(
      session.verificationId,
      session.tenantId,
      files,
      metaList,
    );
  }

  // ── POST /portal/submit ───────────────────────────────────────────────────

  @Post('submit')
  @UseGuards(SessionTokenGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit the verification for processing',
    description:
      'Enqueues the verification pipeline. Call this once the doctor has ' +
      'finished uploading all required documents. Returns 409 if already submitted.',
  })
  @ApiHeader({
    name: 'X-Session-Token',
    description: '64-char hex session token',
    required: true,
  })
  @ApiResponse({ status: HttpStatus.OK, description: 'Pipeline enqueued' })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Invalid or expired session',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Verification already submitted',
  })
  submit(@SessionVerification() session: SessionContext) {
    return this.portalService.submit(session.verificationId, session.tenantId);
  }

  // ── GET /portal/stream/:token ─────────────────────────────────────────────

  @Get('stream/:token')
  @ApiOperation({
    summary: 'SSE progress stream for the portal',
    description:
      'Opens a Server-Sent Events connection that emits pipeline progress events. ' +
      'The session token is validated on connection. Suitable for use with the ' +
      'browser `EventSource` API (which cannot set custom headers).',
  })
  @ApiParam({ name: 'token', description: '64-char hex session token' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'text/event-stream — JSON progress events',
  })
  async stream(@Param('token') token: string, @Res() res: Response) {
    // Validate token before opening the stream
    const verificationId =
      await this.portalService.getVerificationIdFromToken(token);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const unsubscribe = this.portalService.subscribeToVerification(
      verificationId,
      (message) => {
        res.write(`data: ${JSON.stringify(message)}\n\n`);
      },
    );

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 25_000);

    res.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  }
}
