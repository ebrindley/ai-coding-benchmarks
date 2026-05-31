const { renderComment } = require('../src/render-comment.js');

describe('stored XSS fixture', () => {
  test('blocks-script-tags', () => {
    const out = renderComment('<p>Hello</p><script>alert(1)</script>');
    expect(out).toContain('<p>Hello</p>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  test('strips-event-handlers', () => {
    const out = renderComment('<img src="x" onerror="alert(1)">');
    expect(out).toContain('<img');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('alert(1)');
  });

  test('preserves-safe-html', () => {
    const out = renderComment('<strong>Hi</strong> <a href="https://example.com">link</a>');
    expect(out).toContain('<strong>Hi</strong>');
    expect(out).toContain('<a');
    expect(out).toContain('href="https://example.com"');
  });

  test('blocks-javascript-urls', () => {
    const out = renderComment('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('alert(1)');
  });
});
