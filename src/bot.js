// Default identifier matches subscription channel; index.js will pass the exact one
let gatewayIdentifierStr = JSON.stringify({ channel: "GatewayChannel" });
import { EventEmitter } from 'events';

let lastWs = null; // remember the most recent websocket provided by index.js events
let countdownTimerId = null;
let countdownRemaining = 0;
let countdownChannelId = null;
let countdownFinishMessage = 'Countdown finished';
let perTokenIncrementSeconds = 1; // default 1s per token when not specified
const overlayEmitter = new EventEmitter();

function parseDurationToSeconds(input) {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s) return NaN;
  // Support colon formats: mm:ss or hh:mm:ss
  if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(s)) {
    const parts = s.split(':').map(Number);
    if (parts.length === 2) {
      const [mm, ss] = parts;
      if (ss >= 60) return NaN;
      return mm * 60 + ss;
    } else if (parts.length === 3) {
      const [hh, mm, ss] = parts;
      if (mm >= 60 || ss >= 60) return NaN;
      return hh * 3600 + mm * 60 + ss;
    }
  }
  if (/^\d+$/.test(s)) return Number(s); // plain seconds
  let total = 0;
  let matched = false;
  const re = /(\d+)\s*([hms])/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2];
    if (!Number.isFinite(n)) return NaN;
    if (unit === 'h') total += n * 3600;
    else if (unit === 'm') total += n * 60;
    else total += n;
  }
  return matched ? total : NaN;
}

