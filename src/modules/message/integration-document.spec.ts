import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomUUID } from 'crypto';
import { IntegrationDocumentController } from './integration-document.controller';
import { IntegrationSessionGuard } from '../session/integration-session.guard';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { SessionService } from '../session/session.service';
import { MessageService } from './message.service';
import { SendIdempotencyInterceptor } from './idempotency/send-idempotency.interceptor';
import { SendIdempotencyService } from './idempotency/send-idempotency.service';
import { applyGlobalValidation } from '../../config/app-validation';

describe('Isolated PDF document sends', () => {
  let app: INestApplication<App>, own: string, foreign: string;
  let connected: boolean;
  const key = 'a'.repeat(64);
  const send = jest.fn();
  const pdf = Buffer.from('%PDF-1.4\nTest PDF\n%%EOF').toString('base64');
  const payload = { phone: '529991234567', base64: pdf, filename: 'Itinerario.pdf' };
  beforeEach(async () => {
    own = randomUUID();
    foreign = randomUUID();
    connected = true;
    send.mockReset().mockResolvedValue({ messageId: 'whatsapp-message-id', timestamp: 1000 });
    const rows = new Map([
      [own, { id: own, sourceSystem: 'de_viaje_en_viaje' }],
      [foreign, { id: foreign, sourceSystem: 'otro_sistema' }],
    ]);
    const claims = new Map<string, { hash: string; body?: unknown }>();
    const store = {
      claim: ({ sessionId, key, requestHash }: { sessionId: string; key: string; requestHash: string }) => {
        const id = sessionId + ':' + key,
          previous = claims.get(id);
        if (previous)
          return Promise.resolve(
            previous.hash !== requestHash ? { kind: 'mismatch' } : { kind: 'replay', body: previous.body },
          );
        claims.set(id, { hash: requestHash });
        return Promise.resolve({ kind: 'claimed', id });
      },
      complete: (id: string, body: unknown) => {
        claims.get(id)!.body = body;
        return Promise.resolve();
      },
      release: (id: string) => {
        claims.delete(id);
        return Promise.resolve();
      },
      markFailed: () => Promise.resolve(),
    };
    const module = await Test.createTestingModule({
      controllers: [IntegrationDocumentController],
      providers: [
        IntegrationSessionGuard,
        SendIdempotencyInterceptor,
        { provide: ConfigService, useValue: { get: () => JSON.stringify({ de_viaje_en_viaje: key }) } },
        {
          provide: getRepositoryToken(Session, 'data'),
          useValue: {
            findOne: ({ where }: { where: { id: string; sourceSystem: string } }) => {
              const row = rows.get(where.id);
              return Promise.resolve(row?.sourceSystem === where.sourceSystem ? row : null);
            },
          },
        },
        {
          provide: SessionService,
          useValue: {
            findOne: () => Promise.resolve({ status: connected ? SessionStatus.READY : SessionStatus.DISCONNECTED }),
          },
        },
        { provide: MessageService, useValue: { sendDocument: send } },
        { provide: SendIdempotencyService, useValue: store },
      ],
    }).compile();
    app = module.createNestApplication<App>();
    applyGlobalValidation(app);
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
  });
  const endpoint = (id: string) => '/api/integrations/sessions/' + id + '/documents';

  it('denies missing credentials and another system session before sending', async () => {
    await request(app.getHttpServer()).post(endpoint(own)).send(payload).expect(401);
    await request(app.getHttpServer()).post(endpoint(foreign)).auth(key, { type: 'bearer' }).send(payload).expect(404);
    expect(send).not.toHaveBeenCalled();
  });

  it('sends only PDFs to an individual phone and replays a repeated intent without a second send', async () => {
    const idempotency = randomUUID();
    const first = await request(app.getHttpServer())
      .post(endpoint(own))
      .auth(key, { type: 'bearer' })
      .set('Idempotency-Key', idempotency)
      .send(payload)
      .expect(201);
    expect((first.body as { id: string }).id).toBe('whatsapp-message-id');
    expect(send).toHaveBeenCalledWith(own, {
      chatId: '529991234567@c.us',
      base64: pdf,
      filename: 'Itinerario.pdf',
      mimetype: 'application/pdf',
      caption: undefined,
    });
    await request(app.getHttpServer())
      .post(endpoint(own))
      .auth(key, { type: 'bearer' })
      .set('Idempotency-Key', idempotency)
      .send(payload)
      .expect(201)
      .expect('Idempotent-Replayed', 'true');
    expect(send).toHaveBeenCalledTimes(1);
    await request(app.getHttpServer())
      .post(endpoint(own))
      .auth(key, { type: 'bearer' })
      .set('Idempotency-Key', idempotency)
      .send({ ...payload, phone: '529991111111' })
      .expect(422);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses non-PDF content, group ids, URLs, invalid filenames and disconnected sessions', async () => {
    for (const invalid of [
      { ...payload, phone: '12345@g.us' },
      { ...payload, phone: '529991234567\n' },
      { ...payload, filename: 'Reporte.pdf\n' },
      { ...payload, filename: '../secreto.pdf' },
      { ...payload, url: 'https://example.com' },
      { ...payload, base64: Buffer.from('<html>Not a PDF</html>').toString('base64') },
    ]) {
      await request(app.getHttpServer()).post(endpoint(own)).auth(key, { type: 'bearer' }).send(invalid).expect(400);
    }
    connected = false;
    await request(app.getHttpServer()).post(endpoint(own)).auth(key, { type: 'bearer' }).send(payload).expect(409);
    expect(send).not.toHaveBeenCalled();
  });
});
