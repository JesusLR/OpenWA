import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { IntegrationSessionController } from './integration-session.controller';
import { IntegrationSessionGuard, integrationSystemForToken } from './integration-session.guard';
import { Session, SessionStatus } from './entities/session.entity';
import { SessionService } from './session.service';
import { AuditService } from '../audit/audit.service';
import { applyGlobalValidation } from '../../config/app-validation';
import { AddSessionSourceSystem1786900000000 } from '../../database/migrations/1786900000000-AddSessionSourceSystem';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const SYSTEMS = JSON.stringify({ de_viaje_en_viaje: KEY_A, otro_sistema: KEY_B });

describe('Isolated system session integrations', () => {
  let app: INestApplication<App>;
  let records: Map<string, Session>;
  let credentials: string;
  let a: Session, b: Session;
  let calls: string[];

  beforeEach(async () => {
    records = new Map();
    calls = [];
    credentials = SYSTEMS;
    const make = (sourceSystem: string | null, name = 'recepcion') => {
      const row = Object.assign(new Session(), {
        id: randomUUID(),
        name,
        sourceSystem,
        status: SessionStatus.CREATED,
        createdAt: new Date(),
        updatedAt: new Date(),
        config: {},
      });
      records.set(row.id, row);
      return row;
    };
    a = make('de_viaje_en_viaje');
    b = make('otro_sistema');
    make(null, 'legacy');
    const service = {
      engineLoaded: () => false,
      create: (dto: { name: string }, source: string) => Promise.resolve(make(source, dto.name)),
      findOne: (id: string) => Promise.resolve(records.get(id)),
      start: (id: string) => {
        calls.push('start:' + id);
        const row = records.get(id)!;
        row.status = SessionStatus.QR_READY;
        return Promise.resolve(row);
      },
      getQRCode: (id: string) => {
        calls.push('qr:' + id);
        return Promise.resolve({ status: SessionStatus.QR_READY, qrCode: 'data:image/png;base64,AAAA' });
      },
      logout: (id: string) => {
        calls.push('logout:' + id);
        return Promise.resolve(records.get(id));
      },
      delete: (id: string) => {
        calls.push('delete:' + id);
        records.delete(id);
        return Promise.resolve();
      },
    };
    const repo = {
      find: ({ where }: { where: { sourceSystem: string } }) =>
        Promise.resolve([...records.values()].filter(row => row.sourceSystem === where.sourceSystem)),
      findOne: ({ where }: { where: { id: string; sourceSystem: string } }) =>
        Promise.resolve(
          [...records.values()].find(row => row.id === where.id && row.sourceSystem === where.sourceSystem) ?? null,
        ),
    };
    const module = await Test.createTestingModule({
      controllers: [IntegrationSessionController],
      providers: [
        IntegrationSessionGuard,
        { provide: ConfigService, useValue: { get: () => credentials } },
        { provide: getRepositoryToken(Session, 'data'), useValue: repo },
        { provide: SessionService, useValue: service },
        { provide: AuditService, useValue: { logInfo: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    app = module.createNestApplication<App>();
    applyGlobalValidation(app);
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('authenticates every endpoint and fails closed on missing/malformed configuration', async () => {
    await request(app.getHttpServer()).get('/api/integrations/sessions').expect(401);
    await request(app.getHttpServer()).get('/api/integrations/sessions').auth('wrong', { type: 'bearer' }).expect(401);
    credentials = '{}';
    await request(app.getHttpServer()).get('/api/integrations/sessions').auth(KEY_A, { type: 'bearer' }).expect(503);
    expect(() => integrationSystemForToken(JSON.stringify({ one: KEY_A, two: KEY_A }), KEY_A)).toThrow();
  });

  it('lists only the authenticated system, ignoring a spoofed source header', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/integrations/sessions')
      .auth(KEY_A, { type: 'bearer' })
      .set('X-Source-System', 'otro_sistema')
      .expect(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect((res.body as { sourceSystem: string }).sourceSystem).toBe('de_viaje_en_viaje');
    expect((res.body as { sessions: Array<{ id: string }> }).sessions.map((row: { id: string }) => row.id)).toEqual([
      a.id,
    ]);
    const other = await request(app.getHttpServer())
      .get('/api/integrations/sessions')
      .auth(KEY_B, { type: 'bearer' })
      .expect(200);
    expect((other.body as { sessions: Array<{ id: string }> }).sessions.map((row: { id: string }) => row.id)).toEqual([
      b.id,
    ]);
  });

  it('records the trusted origin, namespaces names and refuses body-based origin changes', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/integrations/sessions')
      .auth(KEY_A, { type: 'bearer' })
      .send({ name: 'ventas' })
      .expect(201);
    expect((res.body as { sourceSystem: string }).sourceSystem).toBe('de_viaje_en_viaje');
    expect((res.body as { name: string }).name).toBe('de-viaje-en-viaje--ventas');
    await request(app.getHttpServer())
      .post('/api/integrations/sessions')
      .auth(KEY_A, { type: 'bearer' })
      .send({ name: 'ventas', sourceSystem: 'otro_sistema' })
      .expect(400);
  });

  it('denies foreign and unassigned ids before QR or any lifecycle operation runs', async () => {
    for (const id of [b.id, [...records.values()].find(row => row.sourceSystem === null)!.id]) {
      await request(app.getHttpServer())
        .get('/api/integrations/sessions/' + id)
        .auth(KEY_A, { type: 'bearer' })
        .expect(404);
      await request(app.getHttpServer())
        .get('/api/integrations/sessions/' + id + '/qr')
        .auth(KEY_A, { type: 'bearer' })
        .expect(404);
      for (const op of ['start', 'logout'])
        await request(app.getHttpServer())
          .post('/api/integrations/sessions/' + id + '/' + op)
          .auth(KEY_A, { type: 'bearer' })
          .expect(404);
      await request(app.getHttpServer())
        .delete('/api/integrations/sessions/' + id)
        .auth(KEY_A, { type: 'bearer' })
        .expect(404);
    }
    expect(calls).toEqual([]);
    await request(app.getHttpServer())
      .post('/api/integrations/sessions/' + a.id + '/start')
      .auth(KEY_A, { type: 'bearer' })
      .expect(200);
    const qr = await request(app.getHttpServer())
      .get('/api/integrations/sessions/' + a.id + '/qr')
      .auth(KEY_A, { type: 'bearer' })
      .expect(200);
    expect((qr.body as { qrCode: string }).qrCode).toBe('data:image/png;base64,AAAA');
    await request(app.getHttpServer())
      .post('/api/integrations/sessions/' + a.id + '/logout')
      .auth(KEY_A, { type: 'bearer' })
      .expect(200);
    await request(app.getHttpServer())
      .delete('/api/integrations/sessions/' + a.id)
      .auth(KEY_A, { type: 'bearer' })
      .expect(204);
    expect(records.has(a.id)).toBe(false);
  });
});

describe('Session source-system migration', () => {
  it('preserves existing sessions and can run twice', async () => {
    const db = new DataSource({ type: 'better-sqlite3', database: ':memory:' });
    await db.initialize();
    try {
      await db.query('CREATE TABLE sessions (id varchar PRIMARY KEY, name varchar NOT NULL)');
      await db.query("INSERT INTO sessions (id, name) VALUES ('legacy', 'Existing session')");
      const runner = db.createQueryRunner(),
        migration = new AddSessionSourceSystem1786900000000();
      await migration.up(runner);
      await migration.up(runner);
      expect(await runner.query('SELECT name, "sourceSystem" FROM sessions')).toEqual([
        { name: 'Existing session', sourceSystem: null },
      ]);
      await runner.release();
    } finally {
      await db.destroy();
    }
  });
});
