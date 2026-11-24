import { MonitorError } from './core.js';
import { b64 } from './store.js';
import { hash } from './hash.js';

export function address(value) {
  if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value || '')) throw new MonitorError('config', 'E-posta adresi geçersiz.');
  return value;
}
const encoded = (value) => `=?UTF-8?B?${b64(new TextEncoder().encode(value))}?=`;
const wrapped = (bytes) => b64(bytes).match(/.{1,76}/g)?.join('\r\n') || '';
export function message(config, mail, attachments = []) {
  const from = address(config.smtp.username), to = address(config.to);
  const boundary = `unitakip-${crypto.randomUUID()}`;
  const textPart = `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapped(new TextEncoder().encode(mail.body))}`;
  const files = attachments.map((file) => `Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="${encoded(file.name.replace(/[\r\n]/g, '_'))}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapped(file.bytes)}`);
  return [`From: UniTakip <${from}>`, `To: <${to}>`, `Subject: ${encoded(mail.subject)}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${hash(mail.id || crypto.randomUUID())}@unitakip.local>`, 'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    ...[textPart, ...files].map((part) => `--${boundary}\r\n${part}\r\n`), `--${boundary}--`, ''].join('\r\n');
}

/** Fixed Gmail host, implicit TLS, no raw protocol output or secret logging. */
export async function smtp(connect, config, mail = null, attachments = []) {
  let socket, reader, writer, timer;
  let accepted = false, contentRejected = false;
  try {
    address(config.smtp.username); address(config.to);
    if (!/^[a-zA-Z0-9]{16}$/.test(config.smtp.password || '')) throw new Error();
    socket = connect({ hostname: 'smtp.gmail.com', port: 465 }, { secureTransport: 'on' });
    // Handle rejected close promises even after a timeout closes the socket.
    socket.closed.catch(() => {});
    const expired = new Promise((_, reject) => { timer = setTimeout(() => { socket.close().catch(() => {}); reject(new Error('timeout')); }, 30000); });
    const operation = async () => {
      await socket.opened;
      reader = socket.readable.getReader(); writer = socket.writable.getWriter();
      const decoder = new TextDecoder(); let buffer = '';
      const reply = async (expected) => {
        let code = null;
        for (let lines = 0; lines < 200;) {
          const end = buffer.indexOf('\r\n');
          if (end < 0) {
            const { value, done } = await reader.read();
            if (done) throw new Error();
            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > 64000) throw new Error();
            continue;
          }
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); lines++;
          const parsed = /^(\d{3})([ -])/.exec(line);
          if (!parsed || (code && parsed[1] !== code)) throw new Error();
          code = parsed[1];
          if (parsed[2] === ' ') { if (!expected.includes(Number(code))) throw new Error(); return Number(code); }
        }
        throw new Error();
      };
      const command = async (value, expected) => { await writer.write(new TextEncoder().encode(`${value}\r\n`)); return reply(expected); };
      await reply([220]);
      await command('EHLO unitakip.local', [250]);
      const credentials = b64(new TextEncoder().encode(`\0${config.smtp.username}\0${config.smtp.password}`));
      const auth = await command(`AUTH PLAIN ${credentials}`, [235, 334]);
      if (auth === 334) await command(credentials, [235]);
      if (mail) {
        await command(`MAIL FROM:<${address(config.smtp.username)}>`, [250]);
        await command(`RCPT TO:<${address(config.to)}>`, [250, 251]);
        await command('DATA', [354]);
        const result = await command(`${message(config, mail, attachments).replace(/(^|\r\n)\./g, '$1..')}\r\n.`, [250, 550, 552, 554]);
        if (result !== 250) {
          contentRejected = true;
          throw new Error();
        }
        accepted = true;
      }
      // Delivery is accepted at DATA's 250; a failed QUIT must not undo success.
      await command('QUIT', [221]).catch(() => {});
    };
    await Promise.race([operation(), expired]);
  } catch {
    if (!accepted) {
      const error = new MonitorError('mail', 'Gmail bağlantısı veya gönderimi başarısız; bildirim kuyrukta korunuyor.');
      error.contentRejected = contentRejected;
      throw error;
    }
  }
  finally { clearTimeout(timer); reader?.releaseLock(); writer?.releaseLock(); await socket?.close().catch(() => {}); }
}
