"""Speed re-measure: sherpa-onnx only, 4 threads, 100 v3 clips, sequential; reports RTF and decode time, with the host load average."""
import sys, os, glob, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import svlib, sherpa_onnx
ROOT = '/data/home/yale/work/tc-verify/corpus/voice-index-loop/'
rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(model=f'{svlib.D}/model.int8.onnx', tokens=f'{svlib.D}/tokens.txt', num_threads=4, use_itn=True, language='auto')
fs = sorted(glob.glob(ROOT + 'wav/[0-9]*.wav'))[:100]
rt = []; dts = []; durs = []
for f in fs:
    x = svlib.load(f); s = rec.create_stream(); s.accept_waveform(16000, x); t0 = time.time(); rec.decode_stream(s); dt = time.time() - t0
    rt.append(dt / (len(x) / 16000)); dts.append(dt); durs.append(len(x) / 16000)
q = lambda a, p: sorted(a)[min(len(a) - 1, int(len(a) * p))]
print('clips', len(fs), 'load', open('/proc/loadavg').read().split()[:3], 'RTF p50 %.3f p90 %.3f max %.3f' % (q(rt, .5), q(rt, .9), max(rt)), '| decode p50 %.2fs p90 %.2fs | audio p50 %.1fs p90 %.1fs' % (q(dts, .5), q(dts, .9), q(durs, .5), q(durs, .9)))
