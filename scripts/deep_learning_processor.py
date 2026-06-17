#!/usr/bin/env python3
"""
Arcinity Deep Learning Catalog Processor
=========================================
Indexes every video in the catalog with:
  - Speech transcription  (faster-whisper tiny / openai-whisper tiny)
  - Visual feature vector (CLIP ViT-B/32 / MobileNetV3-Small / color histogram)
  - Audio feature vector  (librosa MFCCs, tempo, energy, ZCR / numpy fallback)

All results are persisted to data/deep-learning-index.json and used by the
recommendation engine for semantic similarity matching.

Usage:
  python deep_learning_processor.py --check-deps
  python deep_learning_processor.py --video-dir /path/to/videos --output /path/to/index.json --ffmpeg /path/to/ffmpeg
  python deep_learning_processor.py --video-dir /path --output /path/out.json --ffmpeg /ffmpeg --reindex
"""

import sys
import os
import json
import argparse
import subprocess
import tempfile
import shutil
import traceback
from pathlib import Path
from datetime import datetime, timezone

VIDEO_EXTS = {'.mp4', '.mov', '.webm', '.mkv', '.avi'}

# ─── Utilities ───────────────────────────────────────────────────────────────

def emit(obj):
    """Write one JSON line to stdout and flush immediately."""
    print(json.dumps(obj, ensure_ascii=False), flush=True)

def emit_error(message):
    emit({'type': 'error', 'message': str(message)})

# ─── Dependency Check ────────────────────────────────────────────────────────

def check_deps():
    deps = {}
    checks = [
        ('faster_whisper', 'faster_whisper'),
        ('whisper',         'whisper'),
        ('torch',           'torch'),
        ('transformers',    'transformers'),
        ('librosa',         'librosa'),
        ('PIL',             'PIL'),
        ('numpy',           'numpy'),
        ('scipy',           'scipy'),
    ]
    for key, mod in checks:
        try:
            __import__(mod)
            deps[key] = True
        except ImportError:
            deps[key] = False
    # Summarize speech/visual/audio capability
    deps['has_speech']  = deps.get('faster_whisper') or deps.get('whisper')
    deps['has_visual']  = (deps.get('torch') and (deps.get('transformers') or deps.get('PIL')))
    deps['has_audio']   = deps.get('librosa') or (deps.get('numpy') and deps.get('scipy'))
    emit({'type': 'deps', **deps})

# ─── Index I/O ───────────────────────────────────────────────────────────────

def load_existing_index(output_path):
    try:
        if os.path.exists(output_path):
            with open(output_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict) and 'videos' in data:
                return data
    except Exception:
        pass
    return {'version': 2, 'generated': None, 'videos': {}}

def save_index(output_path, index):
    index['generated'] = datetime.now(timezone.utc).isoformat()
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    tmp = output_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))
    os.replace(tmp, output_path)

# ─── Catalog Scan ────────────────────────────────────────────────────────────

def scan_videos(video_dir, index):
    """Return list of dicts: key, path, cat, file, indexed."""
    videos = []
    try:
        for cat in sorted(os.listdir(video_dir)):
            cat_path = os.path.join(video_dir, cat)
            if not os.path.isdir(cat_path):
                continue
            for fname in sorted(os.listdir(cat_path)):
                ext = os.path.splitext(fname)[1].lower()
                if ext not in VIDEO_EXTS:
                    continue
                key = f"{cat}/{fname}"
                videos.append({
                    'key':     key,
                    'path':    os.path.join(cat_path, fname),
                    'cat':     cat,
                    'file':    fname,
                    'indexed': key in index.get('videos', {}),
                })
    except Exception as e:
        emit_error(f'Scan error: {e}')
    return videos

# ─── Speech / Transcription ──────────────────────────────────────────────────

_whisper_model  = None
_whisper_type   = None   # 'faster' | 'openai' | 'none'

