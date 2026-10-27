import { UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import { ServerController } from 'src/controllers/server.controller.js';
import { ServerService } from 'src/services/server.service.js';
import { SystemMetadataService } from 'src/services/system-metadata.service.js';
import { VersionService } from 'src/services/version.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe('server LAN endpoints', () => {
  let ctx: ControllerContext;
  const service = mockBaseService(ServerService);
  const nonce = 'a'.repeat(64);
  const identity = { serverId: 'instance-fingerprint', proof: 'challenge-proof' };

  beforeAll(async () => {
    ctx = await controllerSetup(ServerController, [
      { provide: ServerService, useValue: service },
      { provide: SystemMetadataService, useValue: {} },
      { provide: VersionService, useValue: {} },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  it('does not disclose candidates to unauthenticated callers', async () => {
    ctx.authenticate.mockRejectedValue(new UnauthorizedException());
    const { status } = await request(ctx.getHttpServer()).get('/server/lan-candidates').query({ nonce });
    expect(status).toBe(401);
    expect(service.getLanCandidates).not.toHaveBeenCalled();
  });

  it('returns authenticated candidates without caching', async () => {
    service.getLanCandidates.mockResolvedValue({ ...identity, urls: ['https://photos.lan'] });
    const { status, body, headers } = await request(ctx.getHttpServer()).get('/server/lan-candidates').query({ nonce });
    expect(status).toBe(200);
    expect(body).toEqual({ ...identity, urls: ['https://photos.lan'] });
    expect(headers['cache-control']).toBe('no-store');
    expect(ctx.authenticate).toHaveBeenCalled();
  });

  it('allows credential-free identity probes without returning addresses', async () => {
    service.getServerIdentity.mockResolvedValue(identity);
    const { status, body } = await request(ctx.getHttpServer()).get('/server/identity').query({ nonce });
    expect(status).toBe(200);
    expect(body).toEqual(identity);
    expect(ctx.authenticate).not.toHaveBeenCalled();
  });

  it.each([undefined, 'short', 'z'.repeat(64), 'a'.repeat(65)])('rejects invalid nonce %s', async (nonce) => {
    const { status } = await request(ctx.getHttpServer()).get('/server/identity').query({ nonce });
    expect(status).toBe(400);
    expect(service.getServerIdentity).not.toHaveBeenCalled();
  });
});
