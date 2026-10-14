"""Drive invitation delivery end-to-end against the real backend + Firebase emulators + local SMTP."""
import json, os, subprocess, sys, time, urllib.request, urllib.error, email, uuid
from email import policy
ROOT = '/home/nnorm/.no-mistakes/worktrees/e9831d793e9a/01M4XJ47EVQYQQSFEQ6CAF9QD1'
PY = '/tmp/nm-smtp-test/venv/bin/python'
H = '/tmp/nm-smtp-test/harness'
AUTH = '127.0.0.1:19099'; FS = '127.0.0.1:18080'
PROJECT = 'alert-disaster-field-2026'
EVID = sys.argv[2]
SENDER = 'ADR Invitations <synthetic.sender@example.invalid>'

def req(method, url, body=None, headers=None, timeout=150):
    r = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method,
                               headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b'null')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'null')

def auth_rest(path, body):
    return req('POST', f'http://{AUTH}/identitytoolkit.googleapis.com/v1/{path}?key=fake', body)[1]

def admin_user():
    em = f'superadmin-{uuid.uuid4().hex[:8]}@example.invalid'
    r = auth_rest('accounts:signUp', {'email': em, 'password': 'synthetic-pass-1', 'returnSecureToken': True})
    uid = r['localId']
    req('POST', f'http://{AUTH}/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:update',
        {'localId': uid, 'emailVerified': True}, {'Authorization': 'Bearer owner'})
    tok = auth_rest('accounts:signInWithPassword', {'email': em, 'password': 'synthetic-pass-1', 'returnSecureToken': True})['idToken']
    req('PATCH', f'http://{FS}/v1/projects/{PROJECT}/databases/(default)/documents/_platform_admins/{uid}',
        {'fields': {'active': {'booleanValue': True}}}, {'Authorization': 'Bearer owner'})
    return uid, tok

def lookup_user(em):
    s, r = req('POST', f'http://{AUTH}/identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:lookup',
               {'email': [em]}, {'Authorization': 'Bearer owner'})
    return r.get('users', []) if r else []

def fs_doc(path):
    s, r = req('GET', f'http://{FS}/v1/projects/{PROJECT}/databases/(default)/documents/{path}', None, {'Authorization': 'Bearer owner'})
    return {k: list(v.values())[0] for k, v in r.get('fields', {}).items()} if s == 200 else None

def wait_ready(proc, port=None):
    if port:
        for _ in range(100):
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{port}/api/health', timeout=1)
                return
            except urllib.error.HTTPError:
                return
            except Exception:
                time.sleep(0.3)
        raise RuntimeError('backend did not start')
    proc.stdout.readline()

