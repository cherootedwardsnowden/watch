const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const db = require('./db');

if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
if (ffprobeStatic && ffprobeStatic.path) ffmpeg.setFfprobePath(ffprobeStatic.path);

const ROOT = __dirname;
const UPLOAD_TMP = path.join(ROOT, 'data', 'uploads_tmp');
const VIDEO_DIR = path.join(ROOT, 'data', 'videos');
const HLS_DIR = path.join(ROOT, 'data', 'hls');
const PREVIEW_DIR = path.join(ROOT, 'data', 'previews');
const THUMB_DIR = path.join(ROOT, 'data', 'thumbs');

for (const d of [UPLOAD_TMP, VIDEO_DIR, HLS_DIR, PREVIEW_DIR, THUMB_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const PREVIEW_SECONDS = parseInt(process.env.PREVIEW_DURATION || '15', 10);
const FFMPEG_THREADS = parseInt(process.env.FFMPEG_THREADS || '1', 10);
const FFMPEG_MAX_HEIGHT = parseInt(process.env.FFMPEG_MAX_HEIGHT || '1080', 10);

const processingQueue = [];
let isProcessing = false;

function probe(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

function generateAesKey() {
  return crypto.randomBytes(16);
}

function generateIv() {
  return crypto.randomBytes(16);
}

function ensureVideoDirs(videoId) {
  const hlsFull = path.join(HLS_DIR, videoId, 'full');
  const hlsPrev = path.join(HLS_DIR, videoId, 'preview');
  const thumbDir = path.join(THUMB_DIR, videoId);
  for (const d of [hlsFull, hlsPrev, thumbDir]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return { hlsFull, hlsPrev, thumbDir };
}

function cleanupHlsDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.ts') || f.endsWith('.m3u8')) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
    }
  }
}

function runFfmpeg(buildCmd) {
  return new Promise((resolve, reject) => {
    const cmd = buildCmd();
    let stderrTail = '';
    let cmdLine = '';
    cmd
      .on('start', (line) => { cmdLine = line; })
      .on('stderr', (line) => {
        stderrTail += line + '\n';
        if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-6000);
      })
      .on('end', () => resolve({ cmdLine, stderrTail }))
      .on('error', (err) => {
        const e = new Error(`${err.message}${cmdLine ? '\n--cmd--\n' + cmdLine : ''}\n--stderr--\n${stderrTail.slice(-2000)}`);
        e.original = err;
        e.stderrTail = stderrTail;
        e.cmdLine = cmdLine;
        reject(e);
      })
      .run();
  });
}

function buildHlsCommonOpts({ segmentFile, keyInfo, hlsTime }) {
  return [
    '-hls_time', String(hlsTime),
    '-hls_list_size', '0',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', segmentFile,
    '-hls_key_info_file', keyInfo,
    '-hls_flags', 'independent_segments+temp_file',
    '-threads', String(FFMPEG_THREADS),
    '-f', 'hls'
  ];
}

