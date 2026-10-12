"""Forwards to the Auth emulator and logs every Identity Toolkit accounts:lookup (the revocation check)."""
import sys,time,urllib.request,urllib.error
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
UP='http://127.0.0.1:9419'; LOG=open(sys.argv[1],'a',buffering=1)
class H(BaseHTTPRequestHandler):
    def _go(self):
        body=self.rfile.read(int(self.headers.get('Content-Length') or 0)) or None
        if 'accounts:lookup' in self.path: LOG.write(f'{time.time():.3f} LOOKUP {self.path}\n')
        req=urllib.request.Request(UP+self.path,data=body,method=self.command,headers={k:v for k,v in self.headers.items() if k.lower()!='host'})
        try: r=urllib.request.urlopen(req); code=r.status; data=r.read(); hdrs=r.headers
        except urllib.error.HTTPError as e: code=e.code; data=e.read(); hdrs=e.headers
        self.send_response(code)
        for k,v in hdrs.items():
            if k.lower() not in ('transfer-encoding','connection','content-length'): self.send_header(k,v)
        self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
    do_GET=do_POST=do_PUT=do_DELETE=do_PATCH=_go
    def log_message(self,*a): pass
ThreadingHTTPServer(('127.0.0.1',9420),H).serve_forever()
