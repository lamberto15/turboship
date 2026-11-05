import http from 'node:http';
http.createServer((_req, res) => res.end('ok')).listen(3000);
