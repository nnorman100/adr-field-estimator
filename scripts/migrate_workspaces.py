"""Preview by default. Resolve only explicitly approved Google users through ADC."""
import argparse
import hashlib
import json
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import firebase_admin
from firebase_admin import auth
from google.cloud import firestore
from backend.workspaces import WorkspaceStore, email_address
from backend.workspace_migration import migrate

PROJECT='alert-disaster-field-2026'
ADMIN_EMAIL='nathanaelcnorman@gmail.com'

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--approved-email',action='append',default=[])
    parser.add_argument('--apply',action='store_true')
    parser.add_argument('--manifest',type=Path)
    args=parser.parse_args()
    if args.apply and not args.manifest: parser.error('--apply requires --manifest for the created-path rollback record')
    app=firebase_admin.initialize_app(options={'projectId':PROJECT},name='workspace-migration')
    users={}; admin_uid=None
    for email in sorted(set([ADMIN_EMAIL]+args.approved_email)):
        user=auth.get_user_by_email(email_address(email),app=app)
        if not user.email_verified or user.disabled or 'google.com' not in {p.provider_id for p in user.provider_data}:
            raise ValueError('Migration requires an active, verified Google user: '+email)
        users[user.uid]=email_address(email)
        if email_address(email)==ADMIN_EMAIL: admin_uid=user.uid
    workspace=WorkspaceStore(firestore.Client(project=PROJECT,database='(default)'))
    def fingerprints():
        result={}
        for collection in ('inspections','authorizations'):
            for snapshot in workspace.db.collection(collection).stream():
                data=snapshot.to_dict()
                if data.get('owner_uid') in users:
                    encoded=json.dumps(data,sort_keys=True,separators=(',', ':'),default=str).encode()
                    result[snapshot.reference.path]=hashlib.sha256(encoded).hexdigest()
        return result
    before=fingerprints()
    report=migrate(workspace,users,admin_uid,args.apply)
    after=fingerprints()
    report['source_records_preserved']=all(after.get(path)==digest for path,digest in before.items())
    report['source_record_hashes']=before
    if not report['source_records_preserved']:raise RuntimeError('Source records changed during migration; inspect concurrent writes before cutover.')
    if args.manifest:
        args.manifest.parent.mkdir(parents=True,exist_ok=True)
        # Manifest contains sidecar identifiers, not tokens or signed customer payloads.
        args.manifest.write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
    print(json.dumps({k:v for k,v in report.items() if k not in ('created_paths','source_record_hashes')},indent=2))

if __name__=='__main__': main()
