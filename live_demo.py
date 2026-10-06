import asyncio
import os
import sys
from google import genai
from google.genai import types

# Ensure GEMINI_API_KEY is available
api_key = os.getenv("GEMINI_API_KEY")
if not api_key:
    print("Warning: GEMINI_API_KEY environment variable is not set.")
    print("Please set it with: set GEMINI_API_KEY=your_api_key (Windows CMD)")
    print("Or: $env:GEMINI_API_KEY=\"your_api_key\" (PowerShell)")

client = genai.Client(api_key=api_key)

# The model for Gemini Live bidirectional streaming
MODEL = "gemini-2.0-flash-exp"  # Or gemini-3.8-live where supported

config = types.LiveConnectConfig(
    response_modalities=["AUDIO"],
    speech_config=types.SpeechConfig(
        voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Kore")
        )
    ),
    output_audio_transcription=types.AudioTranscriptionConfig()
)

async def receive_responses(session):
    """Continuously receive server responses (transcription, audio, interruptions)."""
    try:
        async for response in session.receive():
            server_content = response.server_content
            if server_content:
                if server_content.interrupted:
                    print("\n[Interrupted by user!]")

                if server_content.output_transcription:
                    print(f"\rGemini: {server_content.output_transcription.text}", end="", flush=True)

                if server_content.model_turn:
                    for part in server_content.model_turn.parts:
                        if part.inline_data:
                            # Raw PCM 24kHz audio bytes can be piped to an audio output stream
                            pcm_data = part.inline_data.data
                            pass

                if server_content.turn_complete:
                    print("\n")

            if response.tool_call:
                print(f"\n[Tool Call Requested: {response.tool_call}]")
    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"\n[Receive Error: {e}]")

async def send_user_input(session):
    """Prompt user for input in a non-blocking loop and send to Live API."""
    loop = asyncio.get_running_loop()
    while True:
        try:
            user_text = await loop.run_in_executor(None, input, "You: ")
            if not user_text.strip():
                continue
            if user_text.strip().lower() in ("exit", "quit"):
                break

            await session.send_realtime_input(text=user_text)
        except (EOFError, KeyboardInterrupt):
            break

async def main():
    print(f"Connecting to Gemini Live API ({MODEL})...")
    async with client.aio.live.connect(model=MODEL, config=config) as session:
        print("Connected! Type your message (or 'exit' to quit).\n")
        receiver_task = asyncio.create_task(receive_responses(session))
        try:
            await send_user_input(session)
        finally:
            receiver_task.cancel()
            await asyncio.gather(receiver_task, return_exceptions=True)

if __name__ == "__main__":
    asyncio.run(main())
