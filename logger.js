// Copies everything the server prints (console.log / warn / error) into MongoDB's
// "logs" collection, tagged with the business when the line starts with "[name]".
// Lines still go to the console as before (Railway's log view keeps working).
// Writes are batched every 2 seconds; lines printed before MongoDB connects are
// held (up to MAX_QUEUE) and saved once it's ready.
const util = require('util');
const db = require('./db');

// Which server wrote the line. Railway and a local copy share one database, so
// without this their lines for the same business get mixed together.
const SERVER = process.env.SERVER_NAME || (process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID ? 'railway' : 'local');

const FLUSH_MS = 2000;
const MAX_QUEUE = 5000;
const MAX_LINE = 4000;

let queue = [];
let flushing = false;
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      original[level].apply(console, args);
      capture(level === 'log' ? 'info' : level, args);
    };
  }
  setInterval(() => flush(original.error), FLUSH_MS).unref();
}

function capture(level, args) {
  let message = util.format(...args);
  if (!message.trim()) return;
  // QR codes drawn with block characters are noise in a log database.
  if (/^[\s█▄▀]+$/.test(message)) return;
  if (message.length > MAX_LINE) message = `${message.slice(0, MAX_LINE)}...`;
  const tag = /^\[([a-zA-Z0-9_-]{1,40})\]/.exec(message);
  queue.push({ at: new Date(), level, server: SERVER, business: tag ? tag[1] : null, message });
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE); // drop oldest if the database is unreachable
}

async function flush(printError) {
  if (flushing || !queue.length || !db.isReady()) return;
  flushing = true;
  const batch = queue;
  queue = [];
  try {
    await db.insertLogs(batch);
  } catch (e) {
    queue = batch.concat(queue).slice(-MAX_QUEUE); // keep them and try again next time
    printError.call(console, 'Saving logs to MongoDB failed:', e.message); // original console: not logged again
  } finally {
    flushing = false;
  }
}

// Write whatever is waiting (used on shutdown).
const flushNow = () => flush(console.error);

module.exports = { install, flushNow, SERVER };
