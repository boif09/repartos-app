import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUserList, resolveUser } from '../src/auth.js';

function fakeRequest(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers };
}

test('parseUserList normaliza y descarta vacíos', () => {
  assert.deepEqual(parseUserList(' Xavi, judit ,,'), ['xavi', 'judit']);
  assert.deepEqual(parseUserList(undefined), []);
});

test('Remote-User solo se acepta desde local (nginx)', () => {
  assert.equal(resolveUser(fakeRequest('127.0.0.1', { 'remote-user': 'xavi' })), 'xavi');
  assert.equal(resolveUser(fakeRequest('::ffff:127.0.0.1', { 'remote-user': 'Judit' })), 'judit');
  assert.equal(resolveUser(fakeRequest('203.0.113.7', { 'remote-user': 'xavi' })), null);
  assert.equal(resolveUser(fakeRequest('127.0.0.1')), null);
  assert.equal(resolveUser(fakeRequest('127.0.0.1', { 'remote-user': '' })), null);
});

test('la lista de usuarios permitidos filtra al resto de usuarios de Authelia', () => {
  const allowedUsers = ['xavi', 'judit'];
  assert.equal(resolveUser(fakeRequest('127.0.0.1', { 'remote-user': 'xavi' }), { allowedUsers }), 'xavi');
  assert.equal(resolveUser(fakeRequest('127.0.0.1', { 'remote-user': 'otro' }), { allowedUsers }), null);
});

test('nombres de usuario con caracteres raros se rechazan', () => {
  assert.equal(resolveUser(fakeRequest('127.0.0.1', { 'remote-user': 'xavi<script>' })), null);
  assert.equal(resolveUser(fakeRequest('127.0.0.1', { 'remote-user': 'a'.repeat(65) })), null);
});

test('el usuario de desarrollo simula Authelia y la cabecera real tiene prioridad', () => {
  assert.equal(resolveUser(fakeRequest('203.0.113.7'), { devUser: 'xavi' }), 'xavi');
  assert.equal(resolveUser(fakeRequest('127.0.0.1', { 'remote-user': 'judit' }), { devUser: 'xavi' }), 'judit');
  assert.equal(resolveUser(fakeRequest('127.0.0.1'), { devUser: 'otro', allowedUsers: ['xavi'] }), null);
});
