'use strict';
// PLACEHOLDER, NOT THE LIVE RELAY. The app root needs a digest-pinned image to create the
// dryscope-live-<env> Cloud Run service; stage S7 replaces this with the real Node relay. It answers
// every request with 503 and a fixed message, holds no state and reads no data or secrets.
const http = require('node:http');

const port = Number(process.env.PORT || 8080);
const body = JSON.stringify({ status: 'not_built', detail: 'The Live relay arrives in stage S7.' });

http
  .createServer((req, res) => {
    req.resume();
    res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
  })
  .listen(port, '0.0.0.0');
