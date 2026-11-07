import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createCipheriv, createHash, randomBytes, webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deriveWorkspaceKey, newWorkspace, newSalt, sealWorkspace, openWorkspace, portableBackup, digest, b64 } from '../browser/workspace-crypto.mjs';

// Actual desktop vault/online code, not a second reimplementation of its format.
const require = createRequire(import.meta.url);
const desktopRoot = path.resolve(import.meta.dirname, '../../.runtime/beta-free-release');
const { Vault } = require(path.join(desktopRoot, 'src/vault.cjs'));
const { seal, unseal, Online } = require(path.join(desktopRoot, 'src/online.cjs'));
const { envelope: validateDesktopEnvelope } = require(path.join(desktopRoot, 'src/online-server.cjs'));
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
const password = 'disposable-cross-runtime-passphrase';
let directory, vault, salt, key, original;
const extraVaults = [];
before(async () => {
  directory = mkdtempSync(path.join(tmpdir(), 'raw-webcrypto-'));
  vault = new Vault(path.join(directory, 'desktop.sqlite'));
  await vault.create('Private fixture café 漢字', password);
  vault.project('Preserved project', 'Line one\nLine two — £42');
  vault.change('fixture', 'private', state => {
    state.messages.push({ id: 'message-one', role: 'user', content: 'PRIVATE_CONVERSATION_😀', status: 'complete' });
    state.providerSecrets = { openai: 'PRIVATE_PROVIDER_CREDENTIAL' };
    state.mailSecrets = { fixture: 'PRIVATE_MAIL_CREDENTIAL' };
  });
  original = structuredClone(vault.require().state);
  salt = Buffer.from(vault.db.prepare('SELECT salt FROM vaults WHERE id=?').get(vault.session.id).salt).toString('base64');
  key = await deriveWorkspaceKey(password, salt);
});
after(() => {
  for (const v of extraVaults) v.close();
  vault?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});
