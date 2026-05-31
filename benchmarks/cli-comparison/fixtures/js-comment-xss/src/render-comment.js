const sanitizeHtml = require('sanitize-html');

/**
 * Render a user-submitted comment with limited formatting.
 *
 * Seeded bug: sanitizer is misconfigured to allow all attributes on all tags,
 * enabling event-handler injection (e.g., <img onerror="...">).
 */
function renderComment(rawHtml) {
  return sanitizeHtml(rawHtml, {
    allowedTags: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'span', 'img'],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt'],
      // BUG: allows everything (including onerror, style, etc.)
      '*': ['*'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
    },
  });
}

module.exports = { renderComment };
