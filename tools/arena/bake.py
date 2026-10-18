"""Arena Blender job runner (arena art plan 5.1; built in A0, used by every later arena milestone).

    python -I tools/arena/bake.py <job | group | all> [--force] [--list] [--dry]

Jobs are listed in tools/arena/jobs.json. For each job, strictly one after another:
  * ONE Blender process per job (`blender -b --factory-startup -P <script> -- --out <dir> <args>`);
    the process exit frees all of its memory.
  * Resumable: tools/arena/_bake/<id>/done.json holds a hash of the script, the shared modules
    (abake.py, fxbake.py), the job definition and its input files; an unchanged job is skipped
    (--force re-runs it). A failed / killed job has no done.json and runs again next time.
  * Start guard: waits (up to startWaitMin) until free RAM >= startMinFreeMb, else skips the job.
  * RAM watchdog every 2 s -> <dir>/ram.csv (time, Blender working set, private bytes, free RAM, state):
      free RAM < pauseBelowMb   -> the Blender process is SUSPENDED (NtSuspendProcess), not killed;
      free RAM > resumeAboveMb  -> resumed;
      paused longer than maxPauseMin, or free RAM < killBelowMb -> the job is terminated (marked failed),
      paused selfPauseMin with free RAM not recovering while the job holds > 2 GB -> terminated early
      (the job itself is what fills the memory: retry it with a smaller size or on the CPU),
      so the rest of the PC (and the owner's apps) never hits a low-memory kill;
      runtime > timeoutMin      -> terminated.
  * Blender's console goes to <dir>/run.log; lines with [abake] / Error / Traceback are echoed.
  * tools/arena/_bake/summary.json collects seconds, peak working set, paused seconds and status per job.
Windows only for the watchdog (ctypes: psapi / ntdll / kernel32); elsewhere it only logs free RAM.
Never run it together with a headless browser or the dev server (one heavy job at a time).
"""
import argparse
import ctypes
import hashlib
import json
import os
import subprocess
import sys
import threading
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
JOBS = os.path.join(ROOT, 'tools', 'arena', 'jobs.json')
BAKE = os.path.join(ROOT, 'tools', 'arena', '_bake')
SHARED = ['tools/arena/blender/abake.py', 'tools/fx/blender/fxbake.py']
WIN = sys.platform == 'win32'

if WIN:
    from ctypes import wintypes

    class PMCEX(ctypes.Structure):
        _fields_ = [('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD), ('PeakWorkingSetSize', ctypes.c_size_t),
                    ('WorkingSetSize', ctypes.c_size_t), ('QuotaPeakPagedPoolUsage', ctypes.c_size_t), ('QuotaPagedPoolUsage', ctypes.c_size_t),
                    ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t), ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                    ('PagefileUsage', ctypes.c_size_t), ('PeakPagefileUsage', ctypes.c_size_t), ('PrivateUsage', ctypes.c_size_t)]

    class MSX(ctypes.Structure):
        _fields_ = [('dwLength', wintypes.DWORD), ('dwMemoryLoad', wintypes.DWORD), ('ullTotalPhys', ctypes.c_ulonglong),
                    ('ullAvailPhys', ctypes.c_ulonglong), ('ullTotalPageFile', ctypes.c_ulonglong), ('ullAvailPageFile', ctypes.c_ulonglong),
                    ('ullTotalVirtual', ctypes.c_ulonglong), ('ullAvailVirtual', ctypes.c_ulonglong), ('ullAvailExtendedVirtual', ctypes.c_ulonglong)]

    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    psapi = ctypes.WinDLL('psapi', use_last_error=True)
    ntdll = ctypes.WinDLL('ntdll')
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMCEX), wintypes.DWORD]
    ntdll.NtSuspendProcess.argtypes = [wintypes.HANDLE]
    ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]


def free_mb():
    if WIN:
        m = MSX()
        m.dwLength = ctypes.sizeof(MSX)
        k32.GlobalMemoryStatusEx(ctypes.byref(m))
        return m.ullAvailPhys / 2**20
    try:
        return os.sysconf('SC_AVPHYS_PAGES') * os.sysconf('SC_PAGE_SIZE') / 2**20
    except Exception:
        return 1e9


