"""Synthetic direct Vertex checks; never prints credentials or resumption handles."""
import asyncio, io, json, sys, time, wave
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from google import genai
from google.genai import types
from PIL import Image, ImageDraw
from backend.live_support import live_config
ROOT=Path(__file__).resolve().parents[1]

async def main(duration):
    client=genai.Client(enterprise=True,project='alert-disaster-field-2026',location='us-central1',http_options=types.HttpOptions(timeout=95000))
    image=Image.new('RGB',(640,480),'white');ImageDraw.Draw(image).text((20,40),'SYNTHETIC LIVE TEST - NO CUSTOMER DATA',fill='black')
    buffer=io.BytesIO();image.save(buffer,format='JPEG');frame=buffer.getvalue()
    wav=ROOT/'tests/fixtures/live-prompt.wav'
    with wave.open(str(wav),'rb') as recording:
        assert recording.getframerate()==16000 and recording.getnchannels()==1 and recording.getsampwidth()==2
        pcm=recording.readframes(recording.getnframes())
    facts={'audio_bytes':0,'input_chunks':0,'final_input':0,'checkpoints':0,'natural_goaway':False,'usage_frames':0}
    handle=None
    instruction='You are testing a synthetic ADR walkthrough. Reply briefly. This is not a customer job. Do not invent measurements or authorize work.'
    async def read(session):
        nonlocal handle
        while True:
            async for response in session.receive():
                update=response.session_resumption_update
                if update:
                    facts['checkpoints']+=1
                    handle=update.new_handle if update.resumable else None
                if response.go_away:facts['natural_goaway']=True;return
                if response.usage_metadata:facts['usage_frames']+=1
                content=response.server_content
                if content:
                    if content.input_transcription:
                        facts['input_chunks']+=1
                        if content.input_transcription.finished:facts['final_input']+=1
                    if content.model_turn:
                        facts['audio_bytes']+=sum(len(p.inline_data.data) for p in content.model_turn.parts if p.inline_data and p.inline_data.data)
    async def speech(session):
        for offset in range(0,len(pcm),3200):
            await session.send_realtime_input(audio=types.Blob(data=pcm[offset:offset+3200],mime_type='audio/pcm;rate=16000'))
            await asyncio.sleep(.1)
        await session.send_realtime_input(audio_stream_end=True)
    try:
        start=time.monotonic()
        async with client.aio.live.connect(model='gemini-3.8-live',config=live_config(instruction,'Charon')) as session:
            reader=asyncio.create_task(read(session))
            try:
                await speech(session)
                while time.monotonic()-start<duration and not reader.done():
                    await session.send_realtime_input(video=types.Blob(data=frame,mime_type='image/jpeg'))
                    await asyncio.sleep(1)
                if reader.done():reader.result()
                await session.send_realtime_input(audio_stream_end=True)
                await asyncio.sleep(2)
            finally:reader.cancel();await asyncio.gather(reader,return_exceptions=True)
        facts['camera_session_seconds']=round(time.monotonic()-start,1)
        assert facts['camera_session_seconds']>120 and facts['audio_bytes']>0 and handle,'Long camera session or checkpoint missing'
        async with client.aio.live.connect(model='gemini-3.8-live',config=live_config(instruction,'Charon',handle)) as resumed:
            reader=asyncio.create_task(read(resumed))
            try:
                await speech(resumed);await asyncio.sleep(8)
            finally:reader.cancel();await asyncio.gather(reader,return_exceptions=True)
        facts['provider_resumption_accepted']=True
        print(json.dumps(facts,sort_keys=True),flush=True)
    finally:await client.aio.aclose()

if __name__=='__main__':asyncio.run(main(int(sys.argv[1]) if len(sys.argv)>1 else 135))
