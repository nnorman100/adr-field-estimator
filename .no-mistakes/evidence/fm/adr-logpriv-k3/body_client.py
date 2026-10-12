"""Raw-socket HTTP/1.1 client so each scenario controls headers, chunking, pacing and disconnects."""
import sys,json,socket,time
sys.path.insert(0,sys.argv[1]);PORT=int(sys.argv[2]);WHICH=sys.argv[3:]
from tests.fakes import png
from tests.test_backend import data
AUTH='Authorization: Bearer test-owner\r\n'
def raw(head,chunks=(),pause=0,close_early=False,timeout=30):
    s=socket.create_connection(('127.0.0.1',PORT),timeout=timeout);s.sendall(head.encode())
    try:
        for c in chunks:
            s.sendall(c)
            if pause:time.sleep(pause)
    except (BrokenPipeError,ConnectionResetError): pass
    if close_early: s.close(); return 'client closed mid-body'
    out=b''
    while True:
        try: d=s.recv(65536)
        except socket.timeout: break
        if not d:break
        out+=d
        if b'\r\n\r\n' in out:
            h,_,b=out.partition(b'\r\n\r\n')
            cl=[l for l in h.split(b'\r\n') if l.lower().startswith(b'content-length:')]
            if cl and len(b)>=int(cl[0].split(b':')[1]):break
    s.close();h,_,b=out.partition(b'\r\n\r\n');lines=h.decode().split('\r\n')
    return lines[0]+' | '+' | '.join(l for l in lines[1:] if l.lower().startswith('cache-control'))+' | body='+b.decode(errors='replace')[:140]
def chunked(payload,size):
    parts=[payload[i:i+size] for i in range(0,len(payload),size)]
    return [b'%x\r\n'%len(p)+p+b'\r\n' for p in parts]+[b'0\r\n\r\n']
def post(path,body,extra=''):
    return f'POST {path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n{extra}Content-Length: {len(body)}\r\nConnection: close\r\n\r\n'
def iid(n):return 'ADR-INS-'+f'{n:032x}'
S={}
def scen(f):S[f.__name__]=f;return f
@scen
def create_chunked_many_pieces():
    body=json.dumps({'inspection_id':iid(1),'data':data()}).encode()
    head=f'POST /api/inspections HTTP/1.1\r\nHost: x\r\n{AUTH}Content-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n'
    return f'{len(body)} bytes in 64-byte chunks -> '+raw(head,chunked(body,64))
@scen
def large_photo_upload_above_default_cap():
    raw(post('/api/inspections',b'x'*0)) if False else None
    b=json.dumps({'inspection_id':iid(2),'data':data()}).encode();raw(post('/api/inspections',b,AUTH),[b])
    body=json.dumps(dict(expected_revision=1,photo_id='c'*32,room='Bathroom',captured_at='2026-10-06T19:00:00Z',data_url=png())).encode()
    body=body[:-1]+b' '*(5*1024*1024)+b'}'
    r=raw(post(f'/api/inspections/{iid(2)}/photos',body,AUTH),[body[i:i+65536] for i in range(0,len(body),65536)])
    g=raw(f'GET /api/inspections/{iid(2)} HTTP/1.1\r\nHost: x\r\n{AUTH}Connection: close\r\n\r\n')
    return f'{len(body)} byte photo POST -> {r}\n    GET afterwards -> {g[:200]}'
@scen
def declared_oversize_rejected():
    return raw(post('/api/inspections',b'x'*(2*1024*1024),AUTH).replace('Content-Length: 2097152','Content-Length: 2097152'),[])
@scen
def undeclared_chunked_oversize_rejected():
    head=f'POST /api/inspections HTTP/1.1\r\nHost: x\r\n{AUTH}Content-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n'
    return '1.5 MB chunked, no Content-Length -> '+raw(head,chunked(b'{'+b' '*(1536*1024)+b'}',65536))
@scen
def unauthenticated_post_rejected_before_body():
    head=post('/api/inspections',b'x'*500000)
    return '500 KB declared, body never sent -> '+raw(head,[],timeout=10)
@scen
def invalid_content_length():
    head=f'POST /api/inspections HTTP/1.1\r\nHost: x\r\n{AUTH}Content-Length: +12\r\nConnection: close\r\n\r\n'
    return raw(head,[b'{}'],timeout=10)
@scen
def slow_body_deadline():
    head=f'POST /api/inspections HTTP/1.1\r\nHost: x\r\n{AUTH}Content-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n'
    t=time.time();r=raw(head,chunked(b' '*40,1)[:-1],pause=0.1,timeout=20)
    return f'1 byte/100ms trickle -> {r} after {time.time()-t:.1f}s'
@scen
def disconnect_mid_body_then_healthy():
    b=b'{'+b' '*200000+b'}'
    raw(post('/api/inspections',b,AUTH),[b[:50000]],close_early=True);time.sleep(1)
    return 'after mid-body disconnect, GET /api/inspections -> '+raw(f'GET /api/inspections HTTP/1.1\r\nHost: x\r\n{AUTH}Connection: close\r\n\r\n')[:160]
@scen
def cache_control_headers():
    a=raw(f'GET /api/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
    b=raw(f'GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')
    c=raw(f'GET /api/inspections HTTP/1.1\r\nHost: x\r\n{AUTH}Connection: close\r\n\r\n')
    return f'/api/health -> {a}\n    /health -> {b}\n    GET /api/inspections -> {c[:120]}'
@scen
def get_unaffected_by_body_cap():
    return raw(f'GET /api/inspections HTTP/1.1\r\nHost: x\r\n{AUTH}Connection: close\r\n\r\n')[:160]
for n in (WHICH or S):
    try: print(f'[{n}] {S[n]()}')
    except Exception as e: print(f'[{n}] client error {type(e).__name__}: {e}')
