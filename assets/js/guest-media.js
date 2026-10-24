/* Guest attachments: progressive enhancement also covers recording previews. */
(() => {
  'use strict';
  const dialog = document.createElement('dialog');
  dialog.className = 'guest-lightbox';
  dialog.setAttribute('aria-label', '留言图片查看器');
  dialog.innerHTML = '<div class="gm-toolbar"><button data-action="prev" aria-label="上一张">←</button><span aria-live="polite"></span><button data-action="next" aria-label="下一张">→</button><button data-action="zoom" aria-label="切换图片放大">放大</button><button data-action="close" aria-label="关闭图片查看器">×</button></div><div class="gm-stage"><img alt=""></div>';
  document.body.append(dialog);
  const stage = dialog.querySelector('.gm-stage');
  const picture = stage.querySelector('img');
  let images = [], index = 0, opener, oldOverflow;
  function zoom(on) {
    stage.classList.toggle('zoomed', on);
    dialog.querySelector('[data-action="zoom"]').textContent = on ? '适应屏幕' : '放大';
    stage.scrollTop = stage.scrollLeft = 0;
  }
  function show(delta) {
    index = (index + delta + images.length) % images.length;
    picture.src = images[index].currentSrc || images[index].src;
    picture.alt = images[index].alt;
    dialog.querySelector('span').textContent = `${index + 1} / ${images.length}`;
    dialog.querySelectorAll('[data-action="prev"], [data-action="next"]').forEach(b => b.disabled = images.length < 2);
    zoom(false);
  }
  dialog.addEventListener('click', e => {
    const action = e.target.closest('button')?.dataset.action;
    if (action === 'close' || e.target === dialog) dialog.close();
    if (action === 'prev') show(-1);
    if (action === 'next') show(1);
    if (action === 'zoom' || e.target === picture) zoom(!stage.classList.contains('zoomed'));
  });
  dialog.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); show(e.key === 'ArrowLeft' ? -1 : 1); }
  });
  dialog.addEventListener('close', () => { document.body.style.overflow = oldOverflow; opener?.focus(); picture.removeAttribute('src'); });
  let startX, startY;
  stage.addEventListener('touchstart', e => { startX = e.touches[0].clientX; startY = e.touches[0].clientY; }, {passive:true});
  stage.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - startX, dy = e.changedTouches[0].clientY - startY;
    if (!stage.classList.contains('zoomed') && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) show(dx < 0 ? 1 : -1);
  }, {passive:true});
  function open(img) {
    opener = img; images = [...img.closest('.msg-imgs').querySelectorAll('img')]; index = images.indexOf(img);
    oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; show(0); dialog.showModal();
  }
  const time = value => { value = Number.isFinite(value) ? Math.max(0, value) : 0; return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`; };
  function enhance(root) {
    root.querySelectorAll('.msg-imgs img:not([data-viewer])').forEach(img => {
      img.dataset.viewer = '1'; img.tabIndex = 0; img.setAttribute('role', 'button'); img.setAttribute('aria-label', `${img.alt}，点击放大`);
      img.addEventListener('click', () => open(img));
      img.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(img); } });
    });
    root.querySelectorAll('.msg-voice audio:not([data-player]), .attach-voice audio:not([data-player])').forEach(audio => {
      audio.dataset.player = '1';
      const ui = document.createElement('div'); ui.className = 'guest-player';
      ui.innerHTML = '<button class="gp-play" aria-label="播放录音">播放</button><output>0:00 / 0:00</output><input class="gp-seek" type="range" min="0" max="100" value="0" step="0.1" aria-label="录音进度"><label class="gp-volume">音量<input type="range" min="0" max="1" step="0.05" value="1" aria-label="录音音量"></label><select aria-label="播放倍速"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select><span class="gp-error" role="status"></span>';
      audio.after(ui); audio.controls = false; audio.hidden = true;
      const play = ui.querySelector('button'), seek = ui.querySelector('.gp-seek'), volume = ui.querySelector('.gp-volume input'), error = ui.querySelector('.gp-error');
      function update() {
        const valid = Number.isFinite(audio.duration) && audio.duration > 0;
        seek.disabled = !valid; seek.value = valid ? audio.currentTime / audio.duration * 100 : 0;
        ui.querySelector('output').textContent = `${time(audio.currentTime)} / ${time(audio.duration)}`;
        play.textContent = audio.paused ? '播放' : '暂停'; play.setAttribute('aria-label', audio.paused ? '播放录音' : '暂停录音');
      }
      play.onclick = async () => {
        if (!audio.paused) { audio.pause(); return; }
        error.textContent = '';
        try { await audio.play(); } catch { error.textContent = '录音暂时无法播放，请重试'; }
      };
      seek.oninput = () => { if (Number.isFinite(audio.duration)) audio.currentTime = Number(seek.value) / 100 * audio.duration; };
      volume.oninput = () => { audio.volume = Number(volume.value); audio.muted = false; };
      ui.querySelector('select').onchange = e => { audio.playbackRate = Number(e.target.value); };
      ['timeupdate','durationchange','loadedmetadata','pause','ended','play'].forEach(event => audio.addEventListener(event, update));
      audio.addEventListener('play', () => document.querySelectorAll('.guest-player').forEach(other => { if (other !== ui) other.previousElementSibling.pause(); }));
      audio.addEventListener('error', () => { error.textContent = '录音加载失败，请重试'; });
      update();
    });
  }
  enhance(document);
  const observer = new MutationObserver(records => {
    records.forEach(record => record.removedNodes.forEach(node => {
      if (node.nodeType === 1 && !node.isConnected) node.querySelectorAll('audio[data-player]').forEach(audio => audio.pause());
    }));
    enhance(document);
  });
  observer.observe(document.body, {childList:true, subtree:true});
})();
