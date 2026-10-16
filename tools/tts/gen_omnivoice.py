# -*- coding: utf-8 -*-
"""
Offline voice generation with OmniVoice (k2-fsa), adapted from
tts-lab/scripts/test_omnivoice_bf16.py (that folder is left untouched).

Per fighter: synthesise an ANCHOR line in voice-design mode (persona
"instruct", fixed seed), then clone that anchor for every other line so the
character keeps one consistent voice. Raw 24 kHz wavs are cached by job hash
in audio-src/tts/raw/; existing files are skipped.

Device: Intel Arc iGPU via torch XPU (bf16) when available -- measured
~1 min/line vs ~18 min/line for bf16 on CPU on this machine; falls back
to CPU with int8 dynamic quantisation (~1 min/line).
Run with the OmniVoice venv python (one process, sequential):
  <tts-lab>/envs/omnivoice/Scripts/python.exe tools/tts/gen_omnivoice.py
"""
import os, sys, json, time
os.environ.setdefault("HF_HOME", r"C:\Programming\FunBuilds\FunnyGuyInPc\tts-lab\hf-cache")
os.environ.setdefault("HF_HUB_OFFLINE", "1")  # never download; use the local cache
import numpy as np, soundfile as sf, torch

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
JOBS = os.path.join(ROOT, "audio-src", "tts", "jobs.json")
RAW = os.path.join(ROOT, "audio-src", "tts", "raw")
ANCH = os.path.join(ROOT, "audio-src", "tts", "anchors")
os.makedirs(RAW, exist_ok=True); os.makedirs(ANCH, exist_ok=True)
jobs = json.load(open(JOBS, encoding="utf-8"))
ONLY = os.environ.get("TTS_FIGHTER")  # one fighter per process keeps iGPU memory from creeping up
todo = [j for j in jobs if not os.path.exists(os.path.join(RAW, j["hash"] + ".wav")) and (not ONLY or j["fighter"] == ONLY)]
print(f"[tts] {len(jobs)} jobs, {len(todo)} to generate", flush=True)
if not todo:
    sys.exit(0)

from omnivoice import OmniVoice
torch.set_num_threads(max(2, (os.cpu_count() or 4) - 2))
t0 = time.time()
DEV = "cpu"
if os.environ.get("TTS_DEVICE", "auto") != "cpu" and hasattr(torch, "xpu") and torch.xpu.is_available():
    # device_map="xpu" queries free VRAM, which the integrated Arc can't answer -> load on CPU then move
    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cpu", dtype=torch.bfloat16)
    model = model.to("xpu")
    DEV = "xpu"
else:
    model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cpu", dtype=torch.float32)
    model = torch.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
print(f"[load] {time.time()-t0:.1f}s on {DEV}", flush=True)

def to_np(a):
    a = a[0] if isinstance(a, (list, tuple)) else a
    return np.asarray(a, dtype=np.float32).squeeze()

prompts = {}
def prompt_for(j):
    f = j["fighter"]
    if f in prompts:
        return prompts[f]
    path = os.path.join(ANCH, f"{f}.wav")
    if not os.path.exists(path):
        seed = int(os.environ.get("TTS_ANCHOR_SEED", "1234"))
        torch.manual_seed(seed)
        if DEV == "xpu": torch.xpu.manual_seed(seed)
        t = time.time()
        a = to_np(model.generate(text=j["anchor"], language="en", instruct=j["instruct"], speed=j["speed"]))
        sf.write(path, a, 24000)
        print(f"[anchor] {f}: {len(a)/24000:.1f}s audio in {time.time()-t:.1f}s ({j['instruct']})", flush=True)
    prompts.clear()  # only keep the current fighter's prompt resident
    prompts[f] = model.create_voice_clone_prompt(ref_audio=path, ref_text=j["anchor"])
    return prompts[f]

if os.environ.get("TTS_ANCHOR_ONLY"):
    for f in sorted({j["fighter"] for j in todo}):
        prompt_for(next(j for j in todo if j["fighter"] == f))
    print("ANCHORS DONE", flush=True)
    sys.exit(0)

done = 0
for j in todo:
    t = time.time()
    try:
        p = prompt_for(j)
        torch.manual_seed(int(j["hash"][:8], 16) % (2**31))
        a = to_np(model.generate(text=j["text"], language="en", voice_clone_prompt=p, speed=j["speed"]))
        sf.write(os.path.join(RAW, j["hash"] + ".wav"), a, 24000)
        done += 1
        print(f"[{done}/{len(todo)}] {j['id']}: {len(a)/24000:.1f}s audio, {time.time()-t:.1f}s", flush=True)
    except Exception as e:
        print(f"[error] {j['id']}: {type(e).__name__}: {e}", flush=True)
    finally:
        if DEV == "xpu":
            torch.xpu.synchronize(); torch.xpu.empty_cache()
print("DONE", flush=True)
