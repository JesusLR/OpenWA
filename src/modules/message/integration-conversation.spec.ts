import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { randomUUID } from 'crypto';
import { IntegrationConversationController } from './integration-conversation.controller';
import { IntegrationSessionGuard } from '../session/integration-session.guard';
import { Session, SessionStatus } from '../session/entities/session.entity';
import { SessionService } from '../session/session.service';
import { MessageService } from './message.service';
import { SendIdempotencyInterceptor } from './idempotency/send-idempotency.interceptor';
import { SendIdempotencyService } from './idempotency/send-idempotency.service';
import { applyGlobalValidation } from '../../config/app-validation';

describe('Isolated PDF document sends', () => {
  let app: INestApplication<App>, own: string, foreign: string;
  const key = 'a'.repeat(64);
  const send = jest.fn();
  const payload = { chatId: '529991234567@c.us', text: 'Respuesta de prueba' };
  beforeEach(async () => {
    own = randomUUID();
    foreign = randomUUID();
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
      controllers: [IntegrationConversationController],
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
            listChats: () =>
              Promise.resolve([
                { id: payload.chatId, name: 'Cliente', isGroup: false },
                { id: '123@g.us', isGroup: true },
              ]),
            findOne: () => Promise.resolve({ status: SessionStatus.READY }),
          },
        },
        {
          provide: MessageService,
          useValue: {
            sendText: send,
            getMessages: () =>
              Promise.resolve({
                total: 1,
                messages: [{ id: '1', body: 'Hola', direction: 'incoming', type: 'document', metadata: { secret: 'private', media: { filename: 'Comprobante.pdf', mimetype: 'application/pdf' } } }],
              }),
          },
        },
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
  const endpoint = (id: string) => '/api/integrations/sessions/' + id + '/conversations';
  it('fences session origin on reads and sends', async () => {
    await request(app.getHttpServer()).get(endpoint(own)).expect(401);
    await request(app.getHttpServer()).get(endpoint(foreign)).auth(key, { type: 'bearer' }).expect(404);
    await request(app.getHttpServer())
      .post(endpoint(foreign) + '/text')
      .auth(key, { type: 'bearer' })
      .send(payload)
      .expect(404);
    expect(send).not.toHaveBeenCalled();
  });
  it('filters groups and returns only projected history', async () => {
    const chats = await request(app.getHttpServer()).get(endpoint(own)).auth(key, { type: 'bearer' }).expect(200);
    expect(chats.body).toHaveLength(1);
    const history = await request(app.getHttpServer())
      .get(endpoint(own) + '/messages')
      .query({ chatId: payload.chatId })
      .auth(key, { type: 'bearer' })
      .expect(200);
    expect(JSON.stringify(history.body)).not.toContain('secret');
    expect(JSON.stringify(history.body)).toContain('Comprobante.pdf');
    await request(app.getHttpServer())
      .get(endpoint(own) + '/messages')
      .query({ chatId: '123@g.us' })
      .auth(key, { type: 'bearer' })
      .expect(400);
  });
  it('validates text and replays an intent only once', async () => {
    const token = randomUUID();
    for (let i = 0; i < 2; i++)
      await request(app.getHttpServer())
        .post(endpoint(own) + '/text')
        .auth(key, { type: 'bearer' })
        .set('Idempotency-Key', token)
        .send(payload)
        .expect(201);
    expect(send).toHaveBeenCalledTimes(1);
    await request(app.getHttpServer())
      .post(endpoint(own) + '/text')
      .auth(key, { type: 'bearer' })
      .send({ ...payload, text: '' })
      .expect(400);
  });
});
