/* Minimal RFC 6455 server for routing tests: handshake, masked client frames, text/binary echo and close. */
const crypto = require('node:crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) header = Buffer.from([0x80 | opcode, body.length]);
  else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}
// Accepts WebSocket upgrades for one path on an http.Server and hands each connection to onConnection.
function attachWebSocket(server, pathname, onConnection) {
  server.on('upgrade', (request, socket) => {
    if (new URL(request.url, 'http://localhost').pathname !== pathname) return socket.destroy();
    const accept = crypto
      .createHash('sha1')
      .update(request.headers['sec-websocket-key'] + GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        accept +
        '\r\n\r\n',
    );
    const connection = {
      headers: request.headers,
      send: (text) => socket.write(frame(1, text)),
      sendBinary: (bytes) => socket.write(frame(2, bytes)),
      close: (code = 1000, reason = '') => {
        const body = Buffer.alloc(2 + Buffer.byteLength(reason));
        body.writeUInt16BE(code, 0);
        body.write(reason, 2);
        socket.write(frame(8, body));
      },
      onmessage: null,
      onclose: null,
    };
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f,
          masked = !!(buffer[1] & 0x80);
        let length = buffer[1] & 0x7f,
          offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const mask = masked ? buffer.subarray(offset, offset + 4) : null;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (masked)
          for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
        buffer = buffer.subarray(offset + length);
        if (opcode === 1) connection.onmessage?.(payload.toString('utf8'), false);
        else if (opcode === 2) connection.onmessage?.(payload, true);
        else if (opcode === 8) {
          connection.onclose?.(
            payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
            payload.length > 2 ? payload.subarray(2).toString('utf8') : '',
          );
          socket.write(frame(8, payload));
          socket.end();
        } else if (opcode === 9) socket.write(frame(10, payload));
      }
    });
    socket.on('error', () => {});
    onConnection(connection);
  });
}
module.exports = { attachWebSocket };