function formatDuration(seconds) {
  const sec = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

function getOverlayState() {
  return {
    running: !!countdownTimerId,
    remaining: Math.max(0, Number(countdownRemaining) || 0),
    formatted: formatDuration(countdownRemaining),
    perTokenIncrementSeconds: Number(perTokenIncrementSeconds) || 0,
    finishMessage: String(countdownFinishMessage || ''),
    channelId: countdownChannelId || null,
    ts: Date.now()
  };
}

function emitOverlayUpdate() {
  try { overlayEmitter.emit('update', getOverlayState()); } catch {}
}

function sendChat(ws, channelId, text) {
  try {
    const socket = ws || lastWs;
    if (!socket) {
      console.warn('No websocket available yet; cannot send chat');
      return;
    }
    const response = {
      command: 'message',
      identifier: gatewayIdentifierStr,
      data: JSON.stringify({ action: 'send_message', text, channelId })
    };
    socket.send(JSON.stringify(response));
  } catch (err) {
    console.error('Failed to send chat', err);
  }
}

function stopCountdown() {
  if (countdownTimerId) clearInterval(countdownTimerId);
  countdownTimerId = null;
}

function startCountdown(ws, channelId, startSeconds, finishMessage) {
  stopCountdown();
  countdownRemaining = Math.max(0, Number(startSeconds) || 0);
  countdownChannelId = channelId;
  countdownFinishMessage = String(finishMessage || 'Countdown finished');
  if (!Number.isFinite(perTokenIncrementSeconds) || perTokenIncrementSeconds < 0) {
    perTokenIncrementSeconds = 1;
  }

  if (countdownRemaining <= 0) {
    sendChat(ws, channelId, countdownFinishMessage);
    emitOverlayUpdate();
    return;
  }
  // Announce creation only once; avoid per-second chat spam
  sendChat(ws, channelId, `Countdown started: ${formatDuration(countdownRemaining)}`);
  emitOverlayUpdate();
  countdownTimerId = setInterval(() => {
    countdownRemaining -= 1;
    if (countdownRemaining <= 0) {
      stopCountdown();
      sendChat(ws, countdownChannelId, countdownFinishMessage);
      emitOverlayUpdate();
      return;
    }
    // Do not send per-second updates to chat; UI component will handle display
    emitOverlayUpdate();
  }, 1000);
}

function parseCountdownCommand(text) {
  // Supported:
  // #countdown start duration | per_token | message
  // #countdown start duration | message
  // #countdown add duration
  // #countdown set duration
  // #countdown stop
  // #countdown status
  const trimmed = String(text || '').trim();
  if (!trimmed.toLowerCase().startsWith('#countdown')) return null;
  const rest = trimmed.slice('#countdown'.length).trim();
  const sub = (rest.split(/\s+/)[0] || '').toLowerCase();
  const valueText = rest.slice(sub.length).trim();
  return { sub, valueText };
}

// Parse a leading duration from a string, returning seconds and how many
// characters were consumed. Accepts formats like:
// - 90 (seconds)
// - 1h 30m, 1h30m, 45s
// - 2:30 (mm:ss), 1:02:03 (hh:mm:ss)
function parseLeadingDuration(text) {
  const s = String(text ?? '').trim();
  if (!s) return { seconds: NaN, consumed: 0 };
  // Try colon format first
  const colonMatch = s.match(/^\s*(\d{1,2}:\d{2}(?::\d{2})?)(?:\s+|$)/);
  if (colonMatch) {
    const raw = colonMatch[1];
    const secs = parseDurationToSeconds(raw);
    return { seconds: secs, consumed: colonMatch[0].length };
  }
  // Try plain seconds at start
  const secondsMatch = s.match(/^\s*(\d+)(?:\s+|$)/);
  // Try h/m/s tokens sequence
  const tokenRe = /(\d+)\s*([hms])/y; // sticky
  let idx = 0;
  let total = 0;
  let matchedAnyToken = false;
  while (true) {
    tokenRe.lastIndex = idx;
    const m = tokenRe.exec(s);
    if (!m) break;
    matchedAnyToken = true;
    const n = Number(m[1]);
    const unit = m[2];
    if (unit === 'h') total += n * 3600; else if (unit === 'm') total += n * 60; else total += n;
    idx = tokenRe.lastIndex;
    // Allow one or more spaces between tokens
    const space = /\s*/y;
    space.lastIndex = idx;
    const sp = space.exec(s);
    if (sp) idx = space.lastIndex;
  }
  if (matchedAnyToken) {
    // Ensure boundary: next char, if any, must be whitespace
    const boundary = s.slice(idx);
    if (boundary.length === 0 || /^\s+/.test(boundary)) {
      const consumed = idx + (boundary.match(/^\s+/)?.[0].length || 0);
      return { seconds: total, consumed };
    }
  }
  if (secondsMatch) {
    const secs = Number(secondsMatch[1]);
    return { seconds: secs, consumed: secondsMatch[0].length };
  }
  return { seconds: NaN, consumed: 0 };
}

const Bot = {
  // Kept for compatibility with the example server code; not required by this minimal bot
  registerSender: (_ws, _identifier, _options = {}) => {
    // Optional: remember ws if provided by index.js on confirm_subscription
    if (_ws) lastWs = _ws;
    // Use the exact identifier index.js subscribed with (may include channelId)
    if (typeof _identifier === 'string' && _identifier.trim()) {
      gatewayIdentifierStr = _identifier;
    }
  },
  handleMessage: (ws, receivedMessage) => {
    // Remember the latest socket as soon as we receive any message (including ping)
    if (ws) lastWs = ws;
    if (receivedMessage.type === 'ping') return;

    if (!receivedMessage.message) return;
    const message = receivedMessage.message;

    // Handle tips to increment countdown
    if (message.event === 'StreamEvent' && message.type === 'Tipped') {
      try {
        const md = typeof message.metadata === 'string' ? JSON.parse(message.metadata) : (message.metadata || {});
        const howMany = Number(md?.how_much);
        if (countdownTimerId && message.channelId === countdownChannelId && perTokenIncrementSeconds > 0 && Number.isFinite(howMany) && howMany > 0) {
          countdownRemaining = Math.max(0, countdownRemaining + (howMany * perTokenIncrementSeconds));
          // No chat spam on tip increments; UI updates will reflect time
          emitOverlayUpdate();
        }
      } catch (e) {
        // Ignore malformed metadata
      }
      return;
    }

    if (message.type !== 'new_message') return;

    const channelId = message.channelId;
    const text = String(message.text || '');
    const isMod = message.author?.isModerator || message.author?.isStreamer;
    const lowers = text.trim().toLowerCase();
    if (lowers.startsWith('#countdown') && !isMod) {
     return;
    }
    const cmd = parseCountdownCommand(text);
    if (!cmd) return; // ignore non-countdown messages

    switch (cmd.sub) {
      case 'start': {
        const raw = String(cmd.valueText || '');
        if (raw.includes('|')) {
          const parts = raw.split('|');
          const durationPart = (parts[0] || '').trim();
          const seconds = parseDurationToSeconds(durationPart);
          if (!Number.isFinite(seconds) || seconds < 0) {
            sendChat(ws, channelId, 'Usage: #countdown start duration | per_token | message');
            return;
          }
          // If three parts: duration | per_token | message
          // If two parts: duration | message
          let incPerToken = 0;
          let finishMsg = '';
          if (parts.length >= 3) {
            const perPart = (parts[1] || '').trim();
            const inc = parseDurationToSeconds(perPart);
            if (!Number.isFinite(inc) || inc < 0) {
              sendChat(ws, channelId, 'Usage: #countdown start duration | per_token | message');
              return;
            }
            incPerToken = inc;
            finishMsg = parts.slice(2).join('|').trim();
          } else {
            // two-part form: duration | message (default per-token = 1s)
            finishMsg = (parts[1] || '').trim();
            incPerToken = 1;
          }
          perTokenIncrementSeconds = incPerToken;
          startCountdown(ws, channelId, seconds, finishMsg);
          return;
        }
        const { seconds, consumed } = parseLeadingDuration(raw);
        if (!Number.isFinite(seconds) || seconds < 0) {
          sendChat(ws, channelId, 'Usage: #countdown start duration | per_token | message');
          return;
        }
        const trailing = raw.slice(consumed).trim();
        if (trailing.length > 0) {
          sendChat(ws, channelId, 'Usage: #countdown start duration | per_token | message');
          return;
        }
        // no separator provided; default per-token = 1s
        perTokenIncrementSeconds = 1;
        startCountdown(ws, channelId, seconds, '');
        return;
      }
      case 'add': {
        const add = parseDurationToSeconds(cmd.valueText);
        if (!Number.isFinite(add)) {
          sendChat(ws, channelId, 'Usage: #countdown add duration');
          return;
        }
        if (!countdownTimerId) {
          sendChat(ws, channelId, 'No active countdown to add time to. Start one with #countdown start duration | per_token | message.');
          return;
        }
        countdownRemaining = Math.max(0, countdownRemaining + add);
        sendChat(ws, channelId, `Countdown updated: ${formatDuration(countdownRemaining)}`);
        emitOverlayUpdate();
        return;
      }
      case 'set': {
        const secs = parseDurationToSeconds(cmd.valueText);
        if (!Number.isFinite(secs) || secs < 0) {
          sendChat(ws, channelId, 'Usage: #countdown set duration');
          return;
        }
        if (!countdownTimerId) {
          // If no active countdown, start one at the set value
          startCountdown(ws, channelId, secs);
          return;
        }
        countdownRemaining = secs;
        sendChat(ws, channelId, `Countdown set: ${formatDuration(countdownRemaining)}`);
        emitOverlayUpdate();
        return;
      }
      case 'stop': {
        if (!countdownTimerId) {
          sendChat(ws, channelId, 'No active countdown to stop.');
          return;
        }
        stopCountdown();
        sendChat(ws, channelId, 'Countdown stopped');
        emitOverlayUpdate();
        return;
      }
      case 'status': {
        if (!countdownTimerId) {
          sendChat(ws, channelId, 'No active countdown.');
          return;
        }
        sendChat(ws, channelId, `Countdown: ${formatDuration(countdownRemaining)}`);
        return;
      }
      default: {
        sendChat(ws, channelId, 'Usage: #countdown start|add|set|stop|status');
        return;
      }
    }
  }
};

export default Bot;
export function onOverlayUpdate(listener) {
  overlayEmitter.on('update', listener);
  return () => overlayEmitter.off('update', listener);
}
export { getOverlayState };