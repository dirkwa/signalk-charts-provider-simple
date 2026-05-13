// Emoji detection and fallback utility
// Detects if browser supports emoji rendering and provides appropriate icons

interface IconEntry {
  emoji: string | null;
  html: string | null;
  svg: string | null;
}

let supportsEmoji: boolean | null = null;

/**
 * Detect if browser supports emoji rendering
 */
function detectEmojiSupport(): boolean {
  if (supportsEmoji !== null) {
    return supportsEmoji;
  }

  // Simple but effective: Check if browser is likely to support emoji.
  // Modern browsers (Chrome, Firefox, Safari, Edge Chromium) support
  // emoji well; older Edge/IE don't.
  try {
    const userAgent = navigator.userAgent;

    // Old Edge (EdgeHTML) and IE have poor emoji support.
    const isOldEdge = /Edge\/\d+/.test(userAgent) && !/Edg\/\d+/.test(userAgent);
    const isIE = /MSIE|Trident/.test(userAgent);

    if (isOldEdge || isIE) {
      supportsEmoji = false;
      return false;
    }

    supportsEmoji = true;
    return true;
  } catch {
    supportsEmoji = true;
    return true;
  }
}

/**
 * Icon mapping with emoji and HTML entity fallbacks
 */
const icons: Record<string, IconEntry> = {
  checkmark: { emoji: '✓', html: '&#10004;', svg: null },
  cross: { emoji: '✗', html: '&#10008;', svg: null },
  warning: { emoji: '⚠️', html: '&#9888;', svg: null },
  trash: { emoji: '🗑️', html: '&#128465;', svg: null },
  circle: { emoji: '○', html: '&#9675;', svg: null },
  folder: {
    emoji: '📁',
    html: null,
    svg: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>'
  },
  download: { emoji: '⬇️', html: '&#11015;', svg: null },
  upload: { emoji: '⬆️', html: '&#11014;', svg: null },
  size: { emoji: '📊', html: '&#128202;', svg: null },
  calendar: { emoji: '📅', html: '&#128197;', svg: null },
  clock: { emoji: '🕐', html: '&#128336;', svg: null },
  info: {
    emoji: 'ℹ️',
    html: '&#8505;',
    svg: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>'
  }
};

/**
 * Get the appropriate icon based on browser support.
 */
function getIcon(iconName: string, preferSvg = false): string {
  const icon = icons[iconName];
  if (!icon) {
    console.warn(`Icon "${iconName}" not found`);
    return '';
  }

  if (preferSvg && icon.svg) {
    return icon.svg;
  }

  const hasEmojiSupport = detectEmojiSupport();

  // Explicit null check: an empty string emoji is unlikely (and absent
  // from current entries) but the type permits it; we still want to fall
  // through to the SVG/HTML branch in that case rather than rendering '' .
  if (hasEmojiSupport && icon.emoji !== null && icon.emoji !== '') {
    return icon.emoji;
  }

  if (icon.svg) {
    return icon.svg;
  }

  return icon.html ?? '';
}

window.getIcon = getIcon;
window.detectEmojiSupport = detectEmojiSupport;
