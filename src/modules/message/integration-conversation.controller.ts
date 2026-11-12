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
  @IsOptional() @IsString() @MaxLength(500) messageId?: string;
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
class FileRequest extends ChatRequest {
  @IsString() @IsBase64() @MaxLength(20971520) base64!: string;
  @IsString() @Matches(/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]{1,12})?$(?![\s\S])/) @MaxLength(200) filename!: string;
  @IsString() @Matches(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$(?![\s\S])/) @MaxLength(100) mimetype!: string;
}
@Public()
@UseGuards(IntegrationSessionGuard)
@Controller('integrations/sessions/:sessionId/conversations')
export class IntegrationConversationController {
  private readonly backfill = new Map<
    string,
    { expires: number; messages: Awaited<ReturnType<MessageService['getChatHistory']>> }
  >();
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
    let warning: string | null = null;
    let live: Awaited<ReturnType<MessageService['getChatHistory']>> = [];
    if (!Number(query.offset)) {
      const key = id + ':' + query.chatId;
      const cached = this.backfill.get(key);
      try {
        if (cached && cached.expires > Date.now()) live = cached.messages;
        else {
          live = await this.messages.getChatHistory(id, query.chatId, 100, false);
          if (this.backfill.size >= 100) this.backfill.delete(this.backfill.keys().next().value!);
          this.backfill.set(key, { expires: Date.now() + 60000, messages: live });
        }
      } catch {
        warning = 'No se pudo consultar el historial de WhatsApp. Se muestran los mensajes guardados disponibles.';
      }
    }
    const merged = new Map<
      string,
      {
        mediaId?: string | null;
        id: string;
        body: string;
        type: string;
        direction: string;
        timestamp: number;
        status: string;
        attachment: { filename: string | null; mimetype: string | null } | null;
      }
    >();
    for (const h of live)
      merged.set(h.id, {
        id: h.id,
        mediaId: h.id,
        body: h.body ?? '',
        type: h.type,
        direction: h.fromMe ? 'outgoing' : 'incoming',
        timestamp: h.timestamp ?? 0,
        status: 'read',
        attachment:
          h.type === 'document' ? { filename: h.media?.filename ?? null, mimetype: h.media?.mimetype ?? null } : null,
      });
    const stored = result.messages.map(m => ({
      id: m.id,
      mediaId: m.waMessageId || null,
      body: m.body,
      type: m.type,
      direction: m.direction,
      timestamp: m.timestamp,
      status: m.status,
      attachment:
        m.type === 'document' || m.metadata?.media
          ? {
              filename:
                typeof (m.metadata?.media as { filename?: unknown } | undefined)?.filename === 'string'
                  ? (m.metadata?.media as { filename: string }).filename.slice(0, 200)
                  : typeof m.metadata?.filename === 'string'
                    ? m.metadata.filename.slice(0, 200)
                    : null,
              mimetype:
                typeof (m.metadata?.media as { mimetype?: unknown } | undefined)?.mimetype === 'string'
                  ? (m.metadata?.media as { mimetype: string }).mimetype.slice(0, 100)
                  : null,
            }
          : null,
    }));
    result.messages.forEach((m, i) => merged.set(m.waMessageId || m.id, stored[i]));
    return {
      total: result.total,
      warning,
      messages: [...merged.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)),
    };
  }
  @Get('media')
  async media(@Param('sessionId') id: string, @Query() query: ChatRequest) {
    if (!query.messageId) throw new BadRequestException('Missing message id');
    const media = await this.messages.getChatMedia(id, query.chatId, query.messageId);
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(media.mimetype))
      throw new BadRequestException('Not a supported image');
    if (media.buffer.length > 15 * 1024 * 1024) throw new PayloadTooLargeException();
    return { data: media.buffer.toString('base64'), mimetype: media.mimetype };
  }
  @Post('read')
  async read(@Param('sessionId') id: string, @Body() dto: ChatRequest) {
    return { success: await this.sessions.sendSeen(id, dto.chatId) };
  }
  @Post('files')
  @IdempotentSend()
  async file(@Param('sessionId') id: string, @Body() dto: FileRequest) {
    const bytes = Buffer.from(dto.base64, 'base64');
    if (bytes.length > 15 * 1024 * 1024) throw new PayloadTooLargeException();
    if (!bytes.length) throw new BadRequestException('Empty file');
    const data = { chatId: dto.chatId, base64: dto.base64, filename: dto.filename, mimetype: dto.mimetype };
    const image = ['image/jpeg', 'image/png', 'image/webp'].includes(dto.mimetype);
    const message = image ? await this.messages.sendImage(id, data) : await this.messages.sendDocument(id, data);
    return { id: message.messageId, status: 'sent' };
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
