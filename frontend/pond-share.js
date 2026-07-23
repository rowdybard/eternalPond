(function pondShareModule() {
  'use strict';

  const CARD_WIDTH = 1200;
  const CARD_HEIGHT = 630;
  const DEFAULT_TINT = 0x79d1c2;
  const SENSITIVE_QUERY_KEYS = new Set([
    'pond',
    'claim',
    'token',
    'soultoken',
    'credential',
    'email',
    'code',
    'session_id',
    'checkout_session_id',
    'payment_intent',
    'subscription',
    'customer',
    'price',
    'connection',
    'pondws',
    'pondapi'
  ]);

  function safeText(value, fallback, maxLength) {
    const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (!text) return fallback;
    return text.slice(0, maxLength);
  }

  function tintColor(value) {
    const tint = typeof value === 'number'
      ? value
      : typeof value === 'string' && /^(?:0x|#)?[0-9a-f]{1,6}$/i.test(value)
        ? Number.parseInt(value.replace(/^(?:0x|#)/i, ''), 16)
        : DEFAULT_TINT;
    const bounded = Number.isFinite(tint) ? Math.max(0, Math.min(0xffffff, Math.trunc(tint))) : DEFAULT_TINT;
    return `#${bounded.toString(16).padStart(6, '0')}`;
  }

  function cleanShareUrl(value) {
    let url;
    try {
      url = new URL(value || window.location.href, window.location.origin);
    } catch (_) {
      url = new URL('/', window.location.origin);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') url = new URL('/', window.location.origin);
    url.username = '';
    url.password = '';
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString();
  }

  function roundedRect(context, x, y, width, height, radius) {
    const corner = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + corner, y);
    context.arcTo(x + width, y, x + width, y + height, corner);
    context.arcTo(x + width, y + height, x, y + height, corner);
    context.arcTo(x, y + height, x, y, corner);
    context.arcTo(x, y, x + width, y, corner);
    context.closePath();
  }

  function wrapLines(context, text, maxWidth, maxLines) {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (context.measureText(candidate).width <= maxWidth || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
      if (lines.length === maxLines) break;
    }
    if (lines.length < maxLines && current) lines.push(current);
    if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
      let finalLine = lines[maxLines - 1];
      while (finalLine && context.measureText(`${finalLine}…`).width > maxWidth) {
        finalLine = finalLine.slice(0, -1).trimEnd();
      }
      lines[maxLines - 1] = `${finalLine}…`;
    }
    return lines;
  }

  function drawFish(context, tint, keeperAccent) {
    context.save();
    context.translate(885, 323);

    context.fillStyle = 'rgba(0, 0, 0, 0.24)';
    context.beginPath();
    context.ellipse(4, 94, 190, 26, 0, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = tint;
    context.beginPath();
    context.moveTo(-150, 0);
    context.lineTo(-252, -78);
    context.quadraticCurveTo(-222, 0, -252, 78);
    context.closePath();
    context.fill();

    context.beginPath();
    context.ellipse(0, 0, 168, 91, -0.06, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = 'rgba(255, 255, 255, 0.17)';
    context.beginPath();
    context.ellipse(35, -31, 104, 23, -0.12, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = keeperAccent ? '#e8e3d2' : tint;
    context.beginPath();
    context.moveTo(-32, -70);
    context.quadraticCurveTo(24, -146, 69, -66);
    context.closePath();
    context.fill();

    context.fillStyle = '#071317';
    context.beginPath();
    context.arc(105, -22, 9, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#f0f1e8';
    context.beginPath();
    context.arc(108, -25, 3, 0, Math.PI * 2);
    context.fill();

    context.restore();
  }

  function drawCard(input) {
    const canvas = document.createElement('canvas');
    canvas.width = CARD_WIDTH;
    canvas.height = CARD_HEIGHT;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas is unavailable');

    const name = safeText(input && input.name, 'a quiet soul', 80);
    const status = safeText(input && input.status, 'lives in the shared water', 90);
    const age = safeText(input && input.age, '', 80);
    const passage = safeText(input && input.passage, '', 110);
    const dedication = safeText(input && input.dedication, '', 160);
    const tint = tintColor(input && input.tint);

    const background = context.createLinearGradient(0, 0, CARD_WIDTH, CARD_HEIGHT);
    background.addColorStop(0, '#06141b');
    background.addColorStop(0.54, '#0a2025');
    background.addColorStop(1, '#071116');
    context.fillStyle = background;
    context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

    context.fillStyle = 'rgba(232, 196, 119, 0.72)';
    [[100, 96, 2], [212, 148, 1.5], [424, 72, 1.7], [672, 116, 1.3], [1018, 80, 2], [1122, 162, 1.2]].forEach((star) => {
      context.beginPath();
      context.arc(star[0], star[1], star[2], 0, Math.PI * 2);
      context.fill();
    });

    const water = context.createRadialGradient(870, 402, 18, 870, 402, 350);
    water.addColorStop(0, 'rgba(121, 209, 194, 0.19)');
    water.addColorStop(1, 'rgba(121, 209, 194, 0)');
    context.fillStyle = water;
    context.fillRect(500, 120, 700, 510);

    context.strokeStyle = 'rgba(121, 209, 194, 0.24)';
    context.lineWidth = 2;
    [178, 240, 306].forEach((radius) => {
      context.beginPath();
      context.ellipse(874, 414, radius, radius * 0.31, 0, 0, Math.PI * 2);
      context.stroke();
    });

    context.fillStyle = '#e8c477';
    context.font = '600 20px Inter, ui-sans-serif, system-ui, sans-serif';
    context.letterSpacing = '2px';
    context.fillText('ETERNAL POND', 72, 78);

    context.fillStyle = '#f0f1e8';
    context.font = '600 62px Fraunces, Georgia, serif';
    const nameLines = wrapLines(context, name, 490, 2);
    nameLines.forEach((line, index) => context.fillText(line, 72, 185 + index * 69));

    const detailTop = 185 + nameLines.length * 69 + 16;
    context.fillStyle = '#a7b1aa';
    context.font = '400 24px Inter, ui-sans-serif, system-ui, sans-serif';
    wrapLines(context, status, 460, 2).forEach((line, index) => context.fillText(line, 74, detailTop + index * 34));

    const quietDetail = [age, passage].filter(Boolean).join(' · ');
    if (quietDetail) {
      context.fillStyle = 'rgba(240, 241, 232, 0.72)';
      context.font = '400 20px Fraunces, Georgia, serif';
      wrapLines(context, quietDetail, 470, 2).forEach((line, index) => context.fillText(line, 74, detailTop + 88 + index * 29));
    }

    if (dedication) {
      roundedRect(context, 72, 472, 478, 92, 12);
      context.fillStyle = 'rgba(7, 16, 19, 0.52)';
      context.fill();
      context.strokeStyle = 'rgba(185, 218, 209, 0.18)';
      context.stroke();
      context.fillStyle = 'rgba(240, 241, 232, 0.78)';
      context.font = '400 19px Fraunces, Georgia, serif';
      wrapLines(context, dedication, 430, 2).forEach((line, index) => context.fillText(line, 95, 509 + index * 27));
    }

    drawFish(context, tint, input && input.keeperAccent === true);

    context.fillStyle = 'rgba(167, 177, 170, 0.78)';
    context.font = '500 17px Inter, ui-sans-serif, system-ui, sans-serif';
    context.fillText('eternalpond.com', 928, 578);

    return canvas;
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('The pond could not paint a share card'));
      }, 'image/png');
    });
  }

  async function createCard(input) {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready.catch(() => undefined);
    }
    return canvasToBlob(drawCard(input || {}));
  }

  function cardFileName(name) {
    const stem = safeText(name, 'quiet-soul', 80)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'quiet-soul';
    return `${stem}-eternal-pond.png`;
  }

  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }

  async function shareSoul(input) {
    const details = input || {};
    const name = safeText(details.name, 'A quiet soul', 80);
    const url = cleanShareUrl(details.url);
    const text = `${name} is remembered in eternal pond.`;
    let blob = null;

    try {
      blob = await createCard(details);
    } catch (_) {
      blob = null;
    }

    if (blob && typeof File === 'function' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function') {
      const file = new File([blob], cardFileName(name), { type: 'image/png' });
      const shareData = { files: [file], title: name, text: `${text}\n${url}` };
      if (navigator.canShare(shareData)) {
        try {
          await navigator.share(shareData);
          return { method: 'file', blob };
        } catch (error) {
          if (error && error.name === 'AbortError') return { method: 'cancelled', blob };
        }
      }
    }

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: name, text, url });
        return { method: 'web', blob };
      } catch (error) {
        if (error && error.name === 'AbortError') return { method: 'cancelled', blob };
      }
    }

    let copied = false;
    try { copied = await copyText(url); }
    catch (_) { copied = false; }
    return { method: copied ? 'copy' : 'unavailable', blob };
  }

  const shareApi = Object.freeze({
    CARD_WIDTH,
    CARD_HEIGHT,
    cleanUrl: cleanShareUrl,
    createCard,
    share: shareSoul
  });
  for (const name of ['PondShareCard', 'PondShare']) {
    Object.defineProperty(window, name, {
      configurable: false,
      enumerable: false,
      value: shareApi,
      writable: false
    });
  }
}());
