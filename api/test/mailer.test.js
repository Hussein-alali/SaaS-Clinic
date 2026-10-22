'use strict';
// No database: the mailer alone, with both transports.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { createMailer, isValidEmail } = require('../src/mailer');
const { FailureLimiter } = require('../src/auth');

/** Just enough SMTP to accept one plain-text message (no TLS, no auth). */
function fakeSmtpServer() {
  const messages = [];
  const server = net.createServer((socket) => {
    let inData = false;
    let data = '';
    let envelope = { from: null, to: [] };
    let buffer = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ ...envelope, data });
            envelope = { from: null, to: [] };
            data = '';
            socket.write('250 OK queued\r\n');
          } else {
            data += `${line}\n`;
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250-fake\r\n250 8BITMIME\r\n');
        else if (cmd === 'MAIL') {
          envelope.from = line;
          socket.write('250 OK\r\n');
        } else if (cmd === 'RCPT') {
          envelope.to.push(line);
          socket.write('250 OK\r\n');
        } else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (cmd === 'QUIT') {
          socket.end('221 bye\r\n');
        } else socket.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, messages, port: server.address().port })));
}

test('file transport writes one JSON file per message in MAIL_OUTBOX_DIR', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinicsys-outbox-'));
  try {
    const mailer = createMailer({ mailTransport: 'file', mailOutboxDir: dir, mailFrom: 'ClinicSystem <no-reply@clinicsyseg.test>' });
    const r = await mailer.send({ to: 'user@example.com', subject: 'Hello', text: 'Body', html: '<p>Body</p>' });
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.equal(path.join(dir, files[0]), r.file);
    const msg = JSON.parse(fs.readFileSync(r.file, 'utf8'));
    assert.equal(msg.to, 'user@example.com');
    assert.equal(msg.from, 'ClinicSystem <no-reply@clinicsyseg.test>');
    assert.equal(msg.subject, 'Hello');
    assert.equal(msg.text, 'Body');
    assert.equal(msg.html, '<p>Body</p>');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('smtp transport sends through SMTP_* with nodemailer', async () => {
  const { server, messages, port } = await fakeSmtpServer();
  try {
    const mailer = createMailer({
      mailTransport: 'smtp',
      mailFrom: 'no-reply@clinicsyseg.test',
      smtp: { host: '127.0.0.1', port, secure: false, user: '', pass: '' },
    });
    await mailer.send({ to: 'admin@demo-physio.test', subject: 'دعوة', text: 'مرحبا https://demo-physio.clinicsyseg.com/?invite=abc' });
    assert.equal(messages.length, 1);
    assert.match(messages[0].from, /no-reply@clinicsyseg\.test/);
    assert.match(messages[0].to[0], /admin@demo-physio\.test/);
    assert.match(messages[0].data, /Subject: =\?UTF-8\?/);
  } finally {
    server.close();
  }
});

test('recipients must be one plain address (no lists, quotes or comments)', async () => {
  const mailer = createMailer({ mailTransport: 'file', mailOutboxDir: os.tmpdir(), mailFrom: 'x@y.test' });
  for (const to of ['a@b.c, d@e.f', '"quoted"@x.test', 'a@b.c (comment)', 'Name <a@b.c>', 'no-at', `${'a'.repeat(250)}@b.cd`, ['a@b.c'], null]) {
    assert.equal(isValidEmail(to), false, String(to));
    await assert.rejects(mailer.send({ to, subject: 's', text: 't' }), /Invalid recipient/);
  }
  assert.equal(isValidEmail('first.last+tag@sub.clinicsyseg.com'), true);
});

test('FailureLimiter: sliding window per key, retry-after, reset, bounded memory', () => {
  const lim = new FailureLimiter({ max: 3, windowMs: 1000, maxKeys: 5 });
  const t0 = 1_000_000;
  lim.fail('k', t0);
  lim.fail('k', t0 + 100);
  assert.equal(lim.retryAfter('k', t0 + 200), 0);
  lim.fail('k', t0 + 200);
  assert.equal(lim.retryAfter('k', t0 + 300), 1, 'blocked until the oldest failure leaves the window');
  assert.equal(lim.retryAfter('k', t0 + 1001), 0, 'one failure expired');
  lim.reset('k');
  assert.equal(lim.retryAfter('k', t0 + 1001), 0);
  for (let i = 0; i < 20; i++) lim.fail(`key${i}`, t0);
  assert.ok(lim.hits.size <= 5, 'old keys are dropped');
});
