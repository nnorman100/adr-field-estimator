"""Mints an App Check-shaped RS256 JWT with the launcher's local key. Usage: mint.py [valid|expired|wrong-aud|wrong-key]"""
import sys,time,jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
kind=sys.argv[1] if len(sys.argv)>1 else 'valid'
key=serialization.load_pem_private_key(open('/tmp/adr-ac-keys/key.pem','rb').read(),None)
if kind=='wrong-key':key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
now=int(time.time())
claims={'iss':'https://firebaseappcheck.googleapis.com/545776254070','sub':'1:545776254070:web:c380c2ee35398689143357',
 'aud':['projects/545776254070','projects/'+('other-project' if kind=='wrong-aud' else 'alert-disaster-field-2026')],
 'iat':now-60,'exp':now-30 if kind=='expired' else now+3600}
print(jwt.encode(claims,key,algorithm='RS256',headers={'kid':'local-kid','typ':'JWT'}))
