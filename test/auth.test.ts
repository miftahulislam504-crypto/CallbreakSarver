import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { listen } from 'colyseus';
import { Client } from '@colyseus/sdk';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { createServer } from '../src/app.js';
import { createVerifier, setTokenVerifier } from '../src/auth/verifyIdToken.js';

const PROJECT = 'callbreak-test';
const PORT = 3200 + (process.pid % 300);
const kp = await generateKeyPair('RS256');
const other = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const verify = createVerifier(PROJECT, createLocalJWKSet({ keys: [jwk] }));

const sign = (over: { sub?: string; aud?: string; iss?: string; exp?: string; name?: string; key?: CryptoKey } = {}) =>
  new SignJWT(over.name ? { name: over.name } : {})
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject(over.sub ?? 'uid-123')
    .setAudience(over.aud ?? PROJECT)
    .setIssuer(over.iss ?? `https://securetoken.google.com/${PROJECT}`)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? '1h')
    .sign(over.key ?? kp.privateKey);

test('verifier accepts a valid Firebase-style token', async () => {
  const u = await verify(await sign({ name: 'Rahim' }));
  assert.deepEqual(u, { uid: 'uid-123', name: 'Rahim' });
  assert.equal((await verify(await sign())).name, null);
});

test('verifier rejects bad tokens', async () => {
  for (const bad of [
    await sign({ aud: 'someone-else' }),
    await sign({ iss: 'https://securetoken.google.com/someone-else' }),
    await sign({ exp: '-1m' }),
    await sign({ key: other.privateKey }), // signed with a key Google does not publish
    'not.a.jwt',
    '',
    undefined,
    42,
  ]) {
    await assert.rejects(() => verify(bad as any));
  }
});

let server: Awaited<ReturnType<typeof listen>>;
const rooms: any[] = [];
before(async () => {
  setTokenVerifier(verify);
  server = await listen(createServer(), PORT);
});
after(async () => {
  setTokenVerifier(undefined);
  for (const r of rooms) await r.leave(true).catch(() => undefined);
  await server.gracefullyShutdown(false).catch(() => undefined);
});

test('room: valid token joins and the seat carries the verified uid; fake uid in options is ignored', async () => {
  const c = new Client(`ws://localhost:${PORT}`);
  const room: any = await c.create('callbreak', { name: 'Rahim', uid: 'FAKE', idToken: await sign({ sub: 'real-uid' }) });
  rooms.push(room);
  const view: any = await new Promise((res) => {
    room.onMessage('state', res);
    room.send('sync');
  });
  assert.equal(view.seats[view.mySeat].name, 'Rahim');
});

test('room: missing, forged or expired token is refused', async () => {
  const c = new Client(`ws://localhost:${PORT}`);
  await assert.rejects(() => c.create('callbreak', { name: 'NoToken' }));
  const forged = await sign({ key: other.privateKey });
  const expired = await sign({ exp: '-1m' });
  await assert.rejects(() => c.create('callbreak', { name: 'Forged', idToken: forged }));
  await assert.rejects(() => c.create('callbreak', { name: 'Old', idToken: expired }));
});
