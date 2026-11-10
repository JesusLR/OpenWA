import {
  BadRequestException,
  PayloadTooLargeException,
  Body,
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsNumberString, IsBase64, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Public } from '../auth/decorators/auth.decorators';
import { IntegrationSessionGuard } from '../session/integration-session.guard';
import { SessionService } from '../session/session.service';
import { MessageService } from './message.service';
import { IdempotentSend } from './idempotency/idempotent-send.decorator';

class ChatRequest {
  @IsString()
  @Matches(/^[0-9]{5,20}@(c\.us|s\.whatsapp\.net|lid)$/)
  chatId!: string;
  @IsOptional()
  @IsNumberString()
  offset?: string;
}
class TextRequest extends ChatRequest {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text!: string;
}
class PdfRequest extends ChatRequest {
  @IsString() @IsBase64() @MaxLength(20971520) base64!: string;
  @IsString() @Matches(/^[a-zA-Z0-9_-]+\.pdf$/) @MaxLength(200) filename!: string;
}
@Public()
@UseGuards(IntegrationSessionGuard)
@Controller('integrations/sessions/:sessionId/conversations')
export class IntegrationConversationController {
  constructor(
    private readonly sessions: SessionService,
    private readonly messages: MessageService,
  ) {}
  @Get()
  async list(@Param('sessionId') id: string) {
    const chats = await this.sessions.listChats(id);
    return chats.filter(c => !c.isGroup && /^[0-9]{5,20}@(c\.us|s\.whatsapp\.net|lid)$/.test(c.id));
  }
  @Get('messages')
  async history(@Param('sessionId') id: string, @Query() query: ChatRequest) {
    const result = await this.messages.getMessages(id, {
      chatId: query.chatId,
      limit: 100,
      offset: Math.min(Number(query.offset) || 0, 1000000),
      inlineMedia: false,
    });
    return {
      total: result.total,
      messages: result.messages.map(m => ({
        id: m.id,
        body: m.body,
        type: m.type,
        direction: m.direction,
        timestamp: m.timestamp,
        status: m.status,
        attachment: m.type === 'document' || m.metadata?.media ? {
          filename: typeof (m.metadata?.media as { filename?: unknown } | undefined)?.filename === 'string' ? (m.metadata?.media as { filename: string }).filename.slice(0, 200) : (typeof m.metadata?.filename === 'string' ? m.metadata.filename.slice(0, 200) : null),
          mimetype: typeof (m.metadata?.media as { mimetype?: unknown } | undefined)?.mimetype === 'string' ? (m.metadata?.media as { mimetype: string }).mimetype.slice(0, 100) : null,
        } : null,
      })),
    };
  }
  @Post('pdf')
  @IdempotentSend()
  async pdf(@Param('sessionId') id: string, @Body() dto: PdfRequest) {
    const pdf = Buffer.from(dto.base64, 'base64');
    if (pdf.length > 15 * 1024 * 1024) throw new PayloadTooLargeException();
    if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new BadRequestException('Invalid PDF');
    const message = await this.messages.sendDocument(id, {
      chatId: dto.chatId,
      base64: dto.base64,
      filename: dto.filename,
      mimetype: 'application/pdf',
      caption: 'Hola, aquí tienes tu documento de De Viaje en Viaje.',
    });
    return { id: message.messageId, status: 'sent' };
  }
  @Post('text')
  @IdempotentSend()
  async send(@Param('sessionId') id: string, @Body() dto: TextRequest) {
    const message = await this.messages.sendText(id, { chatId: dto.chatId, text: dto.text });
    return { id: message.messageId, status: 'sent' };
  }
}
