import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Repository } from 'typeorm';
import { Public } from '../auth/decorators/auth.decorators';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/entities/audit-log.entity';
import { Session, SessionStatus } from './entities/session.entity';
import { SessionResponseDto } from './dto';
import { SessionService } from './session.service';
import { IntegrationSessionGuard, type IntegrationRequest } from './integration-session.guard';

export class CreateIntegrationSessionDto {
  @ApiProperty({ minLength: 3, maxLength: 50, example: 'recepcion' })
  @IsString()
  @MinLength(3)
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9-]+$/)
  name!: string;
}

@ApiTags('system-integrations')
@Controller('integrations/sessions')
// Skips the general API-key guard ONLY: the dedicated integration guard always authenticates
// and fences every session id, including QR, start, logout and delete, before any interceptor.
@Public()
@UseGuards(IntegrationSessionGuard)
export class IntegrationSessionController {
  constructor(
    private readonly service: SessionService,
    @InjectRepository(Session, 'data') private readonly sessions: Repository<Session>,
    private readonly audit: AuditService,
  ) {}

  private response(session: Session) {
    return SessionResponseDto.fromEntity(session, this.service.engineLoaded(session));
  }

  @Get()
  async list(@Req() request: IntegrationRequest) {
    const rows = await this.sessions.find({
      where: { sourceSystem: request.integrationSystem },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: 1000,
    });
    return {
      sourceSystem: request.integrationSystem,
      sessions: await Promise.all(rows.map(async row => this.response(await this.service.findOne(row.id)))),
    };
  }

  @Post()
  async create(@Req() request: IntegrationRequest, @Body() dto: CreateIntegrationSessionDto) {
    const name = request.integrationSystem.replace(/_/g, '-') + '--' + dto.name;
    const session = await this.service.create({ name }, request.integrationSystem);
    await this.audit.logInfo(AuditAction.SESSION_CREATED, {
      sessionId: session.id,
      sessionName: session.name,
      metadata: { sourceSystem: request.integrationSystem },
    });
    return this.response(session);
  }

  @Get(':sessionId')
  async find(@Param('sessionId') id: string) {
    return this.response(await this.service.findOne(id));
  }

  @Post(':sessionId/start')
  @HttpCode(200)
  async start(@Param('sessionId') id: string) {
    const current = await this.service.findOne(id);
    if (this.service.engineLoaded(current)) return this.response(current);
    const session = await this.service.start(id, { explicit: true });
    await this.audit.logInfo(AuditAction.SESSION_STARTED, {
      sessionId: id,
      sessionName: session.name,
      metadata: { sourceSystem: session.sourceSystem },
    });
    return this.response(session);
  }

  @Get(':sessionId/qr')
  async qr(@Param('sessionId') id: string) {
    const session = await this.service.findOne(id);
    if (session.status !== SessionStatus.QR_READY) return { qrCode: null, status: session.status };
    return this.service.getQRCode(id);
  }

  @Post(':sessionId/logout')
  @HttpCode(200)
  async logout(@Param('sessionId') id: string) {
    const session = await this.service.logout(id);
    await this.audit.logInfo(AuditAction.SESSION_LOGGED_OUT, {
      sessionId: id,
      sessionName: session.name,
      metadata: { sourceSystem: session.sourceSystem },
    });
    return this.response(session);
  }

  @Delete(':sessionId')
  @HttpCode(204)
  async delete(@Param('sessionId') id: string) {
    const session = await this.service.findOne(id);
    await this.service.delete(id);
    await this.audit.logInfo(AuditAction.SESSION_DELETED, {
      sessionId: id,
      sessionName: session.name,
      metadata: { sourceSystem: session.sourceSystem },
    });
  }
}
