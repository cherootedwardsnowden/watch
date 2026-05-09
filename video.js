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

function processVideo(videoId, sourcePath, originalName, title, description) {
  return new Promise(async (resolve, reject) => {
    try {
      const probeData = await probe(sourcePath);
      const stream = probeData.streams.find(s => s.codec_type === 'video');
      const duration = parseFloat(probeData.format.duration || 0);
      const width = stream?.width || 0;
      const height = stream?.height || 0;

      const dirs = ensureVideoDirs(videoId);
      const aesKey = generateAesKey();
      const aesIv = generateIv();

      const keyFilePath = path.join(dirs.hlsFull, 'enc.key');
      const keyInfoPath = path.join(dirs.hlsFull, 'enc.keyinfo');
      fs.writeFileSync(keyFilePath, aesKey);
      const keyUriInPlaylist = `key.bin`;
      fs.writeFileSync(keyInfoPath, `${keyUriInPlaylist}\n${keyFilePath}\n${aesIv.toString('hex')}\n`);

      const fullPlaylist = path.join(dirs.hlsFull, 'index.m3u8');
      const fullSegments = path.join(dirs.hlsFull, 'seg_%05d.ts');

      await new Promise((res, rej) => {
        ffmpeg(sourcePath)
          .outputOptions([
            '-c:v libx264',
            '-preset veryfast',
            '-crf 22',
            '-c:a aac',
            '-b:a 128k',
            '-hls_time 6',
            '-hls_list_size 0',
            '-hls_playlist_type vod',
            '-hls_segment_filename', fullSegments,
            '-hls_key_info_file', keyInfoPath,
            '-f hls'
          ])
          .output(fullPlaylist)
          .on('end', res)
          .on('error', rej)
          .run();
      });

      const previewKeyFile = path.join(dirs.hlsPrev, 'enc.key');
      const previewKeyInfo = path.join(dirs.hlsPrev, 'enc.keyinfo');
      const previewKey = generateAesKey();
      const previewIv = generateIv();
      fs.writeFileSync(previewKeyFile, previewKey);
      fs.writeFileSync(previewKeyInfo, `key.bin\n${previewKeyFile}\n${previewIv.toString('hex')}\n`);

      const previewPlaylist = path.join(dirs.hlsPrev, 'index.m3u8');
      const previewSegments = path.join(dirs.hlsPrev, 'seg_%05d.ts');

      const previewLen = Math.min(PREVIEW_SECONDS, Math.max(1, Math.floor(duration)));

      await new Promise((res, rej) => {
        ffmpeg(sourcePath)
          .setStartTime(0)
          .setDuration(previewLen)
          .outputOptions([
            '-c:v libx264',
            '-preset veryfast',
            '-crf 24',
            '-c:a aac',
            '-b:a 96k',
            '-hls_time 4',
            '-hls_list_size 0',
            '-hls_playlist_type vod',
            '-hls_segment_filename', previewSegments,
            '-hls_key_info_file', previewKeyInfo,
            '-f hls'
          ])
          .output(previewPlaylist)
          .on('end', res)
          .on('error', rej)
          .run();
      });

      const thumbPath = path.join(dirs.thumbDir, 'thumb.jpg');
      const thumbTime = Math.min(Math.max(duration / 2, 1), Math.max(duration - 1, 1));
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
        fs.copyFileSync(thumbPath, posterPath);
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
        readyAt: Date.now()
      });

      resolve(updated);
    } catch (e) {
      db.update('videos', videoId, { status: 'failed', error: e.message });
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