function processVideo(videoId, sourcePath, originalName, title, description) {
  return new Promise(async (resolve, reject) => {
    try {
      const probeData = await probe(sourcePath);
      const vstream = probeData.streams.find(s => s.codec_type === 'video');
      const astream = probeData.streams.find(s => s.codec_type === 'audio');
      const duration = parseFloat(probeData.format.duration || 0);
      const width = vstream?.width || 0;
      const height = vstream?.height || 0;
      const vcodec = (vstream?.codec_name || '').toLowerCase();
      const acodec = (astream?.codec_name || '').toLowerCase();

      console.log(`[video] ${videoId} probe: ${vcodec} ${width}x${height} ${duration.toFixed(1)}s, audio=${acodec || 'none'}`);

      const dirs = ensureVideoDirs(videoId);
      const aesKey = generateAesKey();
      const aesIv = generateIv();

      const keyFilePath = path.join(dirs.hlsFull, 'enc.key');
      const keyInfoPath = path.join(dirs.hlsFull, 'enc.keyinfo');
      fs.writeFileSync(keyFilePath, aesKey);
      fs.writeFileSync(keyInfoPath, `key.bin\n${keyFilePath}\n${aesIv.toString('hex')}\n`);

      const fullPlaylist = path.join(dirs.hlsFull, 'index.m3u8');
      const fullSegments = path.join(dirs.hlsFull, 'seg_%05d.ts');

      const canCopyVideo = vcodec === 'h264' || vcodec === 'avc1';
      const canCopyAudio = !astream || acodec === 'aac' || acodec === 'mp3';
      const needsScale = height > FFMPEG_MAX_HEIGHT;

      const tooBigForCopy = (probeData.format.size && probeData.format.size > 4 * 1024 * 1024 * 1024);

      let usedCopy = false;
      const tryStrategy = async (strategy) => {
        cleanupHlsDir(dirs.hlsFull);
        return runFfmpeg(() => {
          const cmd = ffmpeg(sourcePath);
          const opts = [];

          if (strategy === 'copy') {
            opts.push('-c:v', 'copy');
            if (canCopyVideo) opts.push('-bsf:v', 'h264_mp4toannexb');
            if (astream) {
              if (canCopyAudio) opts.push('-c:a', 'copy');
              else opts.push('-c:a', 'aac', '-b:a', '128k');
            } else {
              opts.push('-an');
            }
          } else {
            opts.push(
              '-c:v', 'libx264',
              '-preset', 'ultrafast',
              '-crf', '26',
              '-pix_fmt', 'yuv420p',
              '-profile:v', 'main',
              '-level', '4.0'
            );
            if (needsScale) {
              opts.push('-vf', `scale=-2:${FFMPEG_MAX_HEIGHT}`);
            }
            if (astream) opts.push('-c:a', 'aac', '-b:a', '128k');
            else opts.push('-an');
          }

          opts.push(...buildHlsCommonOpts({
            segmentFile: fullSegments,
            keyInfo: keyInfoPath,
            hlsTime: 6
          }));

          return cmd.outputOptions(opts).output(fullPlaylist);
        });
      };

      if (canCopyVideo && canCopyAudio && !needsScale && !tooBigForCopy) {
        try {
          console.log(`[video] ${videoId} attempting stream copy (fast path)`);
          await tryStrategy('copy');
          usedCopy = true;
          console.log(`[video] ${videoId} stream copy OK`);
        } catch (e) {
          console.warn(`[video] ${videoId} copy failed, falling back to transcode: ${e.original?.message || e.message}`);
        }
      }
      if (!usedCopy) {
        console.log(`[video] ${videoId} transcoding (ultrafast)`);
        await tryStrategy('transcode');
        console.log(`[video] ${videoId} transcode OK`);
      }

      const previewKeyFile = path.join(dirs.hlsPrev, 'enc.key');
      const previewKeyInfo = path.join(dirs.hlsPrev, 'enc.keyinfo');
      const previewKey = generateAesKey();
      const previewIv = generateIv();
      fs.writeFileSync(previewKeyFile, previewKey);
      fs.writeFileSync(previewKeyInfo, `key.bin\n${previewKeyFile}\n${previewIv.toString('hex')}\n`);

      const previewPlaylist = path.join(dirs.hlsPrev, 'index.m3u8');
      const previewSegments = path.join(dirs.hlsPrev, 'seg_%05d.ts');
      const previewLen = Math.min(PREVIEW_SECONDS, Math.max(1, Math.floor(duration)));

      cleanupHlsDir(dirs.hlsPrev);
      console.log(`[video] ${videoId} encoding ${previewLen}s preview`);
      await runFfmpeg(() => {
        const c = ffmpeg(sourcePath)
          .setStartTime(0)
          .setDuration(previewLen)
          .outputOptions([
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '28',
            '-pix_fmt', 'yuv420p',
            '-profile:v', 'main',
            '-vf', 'scale=-2:480',
            ...(astream ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an']),
            ...buildHlsCommonOpts({
              segmentFile: previewSegments,
              keyInfo: previewKeyInfo,
              hlsTime: 4
            })
          ])
          .output(previewPlaylist);
        return c;
      });

      const thumbTime = Math.min(Math.max(duration / 2, 1), Math.max(duration - 1, 1));
      console.log(`[video] ${videoId} extracting thumbnail at ${thumbTime.toFixed(1)}s`);
      await new Promise((res, rej) => {
        ffmpeg(sourcePath)
          .screenshots({
            timestamps: [thumbTime],
            filename: 'thumb.jpg',
            folder: dirs.thumbDir,
            size: '1280x?'
          })
          .on('end', res)
          .on('error', rej);
      });

      const posterPath = path.join(dirs.thumbDir, 'poster.jpg');
      try {
        await new Promise((res, rej) => {
          ffmpeg(sourcePath)
            .screenshots({
              timestamps: [Math.min(1, duration * 0.05)],
              filename: 'poster.jpg',
              folder: dirs.thumbDir,
              size: '640x?'
            })
            .on('end', res)
            .on('error', rej);
        });
      } catch (e) {
        try { fs.copyFileSync(path.join(dirs.thumbDir, 'thumb.jpg'), posterPath); } catch (e2) {}
      }

      try { fs.unlinkSync(sourcePath); } catch (e) {}

      const updated = db.update('videos', videoId, {
        status: 'ready',
        duration,
        width,
        height,
        title,
        description,
        originalName,
        readyAt: Date.now(),
        encodedWith: usedCopy ? 'copy' : 'transcode'
      });

      console.log(`[video] ${videoId} READY (${usedCopy ? 'copy' : 'transcode'})`);
      resolve(updated);
    } catch (e) {
      console.error(`[video] ${videoId} FAILED:`, e.message);
      db.update('videos', videoId, {
        status: 'failed',
        error: (e.message || 'unknown').slice(0, 4000),
        failedAt: Date.now()
      });
      try { fs.unlinkSync(sourcePath); } catch (_) {}
      reject(e);
    }
  });
}

async function runQueue() {
  if (isProcessing) return;
  isProcessing = true;
  while (processingQueue.length) {
    const job = processingQueue.shift();
    try {
      console.log(`[video] processing ${job.videoId}`);
      await processVideo(job.videoId, job.sourcePath, job.originalName, job.title, job.description);
      console.log(`[video] done ${job.videoId}`);
    } catch (e) {
      console.error(`[video] failed ${job.videoId}:`, e.message);
    }
  }
  isProcessing = false;
}

function enqueueProcessing(job) {
  processingQueue.push(job);
  setImmediate(runQueue);
}

function getKeyForVideo(videoId, mode) {
  const dir = path.join(HLS_DIR, videoId, mode === 'preview' ? 'preview' : 'full');
  const keyPath = path.join(dir, 'enc.key');
  if (!fs.existsSync(keyPath)) return null;
  return fs.readFileSync(keyPath);
}

function getPlaylistForVideo(videoId, mode, transformLineFn) {
  const dir = path.join(HLS_DIR, videoId, mode === 'preview' ? 'preview' : 'full');
  const m3u8Path = path.join(dir, 'index.m3u8');
  if (!fs.existsSync(m3u8Path)) return null;
  const raw = fs.readFileSync(m3u8Path, 'utf8');
  const lines = raw.split('\n').map(line => transformLineFn(line));
  return lines.join('\n');
}

function getSegmentPath(videoId, mode, segName) {
  if (!/^seg_\d{5}\.ts$/.test(segName)) return null;
  const p = path.join(HLS_DIR, videoId, mode === 'preview' ? 'preview' : 'full', segName);
  if (!fs.existsSync(p)) return null;
  return p;
}

function getThumb(videoId, kind) {
  const file = kind === 'poster' ? 'poster.jpg' : 'thumb.jpg';
  const p = path.join(THUMB_DIR, videoId, file);
  if (!fs.existsSync(p)) return null;
  return p;
}

function deleteVideoFiles(videoId) {
  for (const dir of [path.join(HLS_DIR, videoId), path.join(THUMB_DIR, videoId)]) {
    if (fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }
  }
}

module.exports = {
  ROOT,
  UPLOAD_TMP,
  VIDEO_DIR,
  HLS_DIR,
  PREVIEW_DIR,
  THUMB_DIR,
  enqueueProcessing,
  getKeyForVideo,
  getPlaylistForVideo,
  getSegmentPath,
  getThumb,
  deleteVideoFiles,
  PREVIEW_SECONDS
};
