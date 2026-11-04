import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { isUUID } from 'class-validator';
import { Repository } from 'typeorm';
import { Session } from './entities/session.entity';
import { bearerToken } from '../../common/security/bearer-token';

export type IntegrationRequest = Request & { integrationSystem: string };

export function integrationSystemForToken(raw: string | undefined, token: string | undefined): string {
  let systems: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    systems = parsed as Record<string, unknown>;
    const entries = Object.entries(systems);
    if (
      !entries.length ||
      entries.some(
        ([system, secret]) =>
          !/^[a-z0-9_]{3,40}$/.test(system) || typeof secret !== 'string' || secret.length < 32 || secret.length > 512,
      )
    )
      throw new Error();
    if (new Set(Object.values(systems)).size !== entries.length) throw new Error();
  } catch {
    throw new ServiceUnavailableException('System integrations are not configured correctly');
  }
  if (!token || token.length > 512) throw new UnauthorizedException('Integration credential is required');
  const digest = createHash('sha256').update(token).digest();
  for (const [system, secret] of Object.entries(systems)) {
    if (
      timingSafeEqual(
        digest,
        createHash('sha256')
          .update(secret as string)
          .digest(),
      )
    )
      return system;
  }
  throw new UnauthorizedException('Invalid integration credential');
}

/** Dedicated credentials never authenticate against the general API or the events socket. */
@Injectable()
export class IntegrationSessionGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    @InjectRepository(Session, 'data') private readonly sessions: Repository<Session>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const response = context.switchToHttp().getResponse<{ setHeader: (name: string, value: string) => void }>();
    response.setHeader('Cache-Control', 'private, no-store');
    const request = context.switchToHttp().getRequest<IntegrationRequest>();
    request.integrationSystem = integrationSystemForToken(
      this.config.get<string>('INTEGRATION_SYSTEMS'),
      bearerToken(request.headers.authorization),
    );
    const id = request.params.sessionId;
    if (id) {
      if (typeof id !== 'string' || !isUUID(id)) throw new BadRequestException('Invalid session id');
      const session = await this.sessions.findOne({ where: { id, sourceSystem: request.integrationSystem } });
      // A guessed id never reveals whether another system owns it.
      if (!session) throw new NotFoundException('Session not found');
    }
    return true;
  }
}
