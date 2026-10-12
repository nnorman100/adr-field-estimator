"""Shared constants and synthetic fixtures for the dedicated-project release verifiers; no credentials are logged."""
import base64, io, subprocess
from pathlib import Path
import requests
from PIL import Image, ImageDraw

PROJECT='alert-disaster-field-2026'
SDK=Path.home()/'AppData/Local/Google/Cloud SDK/google-cloud-sdk/bin/gcloud.cmd'
URL=f'https://{PROJECT}.web.app'

def access_token():
    return subprocess.check_output([str(SDK),'auth','print-access-token',f'--project={PROJECT}',f'--billing-project={PROJECT}'],text=True,stderr=subprocess.DEVNULL).strip()

def admin(method,url,body=None):
    response=requests.request(method,url,json=body,headers={'Authorization':f'Bearer {access_token()}','x-goog-user-project':PROJECT},timeout=90)
    if not response.ok:
        # Never print auth payloads or tokens on an exception.
        raise RuntimeError(f'Admin request failed: {response.status_code} {response.json().get("error",{}).get("message","")}')
    return response.json() if response.content else {}

def image(signature=False):
    im=Image.new('RGB',(300,600) if not signature else (400,180),'white')
    draw=ImageDraw.Draw(im)
    if signature:draw.line([(20,110),(100,40),(200,130),(360,45)],fill='black',width=4)
    else:draw.text((20,40),'SYNTHETIC PHOTO - NO METER',fill='black')
    output=io.BytesIO();im.save(output,format='PNG');return 'data:image/png;base64,'+base64.b64encode(output.getvalue()).decode()
