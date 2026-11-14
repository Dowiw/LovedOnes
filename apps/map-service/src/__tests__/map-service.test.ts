import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FastifyInstance } from 'fastify';
import { createMapServer } from '../index.js';

describe('@loved-ones/map-service', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const tilesDir = path.resolve(__dirname, '../../../../infra/tiles');
    const created = await createMapServer({
      tilesDir,
      disableFileLog: true,
      disableRedisLog: true,
    });
    app = created.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves style.json and supports HTTP 206 Range requests on region.pmtiles', async () => {
    const styleRes = await app.inject({
      method: 'GET',
      url: '/tiles/style.json',
    });
    expect(styleRes.statusCode).toBe(200);
    expect(styleRes.headers['accept-ranges']).toBe('bytes');
    expect(styleRes.json().name).toBe('LovedOnes Vector Style');

    const rangeRes = await app.inject({
      method: 'GET',
      url: '/tiles/region.pmtiles',
      headers: {
        Range: 'bytes=0-7',
      },
    });
    expect(rangeRes.statusCode).toBe(206);
    expect(rangeRes.headers['accept-ranges']).toBe('bytes');
    expect(rangeRes.headers['content-range']).toMatch(/^bytes 0-7\/\d+$/);
    expect(rangeRes.rawPayload.subarray(0, 7).toString('utf8')).toBe('PMTiles');
  });
});
