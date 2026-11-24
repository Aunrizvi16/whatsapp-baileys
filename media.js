// Turns the "media" part of an API request into a file ready to send on WhatsApp:
// download it (url) or decode it (base64), check size and real file type, and convert
// voice notes to the format WhatsApp plays as a voice message.
const { spawn } = require('child_process');
const path = require('path');
const safeHttp = require('./safe-http');

const MB = 1024 * 1024;
// WhatsApp's own limits.
const LIMITS = { image: 5 * MB, video: 16 * MB, audio: 16 * MB, voice: 16 * MB, document: 50 * MB, sticker: 1 * MB };

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// What the bytes really are, from the first bytes of the file.
function sniff(b) {
  if (b.length < 12) return null;
  const s4 = b.subarray(0, 4).toString('latin1');
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (s4 === '\x89PNG') return 'image/png';
  if (s4 === 'GIF8') return 'image/gif';
  if (s4 === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (s4 === '%PDF') return 'application/pdf';
  if (s4 === 'OggS') return 'audio/ogg';
  if (s4 === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  if (s4 === 'fLaC') return 'audio/flac';
  if (s4 === 'ID3\x03' || s4.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('latin1');
    if (/^(M4A|M4B)/.test(brand)) return 'audio/mp4';
    if (/^(3gp|3g2)/.test(brand)) return 'video/3gpp';
    return 'video/mp4';
  }
  if (s4 === '\x1aE\xdf\xa3') return 'video/webm';
  if (s4 === 'PK\x03\x04') return 'application/zip';
  return null;
}

const EXT_MIME = {
  '.pdf': 'application/pdf', '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv', '.txt': 'text/plain', '.json': 'application/json', '.zip': 'application/zip',
};

// Which file types each message type accepts (checked against the real bytes).
const ACCEPT = {
  image: (m) => /^image\/(jpeg|png|gif|webp)$/.test(m),
  video: (m) => /^video\/(mp4|3gpp|webm)$/.test(m),
  audio: (m) => /^audio\//.test(m),
  voice: (m) => /^audio\//.test(m),
  sticker: (m) => m === 'image/webp',
  document: () => true,
};

function decodeBase64(data) {
  const clean = String(data).replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) throw httpError(400, 'media.base64 is not valid base64.');
  return Buffer.from(clean, 'base64');
}

// media: { url } | { base64, mimetype? }. `upload` is a file from a multipart request.
async function load(type, media, upload) {
  const limit = LIMITS[type];
  if (!limit) throw httpError(400, `"${type}" does not take a file.`);
  let buf, declared, name;
  if (upload) {
    buf = upload.data; declared = upload.mimetype; name = upload.filename;
  } else if (media?.url) {
    const r = await safeHttp.get(media.url, { maxBytes: limit });
    if (r.status !== 200) throw httpError(422, `Could not download the file: the address answered ${r.status}.`);
    buf = r.body;
    declared = String(r.headers['content-type'] || '').split(';')[0].trim();
    try { name = decodeURIComponent(path.basename(new URL(media.url).pathname)); } catch { name = ''; }
  } else if (media?.base64) {
    buf = decodeBase64(media.base64);
    declared = media.mimetype;
  } else {
    throw httpError(400, '"media" needs a "url" or "base64" (or send the file as a multipart upload).');
  }
  if (!buf.length) throw httpError(400, 'The file is empty.');
  if (buf.length > limit) throw httpError(413, `A ${type} can be at most ${Math.round(limit / MB)} MB (this one is ${(buf.length / MB).toFixed(1)} MB).`);
  const real = sniff(buf);
  // Pictures, videos and stickers must be recognisable from their content: a label is not enough.
  if (!real && ['image', 'video', 'sticker'].includes(type)) throw httpError(415, `This file does not look like a ${type === 'sticker' ? 'WebP sticker' : type}. Check the file and try again.`);
  const mimetype = real || (declared && declared !== 'application/octet-stream' ? declared : null) || EXT_MIME[path.extname(name || '').toLowerCase()] || 'application/octet-stream';
  if (!ACCEPT[type](mimetype)) {
    throw httpError(415, `This file is ${mimetype}, which cannot be sent as a ${type}.`);
  }
  return { data: buf, mimetype, filename: name || null };
}

// Voice notes must be Ogg/Opus to show up as a voice message.
function isOpusOgg(buf) {
  return buf.subarray(0, 4).toString('latin1') === 'OggS' && buf.includes(Buffer.from('OpusHead'));
}

function toOpus(buf) {
  return new Promise((resolve, reject) => {
    const ff = spawn(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-f', 'ogg', 'pipe:1']);
    const out = [];
    let err = '';
    const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(httpError(504, 'Converting the audio took too long.')); }, 30000);
    ff.stdout.on('data', (c) => out.push(c));
    ff.stderr.on('data', (c) => { err += c; });
    ff.on('error', (e) => {
      clearTimeout(timer);
      reject(httpError(415, e.code === 'ENOENT'
        ? 'This audio is not Ogg/Opus and ffmpeg is not installed on the server to convert it. Send audio/ogg (Opus) or install ffmpeg.'
        : `Could not convert the audio: ${e.message}`));
    });
    ff.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !out.length) return reject(httpError(422, `Could not convert the audio${err ? `: ${err.trim().slice(0, 200)}` : '.'}`));
      resolve(Buffer.concat(out));
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(buf);
  });
}

async function voice(file) {
  if (isOpusOgg(file.data)) return { ...file, mimetype: 'audio/ogg; codecs=opus' };
  return { ...file, data: await toOpus(file.data), mimetype: 'audio/ogg; codecs=opus' };
}

module.exports = { load, voice, sniff, LIMITS, isOpusOgg };