def init_whisper():
    global _whisper_model, _whisper_type
    if _whisper_type is not None:
        return _whisper_type
    # Prefer faster-whisper: CPU int8, ~3-5× faster than stock whisper
    try:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel('tiny', device='cpu', compute_type='int8')
        _whisper_type  = 'faster'
        return 'faster'
    except Exception:
        pass
    # Fallback: stock openai-whisper
    try:
        import whisper
        _whisper_model = whisper.load_model('tiny')
        _whisper_type  = 'openai'
        return 'openai'
    except Exception:
        pass
    _whisper_type = 'none'
    return 'none'

def transcribe_audio(wav_path):
    wtype = init_whisper()
    if wtype == 'faster':
        segments, info = _whisper_model.transcribe(
            wav_path, beam_size=1, language=None, vad_filter=True,
            condition_on_previous_text=False
        )
        text = ' '.join(s.text.strip() for s in segments if s.text.strip())
        lang = getattr(info, 'language', 'unknown')
        return text.strip(), lang
    elif wtype == 'openai':
        result = _whisper_model.transcribe(wav_path, fp16=False, language=None)
        return result.get('text', '').strip(), result.get('language', 'unknown')
    return '', 'unknown'

# ─── Visual Features ─────────────────────────────────────────────────────────

_visual_model = None
_visual_type  = None   # 'clip' | 'mobilenet' | 'histogram'

def init_visual():
    global _visual_model, _visual_type
    if _visual_type is not None:
        return _visual_type
    # Prefer CLIP: 512-dim semantic embeddings (best for similarity search)
    try:
        import torch
        from transformers import CLIPProcessor, CLIPModel
        m   = CLIPModel.from_pretrained('openai/clip-vit-base-patch32')
        p   = CLIPProcessor.from_pretrained('openai/clip-vit-base-patch32')
        m.eval()
        _visual_model = (m, p)
        _visual_type  = 'clip'
        return 'clip'
    except Exception:
        pass
    # Fallback: MobileNetV3-Small (576-dim, very fast)
    try:
        import torch
        import torchvision.models as models
        import torchvision.transforms as T
        m = models.mobilenet_v3_small(
            weights=models.MobileNet_V3_Small_Weights.IMAGENET1K_V1
        )
        m.classifier = torch.nn.Identity()
        m.eval()
        transform = T.Compose([
            T.Resize(256), T.CenterCrop(224), T.ToTensor(),
            T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        ])
        _visual_model = (m, transform)
        _visual_type  = 'mobilenet'
        return 'mobilenet'
    except Exception:
        pass
    # Last resort: 24-valued HSV color histogram (no dependencies beyond PIL/numpy)
    _visual_type = 'histogram'
    return 'histogram'

def extract_visual_features(frame_path):
    vtype = init_visual()
    try:
        from PIL import Image
        img = Image.open(frame_path).convert('RGB')
        if vtype == 'clip':
            import torch
            m, p = _visual_model
            inputs = p(images=img, return_tensors='pt')
            with torch.no_grad():
                feats = m.get_image_features(**inputs)
                feats = feats / feats.norm(dim=-1, keepdim=True)
            return feats[0].tolist()   # 512-dim L2-normalised
        elif vtype == 'mobilenet':
            import torch
            m, transform = _visual_model
            tensor = transform(img).unsqueeze(0)
            with torch.no_grad():
                feats = m(tensor)
            return feats[0].tolist()   # 576-dim
        else:
            # 3-channel × 8-bin colour histogram (24 values, always works)
            import numpy as np
            arr = np.array(img.resize((64, 64)))
            hist = []
            for c in range(3):
                h, _ = np.histogram(arr[:, :, c], bins=8, range=(0, 256))
                hist.extend((h / (64 * 64)).tolist())
            return hist
    except Exception:
        return []

# ─── Audio Features ──────────────────────────────────────────────────────────

