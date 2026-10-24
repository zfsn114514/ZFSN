(function () {
  'use strict';
  var editor = document.getElementById('work-editor');
  var input = document.getElementById('w-desc');
  if (!editor || !input) return;
  var status = document.getElementById('w-editor-status');
  var templates = [
    { id: 'info', icon: '◈', title: '作品介绍', hint: '亮点与创作故事', text: '在这里介绍作品的灵感与亮点。\n\n- **创作主题**：填写主题\n- **使用工具**：填写工具' },
    { id: 'tip', icon: '✦', title: '实用提示', hint: '技巧与使用建议', text: '**小提示**：在这里写下值得分享的技巧。' },
    { id: 'warning', icon: '△', title: '注意事项', hint: '兼容性与重要提醒', text: '使用前请先阅读：\n\n- 请备份原始文件。\n- 填写适用版本或其他注意事项。' },
    { id: 'download', icon: '↓', title: '下载资源', hint: '下载链接与版本', text: '**版本**：v1.0\n\n[下载文件](https://example.com/download)\n\n请将示例链接替换为实际下载地址，或在附件区域上传文件。' },
    { id: 'specs', icon: '▦', title: '参数配置', hint: '清晰的参数表格', text: '| 项目 | 说明 |\n| --- | --- |\n| 版本 | v1.0 |\n| 平台 | Windows |\n| 工具 | 填写工具名称 |' },
    { id: 'steps', icon: '☷', title: '操作步骤', hint: '安装与使用教程', text: '1. 下载并解压文件。\n2. 按照说明完成安装。\n3. 启动并体验作品。' },
    { id: 'code', icon: '</>', title: '代码示例', hint: '命令与代码片段', text: '```text\n在这里粘贴代码或命令\n```\n\n补充代码的用途和运行方式。' },
    { id: 'links', icon: '↗', title: '相关链接', hint: '参考与项目地址', text: '- [项目地址](https://example.com/project)\n- [使用文档](https://example.com/docs)' }
  ];
  var list = document.getElementById('w-card-templates');
  templates.forEach(function (template) {
    var button = document.createElement('button');
    button.type = 'button';
    button.dataset.template = template.id;
    button.innerHTML = '<span class="template-icon"></span><span><strong></strong><small></small></span>';
    button.querySelector('.template-icon').textContent = template.icon;
    button.querySelector('strong').textContent = template.title;
    button.querySelector('small').textContent = template.hint;
    list.appendChild(button);
  });
  function insert(text, start, end) {
    start = start === undefined ? input.selectionStart : start;
    end = end === undefined ? input.selectionEnd : end;
    if (input.value.length - (end - start) + text.length > input.maxLength) {
      status.textContent = '正文最多 50000 字符，请缩短内容后重试。';
      return false;
    }
    input.setRangeText(text, start, end, 'end');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
    return true;
  }
  function card(id) {
    var template = templates.find(function (item) { return item.id === id; }) || templates[0];
    var selected = input.value.slice(input.selectionStart, input.selectionEnd);
    if (insert('\n\n:::card[' + template.id + '] ' + template.title + '\n' + (selected || template.text) + '\n:::\n\n')) {
      status.textContent = '已插入「' + template.title + '」，可在正文中修改标题和内容。';
    }
  }
  document.getElementById('w-insert-card').addEventListener('click', function () { card('info'); });
  list.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-template]');
    if (button) card(button.dataset.template);
  });
  editor.querySelectorAll('[data-format]').forEach(function (button) {
    button.addEventListener('click', function () {
      var selected = input.value.slice(input.selectionStart, input.selectionEnd);
      var format = button.dataset.format;
      var text = {
        heading: '\n\n## ' + (selected || '章节标题') + '\n',
        bold: '**' + (selected || '加粗文字') + '**',
        italic: '*' + (selected || '斜体文字') + '*',
        list: '\n\n' + (selected || '第一项\n第二项').split('\n').map(function (line) { return '- ' + line; }).join('\n') + '\n',
        quote: '\n\n' + (selected || '引用内容').split('\n').map(function (line) { return '> ' + line; }).join('\n') + '\n',
        link: '[' + (selected || '链接文字') + '](https://example.com)',
        code: '\n\n```text\n' + (selected || '代码内容') + '\n```\n',
        table: '\n\n| 项目 | 说明 |\n| --- | --- |\n| 内容 | 内容 |\n'
      }[format];
      if (text) insert(text);
    });
  });
  editor.querySelectorAll('button[data-mode]').forEach(function (button) {
    button.addEventListener('click', function () {
      editor.dataset.mode = button.dataset.mode;
      editor.querySelectorAll('button[data-mode]').forEach(function (item) { item.setAttribute('aria-pressed', String(item === button)); });
    });
  });
  input.addEventListener('input', function () {
    document.getElementById('w-word-count').textContent = input.value.length + ' / 50000';
    status.textContent = '支持 Markdown · 卡片可在正文中自由组合';
  });
})();
