import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import { promisify } from 'util';

// ── Mutable delegates for module-level mocks ──

let execFileFn: (...args: any[]) => any;
let execFileSyncFn: (...args: any[]) => any;
let readdirSyncFn: (...args: any[]) => any;
let mkdirFn: (...args: any[]) => any;
let writeFileFn: (...args: any[]) => any;

// ── Module mocks (before importing module under test) ──

// The real execFile has a [promisify.custom] symbol so that promisify(execFile)
// returns { stdout, stderr }. Our mock delegate needs the same, otherwise
// promisify falls back to default behavior (single return value).
const execFileDelegate: any = (...args: any[]) => execFileFn(...args);
execFileDelegate[promisify.custom] = (...args: any[]) => {
  return new Promise((resolve, reject) => {
    execFileFn(...args, (err: Error | null, stdout: string, stderr: string) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
};

mock.module('child_process', {
  namedExports: {
    execFile: execFileDelegate,
    execFileSync: (...args: any[]) => execFileSyncFn(...args),
  },
});

mock.module('fs', {
  namedExports: {
    readdirSync: (...args: any[]) => readdirSyncFn(...args),
  },
});

mock.module('fs/promises', {
  namedExports: {
    mkdir: (...args: any[]) => mkdirFn(...args),
    writeFile: (...args: any[]) => writeFileFn(...args),
  },
});

// Mock OmniModelCache so we don't try to load real native models
mock.module('../../lib/llm/providers/omni-model-cache.ts', {
  namedExports: {
    OmniModelCache: {
      getImageModel: mock.fn(async () => ({
        generate: mock.fn(async () => Buffer.from('fake-png')),
      })),
      getTtsModel: mock.fn(async () => ({
        speak: mock.fn(async () => Buffer.from('fake-wav')),
      })),
    },
  },
});

const { _testing, buildModelTools } = await import(
  '../../lib/tools/built-in/model-tool-factory.ts'
);

// ── Helper: simulate execFile with callback (promisify-compatible) ──

function makeExecFileCallback(stdout = '', stderr = '', error: Error | null = null) {
  return (_cmd: string, _args: string[], ...rest: any[]) => {
    const cb = rest.find((a: any) => typeof a === 'function');
    if (cb) {
      if (error) cb(error, '', '');
      else cb(null, stdout, stderr);
    }
  };
}

// ── Tests ──

describe('model-tool-factory', () => {
  beforeEach(() => {
    _testing.resetFfmpegCache();
    // Default: ffmpeg found on PATH
    execFileSyncFn = mock.fn(() => '');
    // Default: execFile does nothing (override per test)
    execFileFn = makeExecFileCallback();
    readdirSyncFn = mock.fn(() => []);
    mkdirFn = mock.fn(async () => undefined);
    writeFileFn = mock.fn(async () => undefined);
    // Prime the ffmpeg cache so tests don't depend on execFileSync side effects
    _testing.getFfmpeg();
  });

  // ── findFfmpeg ──

  describe('findFfmpeg', () => {
    it('returns "ffmpeg" when ffmpeg is on PATH', () => {
      execFileSyncFn = mock.fn(() => ''); // success = ffmpeg found
      const result = _testing.findFfmpeg();
      assert.strictEqual(result, 'ffmpeg');
    });

    it('returns "ffmpeg" on non-Windows when not on PATH', () => {
      execFileSyncFn = mock.fn(() => { throw new Error('not found'); });
      // On non-Windows, falls through to return 'ffmpeg'
      if (process.platform !== 'win32') {
        const result = _testing.findFfmpeg();
        assert.strictEqual(result, 'ffmpeg');
      }
    });

    it('scans WinGet packages on Windows when not on PATH', () => {
      if (process.platform !== 'win32') return; // Windows-only test

      execFileSyncFn = mock.fn(() => { throw new Error('not found'); });
      const fakeDir = 'Gyan.FFmpeg_1.2.3';
      readdirSyncFn = mock.fn((dir: string, opts?: any) => {
        if (dir.includes('WinGet') && !opts?.recursive) return [fakeDir];
        if (opts?.recursive) return ['ffmpeg-7.1-full_build\\bin\\ffmpeg.exe'];
        return [];
      });

      const result = _testing.findFfmpeg();
      assert.ok(result.endsWith('ffmpeg.exe'), `Expected path ending with ffmpeg.exe, got: ${result}`);
    });
  });

  // ── getFfmpeg (caching) ──

  describe('getFfmpeg', () => {
    it('caches the ffmpeg path after first call', () => {
      _testing.resetFfmpegCache();
      let callCount = 0;
      execFileSyncFn = mock.fn(() => { callCount++; return ''; });

      const first = _testing.getFfmpeg();
      const second = _testing.getFfmpeg();
      assert.strictEqual(first, second);
      assert.strictEqual(callCount, 1, 'findFfmpeg should only be called once');
    });

    it('resets cache via resetFfmpegCache', () => {
      _testing.resetFfmpegCache();
      let callCount = 0;
      execFileSyncFn = mock.fn(() => { callCount++; return ''; });

      _testing.getFfmpeg();
      assert.strictEqual(callCount, 1);

      _testing.resetFfmpegCache();
      _testing.getFfmpeg();
      assert.strictEqual(callCount, 2);
    });
  });

  // ── probeDuration ──

  describe('probeDuration', () => {
    it('returns duration in seconds from ffprobe output', async () => {
      execFileSyncFn = mock.fn(() => ''); // findFfmpeg succeeds
      execFileFn = makeExecFileCallback('10.500000\n');

      const duration = await _testing.probeDuration('/test/audio.wav');
      assert.strictEqual(duration, 10.5);
    });

    it('returns null when ffprobe fails', async () => {
      execFileSyncFn = mock.fn(() => ''); // findFfmpeg succeeds
      execFileFn = makeExecFileCallback('', '', new Error('ffprobe not found'));

      const duration = await _testing.probeDuration('/test/audio.wav');
      assert.strictEqual(duration, null);
    });

    it('returns null for non-numeric ffprobe output', async () => {
      execFileSyncFn = mock.fn(() => '');
      execFileFn = makeExecFileCallback('N/A\n');

      const duration = await _testing.probeDuration('/test/audio.wav');
      assert.strictEqual(duration, null);
    });

    it('derives ffprobe path from ffmpeg path', async () => {
      execFileSyncFn = mock.fn(() => '');
      let calledCmd = '';
      execFileFn = (cmd: string, _args: string[], ...rest: any[]) => {
        calledCmd = cmd;
        const cb = rest.find((a: any) => typeof a === 'function');
        if (cb) cb(null, '5.0\n', '');
      };

      _testing.resetFfmpegCache();
      await _testing.probeDuration('/test/audio.wav');
      assert.strictEqual(calledCmd, 'ffprobe');
    });
  });

  // ── ensureReferenceAudio ──

  describe('ensureReferenceAudio', () => {
    it('passes through short WAV files without processing', async () => {
      execFileSyncFn = mock.fn(() => '');
      // probeDuration returns 8 seconds
      execFileFn = makeExecFileCallback('8.0\n');

      const result = await _testing.ensureReferenceAudio('/test/clip.wav');
      assert.strictEqual(result, '/test/clip.wav');
    });

    it('passes through WAV when ffprobe is unavailable (graceful degradation)', async () => {
      execFileSyncFn = mock.fn(() => '');
      execFileFn = makeExecFileCallback('', '', new Error('ffprobe not found'));

      const result = await _testing.ensureReferenceAudio('/test/clip.wav');
      assert.strictEqual(result, '/test/clip.wav');
    });

    it('trims long WAV files to MAX_REFERENCE_SECONDS', async () => {
      execFileSyncFn = mock.fn(() => '');
      let ffmpegCallArgs: string[] = [];
      let callIndex = 0;
      execFileFn = (_cmd: string, args: string[], ...rest: any[]) => {
        callIndex++;
        const cb = rest.find((a: any) => typeof a === 'function');
        if (callIndex === 1) {
          // First call: ffprobe — returns 120 seconds
          if (cb) cb(null, '120.0\n', '');
        } else {
          // Second call: ffmpeg trim
          ffmpegCallArgs = args;
          if (cb) cb(null, '', '');
        }
      };

      const result = await _testing.ensureReferenceAudio('/test/long.wav');
      assert.strictEqual(result, '/test/long_trimmed.wav');
      assert.ok(ffmpegCallArgs.includes('-t'), 'Should include -t flag for trimming');
      assert.ok(ffmpegCallArgs.includes(String(_testing.MAX_REFERENCE_SECONDS)));
    });

    it('converts non-WAV to WAV with trimming', async () => {
      execFileSyncFn = mock.fn(() => '');
      let ffmpegCallArgs: string[] = [];
      execFileFn = (_cmd: string, args: string[], ...rest: any[]) => {
        ffmpegCallArgs = args;
        const cb = rest.find((a: any) => typeof a === 'function');
        if (cb) cb(null, '', '');
      };

      const result = await _testing.ensureReferenceAudio('/test/clip.m4a');
      assert.strictEqual(result, '/test/clip.wav');
      assert.ok(ffmpegCallArgs.includes('-ar'), 'Should include -ar for sample rate');
      assert.ok(ffmpegCallArgs.includes('24000'));
      assert.ok(ffmpegCallArgs.includes('-ac'), 'Should include -ac for mono');
      assert.ok(ffmpegCallArgs.includes('1'));
      assert.ok(ffmpegCallArgs.includes('-t'), 'Should include -t for max duration');
    });

    it('converts MP3 to WAV', async () => {
      execFileSyncFn = mock.fn(() => '');
      execFileFn = (_cmd: string, _args: string[], ...rest: any[]) => {
        const cb = rest.find((a: any) => typeof a === 'function');
        if (cb) cb(null, '', '');
      };

      const result = await _testing.ensureReferenceAudio('/test/voice.mp3');
      assert.strictEqual(result, '/test/voice.wav');
    });

    it('throws when ffmpeg fails on non-WAV conversion', async () => {
      execFileSyncFn = mock.fn(() => '');
      execFileFn = makeExecFileCallback('', '', new Error('ffmpeg crashed'));

      await assert.rejects(
        () => _testing.ensureReferenceAudio('/test/clip.m4a'),
        (err: Error) => {
          assert.ok(err.message.includes('is ffmpeg installed'));
          assert.ok(err.message.includes('ffmpeg crashed'));
          return true;
        },
      );
    });

    it('WAV at exactly MAX_REFERENCE_SECONDS passes through', async () => {
      execFileSyncFn = mock.fn(() => '');
      execFileFn = makeExecFileCallback(`${_testing.MAX_REFERENCE_SECONDS}.0\n`);

      const result = await _testing.ensureReferenceAudio('/test/exact.wav');
      assert.strictEqual(result, '/test/exact.wav');
    });

    it('WAV just over MAX_REFERENCE_SECONDS gets trimmed', async () => {
      execFileSyncFn = mock.fn(() => '');
      let callIndex = 0;
      execFileFn = (_cmd: string, _args: string[], ...rest: any[]) => {
        callIndex++;
        const cb = rest.find((a: any) => typeof a === 'function');
        if (callIndex === 1) {
          // ffprobe: 15.1 seconds
          if (cb) cb(null, `${_testing.MAX_REFERENCE_SECONDS + 0.1}\n`, '');
        } else {
          // ffmpeg trim
          if (cb) cb(null, '', '');
        }
      };

      const result = await _testing.ensureReferenceAudio('/test/slightly-long.wav');
      assert.strictEqual(result, '/test/slightly-long_trimmed.wav');
    });
  });

  // ── buildModelTools ──

  describe('buildModelTools', () => {
    it('returns empty object when no configs provided', () => {
      const tools = buildModelTools([], []);
      assert.strictEqual(tools.image, undefined);
      assert.strictEqual(tools.tts, undefined);
    });

    it('creates image tool when image config provided', () => {
      const tools = buildModelTools(
        [{ name: 'test-image', config: { modelPath: '/test/model.gguf', description: 'Test' } }],
        [],
      );
      assert.ok(tools.image);
      assert.strictEqual(tools.image.name, 'generate_image');
      assert.ok(tools.image.description.includes('test-image'));
    });

    it('creates TTS tool when TTS config provided', () => {
      const tools = buildModelTools(
        [],
        [{ name: 'test-tts', config: { modelPath: '/test/tts-model', description: 'Test TTS' } }],
      );
      assert.ok(tools.tts);
      assert.strictEqual(tools.tts.name, 'generate_tts');
      assert.ok(tools.tts.description.includes('test-tts'));
    });

    it('TTS tool description mentions supported audio formats', () => {
      const tools = buildModelTools(
        [],
        [{ name: 'test-tts', config: { modelPath: '/test/tts-model', description: '' } }],
      );
      // The referenceAudio param description should mention non-WAV formats
      const schema = tools.tts!.schema as any;
      const refAudioDesc = schema.shape?.referenceAudio?._def?.description ?? '';
      assert.ok(refAudioDesc.includes('MP3'), 'Should mention MP3 support');
      assert.ok(refAudioDesc.includes('M4A'), 'Should mention M4A support');
    });

    it('creates both tools when both configs provided', () => {
      const tools = buildModelTools(
        [{ name: 'img', config: { modelPath: '/m.gguf', description: '' } }],
        [{ name: 'tts', config: { modelPath: '/t', description: '' } }],
      );
      assert.ok(tools.image);
      assert.ok(tools.tts);
    });

    it('uses only the first config when multiple provided', () => {
      const tools = buildModelTools(
        [
          { name: 'first-img', config: { modelPath: '/first.gguf', description: 'First' } },
          { name: 'second-img', config: { modelPath: '/second.gguf', description: 'Second' } },
        ],
        [],
      );
      assert.ok(tools.image!.description.includes('first-img'));
    });
  });
});
