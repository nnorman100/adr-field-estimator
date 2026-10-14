"""TCP proxy that delays every client connection's first byte forwarding by DELAY seconds."""
import socket, sys, threading, time
LISTEN, TARGET, DELAY = int(sys.argv[1]), int(sys.argv[2]), float(sys.argv[3])
def pipe(a, b, delay=0):
    try:
        while (d := a.recv(65536)):
            time.sleep(delay); b.sendall(d)
    except OSError: pass
    finally:
        for x in (a, b):
            try: x.shutdown(socket.SHUT_RDWR)
            except OSError: pass
def handle(c):
    u = socket.create_connection(('127.0.0.1', TARGET))
    threading.Thread(target=pipe, args=(c, u, DELAY), daemon=True).start(); pipe(u, c)
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', LISTEN)); s.listen(50); print('ready', flush=True)
while True:
    c, _ = s.accept(); threading.Thread(target=handle, args=(c,), daemon=True).start()