function device(name) { const result = new Vault(path.join(directory, name + '.sqlite')); extraVaults.push(result); return result; }
function encryptRaw(value, aad) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', vault.require().key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), body };
}
function envelopeWith(overrideState = {}, overrideBackup = {}, overrideEnvelope = {}) {
  const state = { ...structuredClone(original), ...overrideState };
  const inner = encryptRaw(state);
  const backup = { format: 'raw-encrypted-workspace', version: 1, id: state.id, label: state.label, salt, payload: Buffer.concat([inner.iv, inner.tag, inner.body]).toString('base64'), ...overrideBackup };
  const outerId = overrideEnvelope.id ?? state.id, revision = overrideEnvelope.revision ?? 7;
  const outer = encryptRaw(backup, outerId + '|' + revision);
  return { format: 'raw-online-encrypted', version: 1, id: outerId, revision, salt, iv: outer.iv.toString('base64'), tag: outer.tag.toString('base64'), data: outer.body.toString('base64'), ...overrideEnvelope };
}
test('actual desktop seal opens in browser with the same records, non-exportable key and no provider/mail secrets', async () => {
  const encrypted = seal(vault, 3);
  const opened = await openWorkspace(encrypted, key);
  assert.equal(opened.id, original.id); assert.equal(opened.label, original.label);
  assert.deepEqual(opened.projects, original.projects); assert.deepEqual(opened.messages, original.messages);
  assert.equal(opened.providerSecrets, undefined); assert.equal(opened.mailSecrets, undefined);
  assert.equal(key.extractable, false); await assert.rejects(crypto.subtle.exportKey('raw', key));
  assert.doesNotMatch(JSON.stringify(encrypted), /PRIVATE_CONVERSATION|PRIVATE_PROVIDER|PRIVATE_MAIL|Preserved project/);
  // Older valid desktop uploads may contain keys: opening strips them as well.
  const legacy = await openWorkspace(seal(vault, 4, vault.backup()), key);
  assert.equal(legacy.providerSecrets, undefined); assert.equal(legacy.mailSecrets, undefined);
});
test('browser seal is accepted by real desktop validation, decryption and non-overwriting vault restore', async () => {
  const state = structuredClone(original); state.projects[0].description = 'Browser change — kept safely';
  const before = structuredClone(state), encrypted = await sealWorkspace(state, key, salt, 5);
  validateDesktopEnvelope(encrypted);
  const backup = await unseal(encrypted, password), target = device('browser-restored');
  await target.restore(backup, password);
  assert.equal(target.snapshot().projects[0].description, 'Browser change — kept safely');
  assert.equal(target.require().state.providerSecrets, undefined); assert.equal(target.require().state.mailSecrets, undefined);
  assert.deepEqual(state, before, 'sealing must not mutate the caller’s records');
  assert.deepEqual(vault.require().state, original, 'the source desktop remains untouched');
  target.lock(); await assert.rejects(target.restore(backup, password), /already exists/);
});
test('portable browser backup restores into the desktop with no plaintext credentials', async () => {
  const backup = await portableBackup(original, key, salt), target = device('portable');
  await target.restore(backup, password);
  assert.deepEqual(target.snapshot().messages, original.messages);
  assert.equal(target.require().state.providerSecrets, undefined); assert.equal(target.require().state.mailSecrets, undefined);
  assert.doesNotMatch(backup, /PRIVATE_CONVERSATION|PRIVATE_PROVIDER|PRIVATE_MAIL/);
});
test('wrong passphrase and substitutions of ciphertext, tag, id, revision and salt fail closed', async () => {
  const encrypted = seal(vault, 8), wrong = await deriveWorkspaceKey('wrong-disposable-passphrase', salt);
  await assert.rejects(openWorkspace(encrypted, wrong));
  for (const field of ['data', 'tag']) {
    const decoded = Buffer.from(encrypted[field], 'base64'); decoded[0] ^= 1;
    await assert.rejects(openWorkspace({ ...encrypted, [field]: decoded.toString('base64') }, key));
  }
  for (const altered of [{ id: crypto.randomUUID() }, { revision: 9 }, { salt: newSalt() }]) await assert.rejects(openWorkspace({ ...encrypted, ...altered }, key));
  assert.deepEqual(vault.require().state, original);
});
test('valid encryption cannot conceal mismatched inner identities, salt, label or unsupported schema', async () => {
  for (const [state, backup] of [
    [{}, { id: crypto.randomUUID() }], [{}, { salt: newSalt() }], [{}, { label: 'Changed label' }],
    [{ schema: 999 }, {}], [{ messages: {} }, {}], [{ settings: null }, {}]
  ]) await assert.rejects(openWorkspace(envelopeWith(state, backup), key));
});
test('browser-created workspace is desktop-compatible and rejects missing or oversized names', async () => {
  const state = newWorkspace('  New browser workspace  '), ownSalt = newSalt(), ownKey = await deriveWorkspaceKey(password, ownSalt);
  assert.equal(state.label, 'New browser workspace'); assert.match(state.id, /^[a-f0-9-]{36}$/);
  const result = await sealWorkspace(state, ownKey, ownSalt, 1); validateDesktopEnvelope(result);
  const target = device('new-browser'); await target.restore(await unseal(result, password), password);
  assert.equal(target.snapshot().label, state.label);
  for (const name of ['', '  ', 'a'.repeat(81), null]) assert.throws(() => newWorkspace(name));
});
test('desktop restore of browser records revokes imported machine grants without replaying jobs', async () => {
  const state = structuredClone(original);
  state.codingGrants = [{ id: 'foreign-grant', active: true }];
  state.codingJobs = [{ id: 'foreign-job', state: 'applied', history: [], approval: { status: 'consumed' } }];
  const encrypted = await sealWorkspace(state, key, salt, 1), target = device('safe-device');
  const client = new Online(target, path.join(directory, 'bindings.sqlite'), 'http://127.0.0.1:65530');
  try {
    client.auth = { id: 'fixture-account', username: 'fixture', token: 'fixture-only' };
    // Transport is a labelled fixture; restore/revocation is the actual desktop implementation.
    client.request = async route => { assert.equal(route, '/download'); return { revision: 1, envelope: encrypted, digest: createHash('sha256').update(JSON.stringify(encrypted)).digest('hex') }; };
    await client.restore({ id: state.id, password });
    assert.equal(target.require().state.codingGrants[0].active, false);
    assert.equal(target.require().state.codingJobs[0].state, 'blocked');
    assert.equal(target.require().state.codingJobs[0].transferredState, 'applied');
    assert.equal(state.codingGrants[0].active, true);
  } finally { client.auth = null; client.close(); }
});
test('digest matches desktop SHA-256 receipt over the same JSON bytes', async () => {
  const encrypted = seal(vault, 2);
  assert.equal(await digest(encrypted), createHash('sha256').update(JSON.stringify(encrypted)).digest('hex'));
});
test('key derivation rejects invalid passwords and salts before expensive work', async () => {
  for (const value of ['', 'short', 'x'.repeat(257), null]) await assert.rejects(deriveWorkspaceKey(value, salt));
  for (const badSalt of ['', b64(new Uint8Array(31)), b64(new Uint8Array(33)), salt + '\n', { value: salt }]) await assert.rejects(deriveWorkspaceKey(password, badSalt));
});
test('seal refuses invalid schema, identities, settings, array fields, revisions and salts', async () => {
  for (const state of [{ ...original, id: 'bad-id' }, { ...original, schema: 999 }, { ...original, projects: {} }, { ...original, settings: [] }, { ...original, label: 'x'.repeat(81) }]) await assert.rejects(sealWorkspace(state, key, salt, 1));
  for (const revision of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(sealWorkspace(original, key, salt, revision));
  for (const badSalt of ['', salt + '\n', b64(new Uint8Array(31))]) await assert.rejects(sealWorkspace(original, key, badSalt, 1));
});
test('open rejects unsupported inner backup version, invalid UUID and array settings even with authentic ciphertext', async () => {
  await assert.rejects(openWorkspace(envelopeWith({}, { version: 999 }), key));
  await assert.rejects(openWorkspace(envelopeWith({ id: 'bad-id' }), key));
  await assert.rejects(openWorkspace(envelopeWith({ settings: [] }), key));
});
test('non-canonical base64 and oversized ciphertext are refused at the envelope boundary', async () => {
  const encrypted = seal(vault, 1);
  for (const field of ['salt', 'iv', 'tag', 'data']) await assert.rejects(openWorkspace({ ...encrypted, [field]: encrypted[field] + '\n' }, key));
  const large = { ...encrypted, data: Buffer.alloc(9 * 1024 * 1024 + 1).toString('base64') };
  await assert.rejects(openWorkspace(large, key));
  // A browser must not create an upload larger than the desktop service's bounded format.
  const largeState = structuredClone(original); largeState.messages = [{ id: 'large', content: 'x'.repeat(9 * 1024 * 1024) }];
  await assert.rejects(sealWorkspace(largeState, key, salt, 1));
});
test('oversized remote ciphertext is rejected before WebCrypto decryption or large decode work', async () => {
  const encrypted = seal(vault, 1), prior = crypto.subtle.decrypt;
  let calls = 0;
  crypto.subtle.decrypt = function () { calls++; throw Error('Fixture: decryption should not be reached'); };
  try {
    await assert.rejects(openWorkspace({ ...encrypted, data: 'A'.repeat(13 * 1024 * 1024) }, key));
    assert.equal(calls, 0, 'oversized responses must fail at validation, not after invoking decryption');
  } finally { crypto.subtle.decrypt = prior; }
});
test('oversized local records are rejected before WebCrypto encryption', async () => {
  const state = structuredClone(original), prior = crypto.subtle.encrypt;
  state.messages = [{ id: 'oversized', content: 'x'.repeat(9 * 1024 * 1024) }];
  let calls = 0;
  crypto.subtle.encrypt = function () { calls++; throw Error('Fixture: encryption should not be reached'); };
  try {
    await assert.rejects(sealWorkspace(state, key, salt, 1));
    assert.equal(calls, 0, 'oversized local records must be refused before encrypting them');
  } finally { crypto.subtle.encrypt = prior; }
});