class Proc:
    """Memory + suspend/resume/terminate for a child process (Windows)."""

    def __init__(self, pid):
        self.h = k32.OpenProcess(0x1000 | 0x0010 | 0x0800 | 0x0001, False, pid) if WIN else None

    def mem(self):
        if not self.h:
            return 0.0, 0.0
        c = PMCEX()
        c.cb = ctypes.sizeof(PMCEX)
        if not psapi.GetProcessMemoryInfo(self.h, ctypes.byref(c), c.cb):
            return 0.0, 0.0
        return c.WorkingSetSize / 2**20, c.PrivateUsage / 2**20

    def suspend(self):
        if self.h:
            ntdll.NtSuspendProcess(self.h)

    def resume(self):
        if self.h:
            ntdll.NtResumeProcess(self.h)

    def close(self):
        if self.h:
            k32.CloseHandle(self.h)


def job_hash(job, cfg):
    h = hashlib.sha1()
    for rel in [job['script']] + SHARED + job.get('inputs', []):
        p = os.path.join(ROOT, rel)
        h.update(rel.encode())
        if os.path.exists(p):
            with open(p, 'rb') as f:
                h.update(f.read())
    h.update(json.dumps({k: v for k, v in job.items() if k != 'note'}, sort_keys=True).encode())
    return h.hexdigest()


def resolve(cfg, name):
    jobs = {j['id']: j for j in cfg['jobs']}
    if name == 'all':
        return list(jobs.values())
    if name in cfg.get('groups', {}):
        return [jobs[i] for i in cfg['groups'][name]]
    if name in jobs:
        return [jobs[name]]
    raise SystemExit(f'unknown job or group {name}; see --list')


def summary_update(rec):
    p = os.path.join(BAKE, 'summary.json')
    try:
        s = json.load(open(p, encoding='utf-8'))
    except Exception:
        s = {}
    s[rec['id']] = rec
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(s, f, indent=1)