def extract_audio_features(wav_path):
    """Return dict with MFCCs, tempo, spectral centroid, energy, ZCR."""
    try:
        import librosa
        import numpy as np
        y, sr = librosa.load(wav_path, sr=16000, mono=True, duration=90)

        # MFCCs (13 coefficients) – core fingerprint of tonal content
        mfcc      = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
        mfcc_mean = [round(float(v), 4) for v in mfcc.mean(axis=1).tolist()]

        # Chroma – harmonic / pitch class distribution
        chroma      = librosa.feature.chroma_stft(y=y, sr=sr)
        chroma_mean = [round(float(v), 4) for v in chroma.mean(axis=1).tolist()]

        # Tempo (BPM)
        try:
            tempo_raw = librosa.beat.beat_track(y=y, sr=sr)[0]
            tempo = float(tempo_raw[0]) if hasattr(tempo_raw, '__len__') else float(tempo_raw)
        except Exception:
            tempo = 0.0

        # Spectral centroid
        spec_cent = float(librosa.feature.spectral_centroid(y=y, sr=sr).mean())

        # Root-mean-square energy
        rms    = float(librosa.feature.rms(y=y).mean())

        # Zero-crossing rate
        zcr    = float(librosa.feature.zero_crossing_rate(y).mean())

        # Spectral rolloff
        rolloff = float(librosa.feature.spectral_rolloff(y=y, sr=sr).mean())

        return {
            'mfcc':               mfcc_mean,
            'chroma':             chroma_mean,
            'tempo':              round(tempo, 2),
            'spectral_centroid':  round(spec_cent, 2),
            'spectral_rolloff':   round(rolloff, 2),
            'rms_energy':         round(rms, 6),
            'zcr':                round(zcr, 6),
        }
    except ImportError:
        pass

    # numpy-only fallback (basic energy/ZCR from raw PCM)
    try:
        import wave
        import numpy as np
        with wave.open(wav_path, 'rb') as wf:
            n_frames   = wf.getnframes()
            sr         = wf.getframerate()
            n_channels = wf.getnchannels()
            raw        = wf.readframes(min(n_frames, sr * 90))
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if n_channels > 1:
            samples = samples[::n_channels]
        energy = float(np.mean(samples ** 2))
        zcr    = float(np.mean(np.abs(np.diff(np.sign(samples)))) / 2)
        return {
            'mfcc': [], 'chroma': [], 'tempo': 0.0,
            'spectral_centroid': 0.0, 'spectral_rolloff': 0.0,
            'rms_energy': round(energy, 6), 'zcr': round(zcr, 6),
        }
    except Exception:
        pass

    return {
        'mfcc': [], 'chroma': [], 'tempo': 0.0,
        'spectral_centroid': 0.0, 'spectral_rolloff': 0.0,
        'rms_energy': 0.0, 'zcr': 0.0,
    }

# ─── Per-Video Processing ────────────────────────────────────────────────────

def process_video(video_info, ffmpeg_path, tmp_dir):
    key        = video_info['key']
    video_path = video_info['path']
    base       = os.path.splitext(os.path.basename(video_path))[0]
    safe_base  = ''.join(c if c.isalnum() or c == '_' else '_' for c in base)[:60]

    wav_path   = os.path.join(tmp_dir, f"{safe_base}_audio.wav")
    frame_path = os.path.join(tmp_dir, f"{safe_base}_frame.jpg")

    result = {
        'transcript':         '',
        'transcript_language':'unknown',
        'whisper_model':      'none',
        'visual_embedding':   [],
        'visual_type':        'none',
        'audio_features':     {
            'mfcc': [], 'chroma': [], 'tempo': 0.0,
            'spectral_centroid': 0.0, 'spectral_rolloff': 0.0,
            'rms_energy': 0.0, 'zcr': 0.0,
        },
        'processed_at': None,
    }

    try:
        # 1. Extract mono 16-kHz WAV (first 90 s for speed)
        emit({'type': 'stage', 'key': key, 'stage': 'extracting_audio'})
        subprocess.run(
            [ffmpeg_path, '-y', '-i', video_path,
             '-vn', '-ac', '1', '-ar', '16000', '-t', '90', wav_path],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90,
        )

        # 2. Extract a representative keyframe (at 3 s)
        emit({'type': 'stage', 'key': key, 'stage': 'extracting_frame'})
        subprocess.run(
            [ffmpeg_path, '-y', '-ss', '3', '-i', video_path,
             '-frames:v', '1', '-q:v', '2',
             '-vf', 'scale=336:336:force_original_aspect_ratio=decrease',
             frame_path],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45,
        )

        # 3. Speech-to-text
        if os.path.exists(wav_path):
            emit({'type': 'stage', 'key': key, 'stage': 'transcribing'})
            wtype = init_whisper()
            transcript, lang = transcribe_audio(wav_path)
            result['transcript']          = transcript
            result['transcript_language'] = lang
            result['whisper_model']       = wtype

        # 4. Visual embedding
        if os.path.exists(frame_path):
            emit({'type': 'stage', 'key': key, 'stage': 'visual_embedding'})
            vtype = init_visual()
            result['visual_embedding'] = extract_visual_features(frame_path)
            result['visual_type']      = vtype

        # 5. Audio feature extraction
        if os.path.exists(wav_path):
            emit({'type': 'stage', 'key': key, 'stage': 'audio_features'})
            result['audio_features'] = extract_audio_features(wav_path)

    except Exception as e:
        result['error'] = str(e)
    finally:
        for p in [wav_path, frame_path]:
            try:
                if os.path.exists(p):
                    os.remove(p)
            except Exception:
                pass

    result['processed_at'] = datetime.now(timezone.utc).isoformat()
    return result

# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Arcinity Deep Learning Catalog Processor')
    parser.add_argument('--check-deps',  action='store_true',
                        help='Check available ML dependencies and exit')
    parser.add_argument('--video-dir',   type=str,
                        help='Root directory containing category sub-folders of videos')
    parser.add_argument('--output',      type=str,
                        help='Path to write the deep-learning-index.json')
    parser.add_argument('--ffmpeg',      type=str, default='ffmpeg',
                        help='Path to ffmpeg executable')
    parser.add_argument('--reindex',     action='store_true',
                        help='Re-process videos that already have an index entry')
    args = parser.parse_args()

    # ── Mode: dependency check ────────────────────────────────────────────────
    if args.check_deps:
        check_deps()
        return

    # ── Mode: full processing ─────────────────────────────────────────────────
    if not args.video_dir or not args.output:
        emit_error('--video-dir and --output are required')
        sys.exit(1)

    ffmpeg_path = args.ffmpeg
    if not shutil.which(ffmpeg_path) and not os.path.isfile(ffmpeg_path):
        emit_error(f'ffmpeg not found at: {ffmpeg_path}')
        sys.exit(1)

    # Load existing index
    emit({'type': 'status', 'message': 'Loading existing index...'})
    index = load_existing_index(args.output)

    # Scan catalog
    emit({'type': 'status', 'message': 'Scanning video catalog...'})
    videos     = scan_videos(args.video_dir, index)
    to_process = [v for v in videos if not v['indexed'] or args.reindex]
    total      = len(to_process)
    already    = len(videos) - len([v for v in videos if not v['indexed']])

    emit({'type': 'scan_result', 'total_videos': len(videos),
          'to_process': total, 'already_indexed': already})

    if total == 0:
        save_index(args.output, index)
        emit({'type': 'done', 'total': 0, 'done': 0, 'errors': 0,
              'already_indexed': already})
        return

    # Temporary directory for intermediate audio/frame files
    tmp_dir = tempfile.mkdtemp(prefix='arcinity_dl_')
    done   = 0
    errors = 0

    try:
        for video_info in to_process:
            key = video_info['key']
            emit({'type': 'progress', 'done': done, 'total': total,
                  'current': key, 'stage': 'starting', 'errors': errors})
            try:
                result  = process_video(video_info, ffmpeg_path, tmp_dir)
                if 'error' in result:
                    errors += 1
                index['videos'][key] = result
            except Exception as exc:
                errors += 1
                index['videos'][key] = {
                    'error': str(exc),
                    'processed_at': datetime.now(timezone.utc).isoformat(),
                }

            done += 1
            emit({'type': 'progress', 'done': done, 'total': total,
                  'current': key, 'stage': 'complete', 'errors': errors})

            # Persist index every 5 videos so progress survives a crash
            if done % 5 == 0:
                save_index(args.output, index)

    finally:
        save_index(args.output, index)
        try:
            shutil.rmtree(tmp_dir)
        except Exception:
            pass

    emit({'type': 'done', 'total': total, 'done': done, 'errors': errors,
          'already_indexed': already})


if __name__ == '__main__':
    main()
