from pathlib import Path
import json
import sys
import wave
import numpy as np
from faster_whisper import WhisperModel

language=sys.argv[2]
if language not in ("auto","zh","en","th","vi"):
    raise ValueError("language")
with wave.open("audio.wav") as wav:
    if not 0 < wav.getnframes()/wav.getframerate() <= 300:
        raise ValueError("duration")
    if (wav.getnchannels(),wav.getsampwidth(),wav.getframerate())!=(1,2,16000):
        raise ValueError("audio format")
    audio=np.frombuffer(wav.readframes(wav.getnframes()),dtype="<i2").astype(np.float32)/32768.0
model=WhisperModel(sys.argv[1],device="cpu",compute_type="int8",cpu_threads=3,num_workers=1,local_files_only=True)
parts,info=model.transcribe(audio,language=None if language=="auto" else language,beam_size=3,vad_filter=True,word_timestamps=False,condition_on_previous_text=False)
rows=[dict(start=round(s.start,3),end=round(s.end,3),text=s.text.strip()) for s in parts if s.text.strip() and s.end>s.start]
Path("segments.json").write_text(json.dumps(dict(language=info.language,rows=rows),ensure_ascii=False),encoding="utf-8")
