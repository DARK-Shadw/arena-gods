# -*- coding: utf-8 -*-
"""
Intelligibility check of the SHIPPED voice files (after character FX):
transcribe each with faster-whisper (small, int8, CPU, local cache) and report
word error rate vs the script. Run with any python that has faster_whisper:
  <tts-lab>/envs/chatterbox/Scripts/python.exe tools/tts/intelligibility.py
"""
import os, re, json, sys
os.environ.setdefault("HF_HOME", r"C:\Programming\FunBuilds\FunnyGuyInPc\tts-lab\hf-cache")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
from faster_whisper import WhisperModel
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
man = json.load(open(os.path.join(ROOT, "public", "audio", "voice", "manifest.json"), encoding="utf-8"))
m = WhisperModel("small", device="cpu", compute_type="int8")
norm = lambda s: re.sub(r"[^a-z0-9' ]", " ", s.lower()).split()

def wer(ref, hyp):
    r, h = norm(ref), norm(hyp)
    d = [[0] * (len(h) + 1) for _ in range(len(r) + 1)]
    for i in range(len(r) + 1): d[i][0] = i
    for j in range(len(h) + 1): d[0][j] = j
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i][j] = min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (r[i-1] != h[j-1]))
    return d[len(r)][len(h)] / max(1, len(r))

per = {}
rows = []
for lid, v in sorted(man.items()):
    segs, _ = m.transcribe(os.path.join(ROOT, "public", "audio", v["file"]), beam_size=3, language="en")
    hyp = " ".join(s.text.strip() for s in segs)
    w = wer(v["text"], hyp)
    f = lid.split(".")[0]
    per.setdefault(f, []).append(w)
    rows.append((w, lid, v["text"], hyp))
for w, lid, ref, hyp in sorted(rows, reverse=True)[:12]:
    print(f"WER {w:.2f} {lid}\n   ref: {ref}\n   hyp: {hyp}")
print("\nmean WER per fighter (lower is better; short barks like 'Grrah!' inflate it):")
for f, ws in per.items():
    print(f"  {f:11s} {sum(ws)/len(ws):.2f}  ({len(ws)} lines)")
