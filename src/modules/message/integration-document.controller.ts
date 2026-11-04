import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Param,
  PayloadTooLargeException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBase64, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Public } from '../auth/decorators/auth.decorators';
import { IntegrationSessionGuard } from '../session/integration-session.guard';
import { SessionService } from '../session/session.service';
import { SessionStatus } from '../session/entities/session.entity';
import { MessageService } from './message.service';
import { IdempotentSend } from './idempotency/idempotent-send.decorator';

export class IntegrationPdfDto {
  @ApiProperty({ description: 'International phone number, digits only', example: '529991234567' })
  @IsString()
  @Matches(/^[1-9][0-9]{7,14}$(?![\s\S])/)
  phone!: string;

  @ApiProperty({ description: 'PDF bytes encoded as base64, max 15 MiB decoded' })
  @IsString()
  @IsBase64()
  @MaxLength(20971520)
  base64!: string;

  @ApiProperty({ example: 'Itinerario.pdf', maxLength: 200 })
  @IsString()
  @MaxLength(200)
  // Filenames must not carry path separators or control bytes.
  // eslint-disable-next-line no-control-regex
  @Matches(/^[^\\/:*?"<>|\x00-\x1F\x7F]+\.pdf$(?![\s\S])/i)
  filename!: string;

  @ApiPropertyOptional({ maxLength: 1024 })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  caption?: string;
}

@ApiTags('system-integrations')
@Controller('integrations/sessions/:sessionId/documents')
@Public()
@UseGuards(IntegrationSessionGuard)
export class IntegrationDocumentController {
  constructor(
    private readonly sessions: SessionService,
    private readonly messages: MessageService,
  ) {}

  @Post()
  @IdempotentSend()
  async sendPdf(@Param('sessionId') sessionId: string, @Body() dto: IntegrationPdfDto) {
    // The integration guard checks source + id before the proxy and idempotency interceptors.
    const session = await this.sessions.findOne(sessionId);
    if (session.status !== SessionStatus.READY) throw new ConflictException('Session must be connected before sending');
    const pdf = Buffer.from(dto.base64, 'base64');
    if (pdf.length > 15 * 1024 * 1024) throw new PayloadTooLargeException('PDF exceeds 15 MiB');
    if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new BadRequestException('Only PDF documents are accepted');
    const message = await this.messages.sendDocument(sessionId, {
      chatId: dto.phone + '@c.us',
      base64: dto.base64,
      filename: dto.filename,
      mimetype: 'application/pdf',
      caption: dto.caption,
    });
    return { id: message.messageId || null, status: 'sent', timestamp: message.timestamp };
  }
}
