"""Synthetic live migration checks. Credentials remain in process memory only."""
import base64
import hashlib
import json
import subprocess
import time
import requests
from pathlib import Path

PROJECT = 'alert-disaster-field-2026'
SERVICE_ACCOUNT = f'adr-runtime@{PROJECT}.iam.gserviceaccount.com'
SDK = Path.home() / 'AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd'
URL = f'https://{PROJECT}.web.app'
STAFF_EMAIL = 'nathanaelcnorman@gmail.com'
PREFIX = 'adr-migration-smoke-'
PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

def access_token():
    return subprocess.check_output([str(SDK),'auth','print-access-token',f'--project={PROJECT}',f'--billing-project={PROJECT}'], text=True, stderr=subprocess.DEVNULL).strip()

def admin(method, url, body=None):
    response = requests.request(method, url, json=body, headers={'Authorization': f'Bearer {access_token()}', 'x-goog-user-project':PROJECT}, timeout=90)
    if not response.ok:
        # Never print auth payloads or tokens on an exception.
        raise RuntimeError(f'Admin request failed: {response.status_code} {response.json().get("error",{}).get("message", "")}')
    return response.json() if response.content else {}

def session(uid, api_key, approved=True):
    now = int(time.time())
    payload = {'iss':SERVICE_ACCOUNT,'sub':SERVICE_ACCOUNT,
               'aud':'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
               'iat':now,'exp':now+600,'uid':uid,
               'claims':{'email':STAFF_EMAIL if approved else 'unapproved@example.invalid','email_verified':True}}
    for attempt in range(36):
        try:
            signed = admin('POST',f'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/{SERVICE_ACCOUNT}:signJwt',{'payload':json.dumps(payload)})['signedJwt']
            break
        except RuntimeError as error:
            if '403' not in str(error) or attempt == 35: raise
            if attempt % 6 == 5: print('Waiting for the temporary synthetic-token permission to propagate...',flush=True)
            time.sleep(5)  # Allow the temporary IAM policy to propagate.
    result = requests.post(f'https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key={api_key}',json={'token':signed,'returnSecureToken':True},timeout=45)
    if not result.ok: raise RuntimeError(f'Synthetic session failed: {result.status_code}')
    return result.json()['idToken']

def main():
    config = requests.get(f'{URL}/__/firebase/init.json',timeout=30).json()
    assert config['projectId'] == PROJECT
    health = requests.get(f'{URL}/api/health',timeout=30)
    assert health.status_code == 200 and health.json()['database_project'] == PROJECT
    assert requests.get(f'{URL}/api/authorizations',timeout=30).status_code == 401
    refs = []
    created_users = []
    uids = [PREFIX+'a', PREFIX+'b', PREFIX+'unapproved']
    try:
        a = session(uids[0],config['apiKey'])
        created_users.append(uids[0])
        b = session(uids[1],config['apiKey'])
        created_users.append(uids[1])
        unapproved = session(uids[2],config['apiKey'],False)
        created_users.append(uids[2])
        headers = {'Authorization':f'Bearer {a}'}
        audit = requests.post(f'{URL}/api/audit',headers=headers,json={
            'address':'Synthetic migration verification, no customer data','year_built':2000,
            'area':'Bathroom','transcript':'Synthetic test: localized clean water damage to 10 square feet of drywall, no cabinet or countertop removal, one fan and one dehumidifier for three days.'
        },timeout=115)
        assert audit.status_code == 200 and isinstance(audit.json().get('adr_estimate'),dict), f'Dedicated Vertex AI audit failed: {audit.status_code}'
        print('PASS: Vertex AI audit generated using the dedicated backend',flush=True)
        reference = f'ADR-AUTH-migration-{int(time.time())}'
        payload = {'auth_id':reference,'address':'Synthetic migration verification, no customer data',
                   'proposed_cost':1999,'signature_png':PNG,'photos_count':1,
                   'findings':['Synthetic verification only'], 'recommendations':['No work authorized'],
                   'photos':[{'id':1,'data_url':PNG,'ocr_status':'Not verified'}]}
        saved = requests.post(f'{URL}/api/authorize',json=payload,headers=headers,timeout=60)
        assert saved.status_code == 200, f'Save failed: {saved.status_code} {saved.text[:250]}'
        refs.append(reference)
        receipt = saved.json()
        retry = requests.post(f'{URL}/api/authorize',json=payload,headers=headers,timeout=60)
        assert retry.status_code == 200 and retry.json()['timestamp'] == receipt['timestamp']
        record = requests.get(f'{URL}/api/authorizations/{reference}',headers=headers,timeout=30)
        assert record.status_code == 200 and record.json()['address'] == payload['address']
        assert 'signature_png' not in record.json()
        image = requests.get(f'{URL}/api/authorizations/{reference}/evidence/signature',headers=headers,timeout=30)
        assert image.status_code == 200 and hashlib.sha256(image.content).hexdigest() == hashlib.sha256(base64.b64decode(PNG.split(',')[1])).hexdigest()
        assert requests.get(f'{URL}/api/authorizations/{reference}',headers={'Authorization':f'Bearer {b}'},timeout=30).status_code == 404
        assert requests.get(f'{URL}/api/authorizations/{reference}/evidence/signature',headers={'Authorization':f'Bearer {b}'},timeout=30).status_code == 404
        assert requests.get(f'{URL}/api/authorizations',headers={'Authorization':f'Bearer {unapproved}'},timeout=30).status_code == 403
        objects = record.json()
        public_image = requests.get('https://storage.googleapis.com/'+PROJECT+'-evidence/'+objects['signature']['path'],timeout=30)
        assert public_image.status_code in (401,403)
        assert any(r['auth_id']==reference for r in requests.get(f'{URL}/api/authorizations',headers=headers,timeout=30).json()['authorizations'])
        print('PASS: dedicated hosting/API, durable signed record, private evidence, idempotent retry, owner isolation, unapproved and anonymous access denied')
    finally:
        # Delete only records and accounts created by this synthetic verification.
        for ref in refs:
            admin('DELETE',f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents/authorizations/{ref}')
        for uid in created_users:
            if not uid.startswith(PREFIX): raise RuntimeError('Unsafe synthetic cleanup target')
            admin('POST',f'https://identitytoolkit.googleapis.com/v1/projects/{PROJECT}/accounts:delete',{'localId':uid})
        # Evidence cleanup uses only the synthetic account prefixes.
        for uid in uids:
            listing = admin('GET',f'https://storage.googleapis.com/storage/v1/b/{PROJECT}-evidence/o?prefix=users/{uid}/')
            for item in listing.get('items',[]):
                from urllib.parse import quote
                admin('DELETE',f'https://storage.googleapis.com/storage/v1/b/{PROJECT}-evidence/o/{quote(item["name"],safe="")}')
        print('Synthetic migration records, evidence and accounts removed')

if __name__ == '__main__': main()
