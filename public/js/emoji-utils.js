// Emoji detection and fallback utility
// Detects if browser supports emoji rendering and provides appropriate icons

let supportsEmoji = null;

/**
 * Detect if browser supports emoji rendering
 */
function detectEmojiSupport() {
    if (supportsEmoji !== null) {
        return supportsEmoji;
    }

    // Simple but effective: Check if browser is likely to support emoji
    // Modern browsers (Chrome, Firefox, Safari, Edge Chromium) support emoji well
    // Older Edge/IE don't
    try {
        const userAgent = navigator.userAgent;

        // Check for old Edge (EdgeHTML) or IE - these have poor emoji support
        const isOldEdge = /Edge\/\d+/.test(userAgent) && !/Edg\/\d+/.test(userAgent);
        const isIE = /MSIE|Trident/.test(userAgent);

        if (isOldEdge || isIE) {
            supportsEmoji = false;
            return false;
        }

        // All modern browsers support emoji
        // Chrome, Firefox, Safari, new Edge (Chromium)
        supportsEmoji = true;
        return true;

    } catch (e) {
        // If something fails, assume emoji support (most modern browsers)
        supportsEmoji = true;
        return true;
    }
}

/**
 * Icon mapping with emoji and HTML entity fallbacks
 */
const icons = {
    checkmark: {
        emoji: '✓',
        html: '&#10004;',
        svg: null
    },
    cross: {
        emoji: '✗',
        html: '&#10008;',
        svg: null
    },
    warning: {
        emoji: '⚠️',
        html: '&#9888;',
        svg: null
    },
    trash: {
        emoji: '🗑️',
        html: '&#128465;',
        svg: null
    },
    circle: {
        emoji: '○',
        html: '&#9675;',
        svg: null
    },
    folder: {
        emoji: '📁',
        html: null,
        svg: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>'
    },
    download: {
        emoji: '⬇️',
        html: '&#11015;',
        svg: null
    },
    upload: {
        emoji: '⬆️',
        html: '&#11014;',
        svg: null
    },
    size: {
        emoji: '📊',
        html: '&#128202;',
        svg: null
    },
    calendar: {
        emoji: '📅',
        html: '&#128197;',
        svg: null
    },
    clock: {
        emoji: '🕐',
        html: '&#128336;',
        svg: null
    }
};

/**
 * Get the appropriate icon based on browser support
 * @param {string} iconName - Name of the icon
 * @param {boolean} preferSvg - If true, prefer SVG over emoji even if supported
 * @returns {string} Icon string (emoji, HTML entity, or SVG)
 */
function getIcon(iconName, preferSvg = false) {
    const icon = icons[iconName];
    if (!icon) {
        console.warn(`Icon "${iconName}" not found`);
        return '';
    }

    // If SVG is preferred and available
    if (preferSvg && icon.svg) {
        return icon.svg;
    }

    // Check emoji support
    const hasEmojiSupport = detectEmojiSupport();

    // Use emoji if supported
    if (hasEmojiSupport && icon.emoji) {
        return icon.emoji;
    }

    // Fallback to SVG if available
    if (icon.svg) {
        return icon.svg;
    }

    // Final fallback to HTML entity
    return icon.html || '';
}

// Export for use in other scripts
window.getIcon = getIcon;
window.detectEmojiSupport = detectEmojiSupport;

// Development logging (can be removed in production)
/*console.log('Emoji support:', detectEmojiSupport());
console.log('User Agent:', navigator.userAgent);
console.log('Testing getIcon():');
console.log('  checkmark:', getIcon('checkmark'));
console.log('  warning:', getIcon('warning'));
console.log('  trash:', getIcon('trash'));
console.log('  folder:', getIcon('folder'));
console.log('  folder (preferSvg):', getIcon('folder', true));
console.log('  size:', getIcon('size'));
console.log('  calendar:', getIcon('calendar'));
console.log('  clock:', getIcon('clock'));
*/