def scenario(name, transport_env, smtp_mode='normal', auth_delay=None, resend=False):
    tag = name
    smtp_port, api_port = 2587, 18765
    smtp_log = f'{EVID}/{tag}-smtp-server.jsonl'
    open(smtp_log, 'w').close()
    procs = []
    smtp = subprocess.Popen([PY, f'{H}/smtp_server.py', str(smtp_port), smtp_mode, smtp_log], stdout=subprocess.PIPE, text=True)
    procs.append(smtp); wait_ready(smtp)
    auth_host = AUTH
    if auth_delay:
        px = subprocess.Popen([PY, f'{H}/slow_proxy.py', '19100', '19099', str(auth_delay)], stdout=subprocess.PIPE, text=True)
        procs.append(px); wait_ready(px); auth_host = '127.0.0.1:19100'
    env = {k: v for k, v in os.environ.items() if not k.startswith(('INVITATION_', 'RESEND_', 'GOOGLE_APPLICATION'))}
    env.update(ADR_ROOT=ROOT, TEST_SMTP_PORT=str(smtp_port), TEST_API_PORT=str(api_port), WORKSPACES_ENABLED='true',
               GOOGLE_CLOUD_PROJECT=PROJECT, FIRESTORE_EMULATOR_HOST=FS, FIREBASE_AUTH_EMULATOR_HOST=AUTH,
               STORAGE_EMULATOR_HOST='http://127.0.0.1:19199', SSL_CERT_FILE='/tmp/nm-smtp-test/cert.pem', APPCHECK_MODE='off')
    env.update(transport_env)
    # Backend uses the (possibly slow) auth host only for invitation account provisioning; token verification also goes through it.
    env['FIREBASE_AUTH_EMULATOR_HOST'] = auth_host
    be = subprocess.Popen([PY, f'{H}/run_backend.py'], env=env, stdout=open(f'{EVID}/{tag}-backend.log', 'w'), stderr=subprocess.STDOUT)
    procs.append(be)
    try:
        wait_ready(be, api_port)
        uid, tok = admin_user()
        hdr = {'Authorization': 'Bearer ' + tok, 'X-ADR-Workspace-Protocol': '1', 'Origin': 'https://alert-disaster-field-2026.web.app'}
        owner = f'invitee-{uuid.uuid4().hex[:8]}@example.invalid'
        t0 = time.time()
        status, body = req('POST', f'http://127.0.0.1:{api_port}/api/admin/companies', {'name': 'Synthetic Restoration Co', 'owner_email': owner}, hdr)
        elapsed = time.time() - t0
        result = {'scenario': name, 'transport_env': {k: ('<synthetic>' if 'PASSWORD' in k else v) for k, v in transport_env.items()},
                  'http_status': status, 'elapsed_s': round(elapsed, 2)}
        inv = (body or {}).get('invitation') or {}
        result['api_invitation'] = {k: inv.get(k) for k in ('delivery_status', 'delivery_error', 'message_id', 'send_attempt', 'email', 'role')}
        if inv.get('invitation_id'):
            d = fs_doc('_invitations/' + inv['invitation_id'])
            result['firestore_invitation'] = {k: d.get(k) for k in ('delivery_status', 'delivery_error', 'message_id', 'send_attempt', 'send_started')} if d else None
            if d: result['seconds_from_reservation_to_response'] = round(t0 + elapsed - float(d['send_started']), 2)
        result['invitee_account_provisioned'] = bool(lookup_user(owner))
        if resend and inv.get('invitation_id'):
            cid = body['company']['company_id']
            s2, b2 = req('POST', f'http://127.0.0.1:{api_port}/api/companies/{cid}/invitations/{inv["invitation_id"]}/resend', {}, hdr)
            result['resend'] = {'http_status': s2, **{k: (b2 or {}).get(k) for k in ('delivery_status', 'message_id', 'send_attempt')}}
        time.sleep(0.5)
        events = [json.loads(l) for l in open(smtp_log)]
        result['smtp_events'] = [{k: v for k, v in e.items() if k != 'data'} for e in events]
        delivered = [e for e in events if e['event'] == 'delivered']
        result['delivered_count'] = len(delivered)
        msgs = []
        for e in delivered:
            m = email.message_from_string(e['data'], policy=policy.default)
            text = m.get_body(('plain',)).get_content()
            html = m.get_body(('html',)).get_content()
            link_lines = [l for l in text.splitlines() if 'http' in l]
            msgs.append({'From': m['From'], 'To': m['To'], 'Subject': m['Subject'], 'Message-ID': m['Message-ID'],
                         'has_html_part': bool(html), 'accept_link_ok': ('?invite=' + inv.get('invitation_id', 'x')) in text,
                         'has_password_setup_link': any('oobCode=' in l for l in link_lines),
                         'text_body': text.replace(text[text.find('oobCode='):text.find('&', text.find('oobCode='))] if 'oobCode=' in text else '', 'oobCode=<redacted>')})
        result['messages'] = msgs
        return result
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            try: p.wait(5)
            except Exception: p.kill()

if __name__ == '__main__':
    smtp_env = {'INVITATION_TRANSPORT': 'smtp', 'INVITATION_FROM': SENDER,
                'INVITATION_SMTP_USERNAME': 'synthetic.sender@example.invalid', 'INVITATION_SMTP_PASSWORD': 'synthetic-app-password'}
    which = sys.argv[1]
    S = {
     'smtp-happy': lambda: scenario('smtp-happy', smtp_env, resend=True),
     'unset-defaults-resend': lambda: scenario('unset-defaults-resend', {k: v for k, v in smtp_env.items() if k != 'INVITATION_TRANSPORT'}),
     'empty-defaults-resend': lambda: scenario('empty-defaults-resend', {**smtp_env, 'INVITATION_TRANSPORT': ''}),
     'uppercase-SMTP-rejected': lambda: scenario('uppercase-SMTP-rejected', {**smtp_env, 'INVITATION_TRANSPORT': 'SMTP'}),
     'padded-smtp-rejected': lambda: scenario('padded-smtp-rejected', {**smtp_env, 'INVITATION_TRANSPORT': ' smtp '}),
     'smtp-missing-password': lambda: scenario('smtp-missing-password', {k: v for k, v in smtp_env.items() if k != 'INVITATION_SMTP_PASSWORD'}),
     'smtp-wrong-password': lambda: scenario('smtp-wrong-password', {**smtp_env, 'INVITATION_SMTP_PASSWORD': 'wrong-synthetic'}),
     'smtp-transient-retry': lambda: scenario('smtp-transient-retry', smtp_env, smtp_mode='transient'),
     'smtp-hang-deadline': lambda: scenario('smtp-hang-deadline', smtp_env, smtp_mode='hang'),
     'smtp-slow-auth-plus-hang': lambda: scenario('smtp-slow-auth-plus-hang', smtp_env, smtp_mode='hang', auth_delay=2),
     'smtp-slow-auth-deadline': lambda: scenario('smtp-slow-auth-deadline', smtp_env, auth_delay=9),
    }
    out = S[which]()
    path = f'{EVID}/{which}-result.json'
    json.dump(out, open(path, 'w'), indent=2)
    print(json.dumps(out, indent=2))
