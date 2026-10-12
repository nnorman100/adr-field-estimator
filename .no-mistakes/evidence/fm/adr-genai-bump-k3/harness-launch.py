"""Runs the real backend under uvicorn; Firebase auth/Firestore are in-memory fakes, Vertex is a local fake the real SDK talks to."""
import sys, json, time, threading, pathlib, http.server
WT, EVID, PORT = sys.argv[1], pathlib.Path(sys.argv[2]), int(sys.argv[3])
sys.path.insert(0, WT)
import uvicorn
import backend.main as bm
from backend.contracts import InspectionData
from tests.fakes import FakeStore, FakeVertexLive
ID='ADR-INS-'+'d'*32
store=FakeStore()
data=InspectionData().model_dump(); data['technician_transcript']='Category 2 water in the kitchen, about 120 square feet of drywall wet.'
store.create_inspection('owner',ID,data)
async def identity(token):
    if token!='synthetic': raise bm.HTTPException(401,'Sign in to continue.')
    return {'uid':'owner','exp':time.time()+600,'email':'tech@example.com'}
bm.app.dependency_overrides[bm.get_job_store]=lambda:store
bm.verify_staff=identity; bm.get_job_store=lambda:store
rest_log=EVID/'rest-wire-requests.jsonl'; rest_log.write_text('')
class Rest(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['content-length'])))
        with rest_log.open('a') as f: f.write(json.dumps({'path':self.path,'authorization':self.headers.get('authorization'),'body':body})+'\n')
        props=body['generationConfig']['responseSchema']['properties']
        value={'changes':[],'questions':['Which wall in the kitchen is wet?']} if 'changes' in props else {}
        out=json.dumps({'candidates':[{'content':{'role':'model','parts':[{'text':json.dumps(value)}]},'finishReason':'STOP'}]}).encode()
        self.send_response(200);self.send_header('content-type','application/json');self.send_header('content-length',str(len(out)));self.end_headers();self.wfile.write(out)
    def log_message(self,*a):pass
rest=http.server.ThreadingHTTPServer(('127.0.0.1',0),Rest); threading.Thread(target=rest.serve_forever,daemon=True).start()
tmp=pathlib.Path(sys.argv[4]); vertex=FakeVertexLive(tmp).__enter__()
live=vertex.client(bm.genai.Client)
real=bm.genai.Client
from google.oauth2.credentials import Credentials
def client(**kw):
    if kw.get('location')==bm.LIVE_LOCATION: return live(**kw)
    options=kw.pop('http_options').model_copy(update=dict(base_url=f'http://127.0.0.1:{rest.server_address[1]}'))
    return real(credentials=Credentials(token='synthetic-token'),http_options=options,**kw)
bm.genai.Client=client
import base64
def wire_audio(text):
    return {'serverContent':{'modelTurn':{'parts':[{'inlineData':{'mimeType':'audio/pcm;rate=24000','data':base64.b64encode(b'\x01\x02').decode()}}]},'outputTranscription':{'text':text}}}
vertex.replies['setup']=[{'setupComplete':{}},{'sessionResumptionUpdate':{'newHandle':'wire-handle','resumable':True}},{'usageMetadata':{'totalTokenCount':17}}]
vertex.replies['audio']=[{'serverContent':{'inputTranscription':{'text':'moisture at the wall','finished':True}}},wire_audio('Noted, reading the wall.'),
    {'serverContent':{'turnComplete':True,'interactionStatus':'IN_PROGRESS'}},{'serverContent':{'interrupted':True}},
    {'serverContent':{'interactionStatus':'IDLE'}},{'serverContent':{'outputTranscription':{'text':'after idle'}}}]
vertex.replies['video']=[{'goAway':{'timeLeft':'1s'}}]
class Replies(dict):
    def pop(self,k,d=None):
        if k=='setup' and k not in self: return [{'setupComplete':{}}]
        return dict.pop(self,k,d)
vertex.replies=Replies(vertex.replies)
def dump():
    while True:
        time.sleep(0.5)
        (EVID/'live-wire-frames-received-by-fake-vertex.json').write_text(json.dumps(vertex.connections,indent=1)[:200000])
        (EVID/'live-resume-store.json').write_text(json.dumps({k:v for k,v in store.db.records.items() if k.startswith('_live_resume')},default=str,indent=1))
threading.Thread(target=dump,daemon=True).start()
import google.genai; print('google-genai',google.genai.__version__,flush=True)
uvicorn.run(bm.app,host='127.0.0.1',port=PORT,log_level='info')
