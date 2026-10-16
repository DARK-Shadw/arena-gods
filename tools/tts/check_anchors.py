# -*- coding: utf-8 -*-
"""Transcribe each character's anchor voice and flag non-speech anchors
(voice-design mode occasionally produces unintelligible output; a bad anchor
poisons every cloned line). Run with a python that has faster_whisper."""
import os, sys, json, glob
os.environ.setdefault("HF_HOME", r"C:\Programming\FunBuilds\FunnyGuyInPc\tts-lab\hf-cache"); os.environ.setdefault("HF_HUB_OFFLINE", "1")
from faster_whisper import WhisperModel
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
jobs = json.load(open(os.path.join(ROOT, "audio-src/tts/jobs.json"), encoding="utf-8"))
anchors = {j["fighter"]: j["anchor"] for j in jobs}
m = WhisperModel("small", device="cpu", compute_type="int8")
bad = []
for f, text in anchors.items():
    p = os.path.join(ROOT, "audio-src/tts/anchors", f + ".wav")
    if not os.path.exists(p): continue
    segs, _ = m.transcribe(p, beam_size=3, language="en")
    hyp = " ".join(s.text.strip() for s in segs)
    ref = set(w.strip(".,!?").lower() for w in text.split())
    got = set(w.strip(".,!?").lower() for w in hyp.split())
    score = len(ref & got) / max(1, len(ref))
    print(f"{f:11s} overlap {score:.2f} | {hyp}")
    if score < 0.5: bad.append(f)
print("BAD:", " ".join(bad))
sys.exit(1 if bad else 0)
