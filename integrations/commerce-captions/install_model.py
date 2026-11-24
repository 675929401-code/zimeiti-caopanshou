"""Install the pinned multilingual ASR model. All files are verified before activation."""
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile
import urllib.request

revision="ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66"
files={"config.json":(2309,"867cf1a0fece1394e01d55e287ba2f09a577c046"),
       "tokenizer.json":(2203239,"7818adb6de9fa3064d3ff81226fdd675be1f6344"),
       "vocabulary.txt":(459861,"c9074644d9d1205686f16d411564729461324b75"),
       "model.bin":(145217532,"d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9")}
dest=Path(sys.argv[1]).resolve()
dest.mkdir(exist_ok=True,parents=True)
def verified(path,size,expected):
    if not path.exists() or path.stat().st_size!=size:return False
    h=hashlib.sha256() if len(expected)==64 else hashlib.sha1(f"blob {size}\0".encode())
    with path.open("rb") as f:
        for block in iter(lambda:f.read(1024*1024),b""):h.update(block)
    return h.hexdigest()==expected
for name,(size,digest) in files.items():
    path=dest/name
    if verified(path,size,digest):continue
    with tempfile.TemporaryDirectory(dir=dest) as temp:
        part=Path(temp)/"download"
        url=f"https://huggingface.co/Systran/faster-whisper-base/resolve/{revision}/{name}?download=true"
        with urllib.request.urlopen(url,timeout=90) as r,part.open("wb") as f:shutil.copyfileobj(r,f)
        if not verified(part,size,digest):raise ValueError(name+" failed checksum verification")
        os.replace(part,path)
    print(name,flush=True)
