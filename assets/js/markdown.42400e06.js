/* Shared, sanitized Markdown renderer for work details and the editor preview. */
(function () {
  'use strict';
  // A block extension keeps card markers inside fenced code blocks literal.
  var parser = new marked.Marked({ gfm: true, breaks: true });
  parser.use({ extensions: [{
    name: 'informationCard',
    level: 'block',
    start: function (source) { return source.match(/^:::card(?:\[[a-z]+\])?(?:[ \t]|\r?$)/m)?.index; },
    tokenizer: function (source) {
      var match = /^:::card(?:\[([a-z]+)\])?(?:[ \t]+([^\r\n]*))?[ \t]*\r?\n([\s\S]*?)^:::[ \t]*(?:\r?\n|$)/m.exec(source);
      if (!match || match.index !== 0) return;
      return {
        type: 'informationCard', raw: match[0], title: match[2] || '信息',
        variant: ['info', 'tip', 'warning', 'download', 'specs', 'steps', 'code', 'links'].includes(match[1]) ? match[1] : 'info',
        tokens: this.lexer.blockTokens(match[3])
      };
    },
    renderer: function (token) {
      var title = token.title.replace(/[&<>"']/g, function (character) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
      });
      return '<section class="information-card information-card-' + token.variant + '"><div class="information-card-title">' + title +
        '</div><div class="information-card-content">' + this.parser.parse(token.tokens) + '</div></section>\n';
    }
  }] });
  function render(source) {
    return DOMPurify.sanitize(parser.parse(String(source || '')), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe'],
      FORBID_ATTR: ['style', 'id', 'name']
    });
  }
  function summary(source) {
    var node = document.createElement('div');
    node.innerHTML = render(source);
    node.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,tr,br,.information-card-title').forEach(function (el) {
      el.appendChild(document.createTextNode(' '));
    });
    return (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  }
  window.WorkMarkdown = { render: render, summary: summary };
})();
