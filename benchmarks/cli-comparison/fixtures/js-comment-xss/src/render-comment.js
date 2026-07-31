const sanitizeHtml = require('sanitize-html');

/**
 * Render a user-submitted comment with limited formatting.
 */
function renderComment(rawHtml) {
  return sanitizeHtml(rawHtml, {
    allowedTags: ['b', 'i', 'em', 'strong', 'a', 'p', 'br', 'span', 'img'],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'alt'],
      '*': ['*'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
    },
  });
}

module.exports = { renderComment };