def run_job(job, cfg, force=False, dry=False):
    D = dict(cfg['defaults'])
    D.update({k: v for k, v in job.items() if k in cfg['defaults']})
    out = os.path.join(BAKE, job['id'])
    os.makedirs(out, exist_ok=True)
    hsh = job_hash(job, cfg)
    done_p = os.path.join(out, 'done.json')
    if not force and os.path.exists(done_p):
        try:
            if json.load(open(done_p, encoding='utf-8')).get('hash') == hsh:
                print(f'skip {job["id"]} (done, unchanged; --force to redo)')
                return 'skipped'
        except Exception:
            pass
    kind = job.get('kind', 'blender')
    if kind == 'blender':
        cmd = [cfg['blender'], '-b', '--factory-startup', '-P', os.path.join(ROOT, job['script']), '--', '--out', out] + [str(x) for x in job.get('args', [])]
    else:  # 'cmd': any other tool (node scripts), {out} substituted
        cmd = [str(x).replace('{out}', out).replace('{root}', ROOT) for x in job['cmd']]
    print(f'=== {job["id"]}: {" ".join(cmd)}')
    if dry:
        return 'dry'
    # start guard
    t_wait = time.time()
    while free_mb() < D['startMinFreeMb']:
        if time.time() - t_wait > D['startWaitMin'] * 60:
            print(f'!! {job["id"]}: free RAM {free_mb():.0f} MB stayed below {D["startMinFreeMb"]} MB for {D["startWaitMin"]} min: skipped')
            summary_update({'id': job['id'], 'status': 'skipped-low-ram', 'when': time.strftime('%Y-%m-%d %H:%M')})
            return 'skipped-low-ram'
        print(f'   waiting: free RAM {free_mb():.0f} MB < {D["startMinFreeMb"]} MB')
        time.sleep(10)
    env = dict(os.environ)
    env.update({k: str(v) for k, v in job.get('env', {}).items()})
    if os.path.exists(done_p):
        os.remove(done_p)
    logf = open(os.path.join(out, 'run.log'), 'w', encoding='utf-8', errors='replace')
    csv = open(os.path.join(out, 'ram.csv'), 'w', encoding='utf-8')
    csv.write('t_s,working_set_mb,private_mb,free_mb,state\n')
    t0 = time.time()
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, cwd=ROOT)
    pr = Proc(p.pid)

    def pump():
        for raw in iter(p.stdout.readline, b''):
            line = raw.decode('utf-8', errors='replace').rstrip()
            logf.write(line + '\n')
            logf.flush()
            if any(k in line for k in ('[abake]', '[fxbake]', 'Error', 'Traceback', 'error:')):
                print('   ' + line[:400], flush=True)
    th = threading.Thread(target=pump, daemon=True)
    th.start()
    peak_ws = peak_priv = 0.0
    min_free = 1e9
    paused = False
    paused_s = 0.0
    pause_t = 0.0
    pause_free = 0.0
    status = 'ok'
    while p.poll() is None:
        time.sleep(2)
        ws, pv = pr.mem()
        fr = free_mb()
        peak_ws, peak_priv, min_free = max(peak_ws, ws), max(peak_priv, pv), min(min_free, fr)
        el = time.time() - t0
        if not paused and fr < D['pauseBelowMb']:
            pr.suspend()
            paused, pause_t, pause_free = True, time.time(), fr
            print(f'   PAUSED {job["id"]}: free RAM {fr:.0f} MB < {D["pauseBelowMb"]} MB (Blender {ws:.0f} MB)', flush=True)
        elif paused and fr > D['resumeAboveMb']:
            pr.resume()
            paused_s += time.time() - pause_t
            paused = False
            print(f'   resumed {job["id"]}: free RAM {fr:.0f} MB', flush=True)
        kill = None
        if fr < D['killBelowMb']:
            kill = f'free RAM {fr:.0f} MB < {D["killBelowMb"]} MB'
        elif paused and time.time() - pause_t > D['maxPauseMin'] * 60:
            kill = f'paused longer than {D["maxPauseMin"]} min'
        elif paused and time.time() - pause_t > D['selfPauseMin'] * 60 and fr < pause_free + 300 and pv > 2048:
            # nothing else is giving memory back: the job itself is the hog, so waiting cannot help
            kill = f'paused {D["selfPauseMin"]} min without free RAM recovering while the job holds {pv:.0f} MB (the job itself needs more RAM than is free)'
        elif el > D['timeoutMin'] * 60:
            kill = f'timeout {D["timeoutMin"]} min'
        csv.write(f'{el:.0f},{ws:.0f},{pv:.0f},{fr:.0f},{"paused" if paused else "run"}\n')
        csv.flush()
        if kill:
            print(f'!! KILL {job["id"]}: {kill}', flush=True)
            if paused:
                pr.resume()
            p.kill()
            status = 'killed: ' + kill
            break
    p.wait()
    th.join(timeout=5)
    if paused:
        paused_s += time.time() - pause_t
    pr.close()
    logf.close()
    csv.close()
    secs = time.time() - t0
    if status == 'ok' and p.returncode != 0:
        status = f'exit {p.returncode}'
    res_p = os.path.join(out, 'result.json')
    if status == 'ok' and kind == 'blender' and not os.path.exists(res_p):
        status = 'no result.json'
    rec = {'id': job['id'], 'status': status, 'seconds': round(secs, 1), 'pausedSeconds': round(paused_s, 1),
           'peakWorkingSetMB': round(peak_ws), 'peakPrivateMB': round(peak_priv), 'minFreeMB': round(min_free),
           'when': time.strftime('%Y-%m-%d %H:%M'), 'hash': hsh}
    if status == 'ok':
        with open(done_p, 'w', encoding='utf-8') as f:
            json.dump(rec, f, indent=1)
    summary_update(rec)
    print(f'=== {job["id"]}: {status} in {secs:.0f}s, peak working set {peak_ws:.0f} MB (private {peak_priv:.0f} MB), min free RAM {min_free:.0f} MB, paused {paused_s:.0f}s')
    return status


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('target', nargs='?', default='')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    cfg = json.load(open(JOBS, encoding='utf-8'))
    if a.list or not a.target:
        for j in cfg['jobs']:
            print(f"{j['id']:28s} {j.get('note', '')}")
        print('groups:', ', '.join(f'{k} ({len(v)})' for k, v in cfg.get('groups', {}).items()))
        return
    if not os.path.exists(cfg['blender']):
        raise SystemExit(f"Blender not found at {cfg['blender']} (edit tools/arena/jobs.json)")
    os.makedirs(BAKE, exist_ok=True)
    res = {}
    for j in resolve(cfg, a.target):
        res[j['id']] = run_job(j, cfg, a.force, a.dry)
    print('\n'.join(f'{k:28s} {v}' for k, v in res.items()))


if __name__ == '__main__':
    main()
