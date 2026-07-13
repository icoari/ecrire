// Écrire — l'atelier du livre. App autonome (installable, hors-ligne) qui
// partage les chapitres avec Bob via la sauvegarde cloud satellite
// (bob-sync.js, section _writer). Copilote créatif + dictée Whisper via le
// Worker, avec la config LLM miroir de Bob (cockpit-v3).
(() => {
  'use strict';

  const KEY = 'bob-writer-v1';
  const WORKER_BASE = 'https://bob.jz7w76ry59.workers.dev';
  const SYNC_STANDALONE = (() => { try { return window.top === window; } catch { return false; } })();

  const ICONS = {
    plus:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
    mic:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>',
  };

  // ---------- État ----------
  function load() {
    try {
      const p = JSON.parse(localStorage.getItem(KEY) || 'null');
      return (p && Array.isArray(p.chapters)) ? p : { chapters: [] };
    } catch { return { chapters: [] }; }
  }
  let state = load();
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { return; }
    try { if (SYNC_STANDALONE && window.BobSync) window.BobSync.schedulePush(); } catch {}
  }
  let persistTimer = null;
  function persistDebounced() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 400); }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function countWords(t) { return t ? t.trim().split(/\s+/).filter(Boolean).length : 0; }
  function escapeHTML(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function timeAgo(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'à l\'instant';
    if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
    if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
    if (diff < 86400 * 7) return `il y a ${Math.floor(diff / 86400)} j`;
    return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' }).format(d);
  }

  // ---------- LLM (config miroir de Bob, transit par le Worker) ----------
  function llmConfig() {
    try {
      const st = JSON.parse(localStorage.getItem('cockpit-v3') || 'null');
      const c = st?.settings?.llm;
      return (c && c.endpoint && c.apiKey) ? c : null;
    } catch { return null; }
  }
  function authToken() {
    try { return JSON.parse(localStorage.getItem('bob-sync-v1') || 'null')?.authToken || null; }
    catch { return null; }
  }

  const SYSTEM_WRITER = `Tu es l'assistant d'écriture créatif de Nicolas qui rédige un livre en français.
Tu respectes scrupuleusement son style : phrases nettes, vocabulaire soutenu sans pédanterie, voix narrative claire.
Pas d'introduction du type "voici la suite". Tu rends UNIQUEMENT le texte demandé, sans guillemets autour, sans commentaire, sans Markdown.
Tu n'es JAMAIS dans la correction grammaticale ou orthographique. Tu ne reformules pas pour reformuler. Tu apportes du matériau narratif neuf.`;
  const SYSTEM_QUESTION = `Tu es l'assistant d'écriture créatif de Nicolas. Tu poses UNE seule question à Nicolas, concrète, qui pointe vers du matériau narratif possible — un détail, un personnage, une motivation cachée, une bifurcation. Interdit : questions vagues du type "que veux-tu dire ?", "où vas-tu avec ça ?", "et après ?".
Format : une seule phrase en français, terminée par un point d'interrogation. Rien d'autre. Pas de préambule, pas de Markdown.`;

  function buildUser(task, params) {
    const ctx = params.context
      ? `Contexte (le texte écrit jusqu'à présent — pour rester dans le ton) :\n${params.context.slice(-2000)}\n\n`
      : '';
    switch (task) {
      case 'continue':
        return `${ctx}Continue le récit. Deux à quatre phrases qui poursuivent naturellement le passage, dans le même rythme et la même voix. Pas de méta-commentaire, pas de "fin de chapitre".`;
      case 'expand': {
        const target = (params.selection && params.selection.trim()) || params.context.slice(-800);
        return `${ctx}Élargis ce passage : enrichis-le sans en changer le sens, en ajoutant matière concrète — gestes, sensations, environnement, micro-événements. Garde le tempo. Rends UNE version élargie complète (3 à 6 phrases), pas une analyse.\n\nPassage de départ :\n"""\n${target}\n"""`;
      }
      case 'deepen':
        return `${ctx}Ralentis le tempo ici. Ajoute deux à trois phrases qui ancrent la scène avec du concret — un détail physique, un geste précis, un élément sensoriel inattendu mais juste. Pas d'introspection abstraite ; du tangible.`;
      case 'twist':
        return `${ctx}Introduis un élément qui change le sens : un personnage qui entre, un détail qui réoriente, une phrase qui ouvre une piste latérale. Une à trois phrases. Doit s'intégrer naturellement à la suite du texte.`;
      case 'character': {
        const target = (params.selection && params.selection.trim()) || params.context.slice(-1000);
        return `${ctx}Introduis ici un nouveau personnage. Donne-le en deux phrases maximum : une caractéristique physique précise (pas un cliché), un détail comportemental ou un objet associé. Ne nomme pas le personnage si le texte n'en attendait pas. Reste dans la scène — ne saute pas dans le temps.\n\nPassage qui précède :\n"""\n${target}\n"""`;
      }
      default: throw new Error('Tâche inconnue : ' + task);
    }
  }

  // Appel streaming via le Worker (formats openai + anthropic, framing SSE).
  async function streamLLM(messages, onChunk, opts = {}) {
    const c = llmConfig();
    const tok = authToken();
    if (!c) throw new Error('Assistant non configuré — active la sync (la config vient de Bob).');
    if (!tok) throw new Error('Active la sauvegarde cloud d\'abord.');
    const format = c.format || 'openai';
    let body;
    if (format === 'anthropic') {
      const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      body = { model: c.model || 'claude-sonnet-4-5', max_tokens: opts.maxTokens ?? 800, temperature: opts.temperature ?? 0.6, stream: true, messages: messages.filter(m => m.role !== 'system') };
      if (sys) body.system = sys;
    } else {
      body = { messages, temperature: opts.temperature ?? 0.6, max_tokens: opts.maxTokens ?? 800, stream: true };
      if (c.model) body.model = c.model;
    }
    const resp = await fetch(WORKER_BASE + '/llm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + tok,
        'X-LLM-Endpoint': c.endpoint,
        'X-LLM-Key': c.apiKey,
        'X-LLM-Auth-Style': c.authStyle || 'bearer',
        'X-LLM-Format': format,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' — ' + (await resp.text().catch(() => '')).slice(0, 200));
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    const handle = (evt) => {
      const dataLines = evt.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, ''));
      const dataStr = dataLines.join('\n').trim();
      if (!dataStr || dataStr === '[DONE]') return;
      try {
        const obj = JSON.parse(dataStr);
        let delta = '';
        if (format === 'anthropic') {
          if (obj.type === 'error') throw new Error(obj.error?.message || 'Erreur du modèle');
          if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') delta = obj.delta.text || '';
        } else {
          if (obj.error) throw new Error(obj.error.message || 'Erreur du modèle');
          delta = obj.choices?.[0]?.delta?.content || '';
        }
        if (delta) { full += delta; onChunk(delta, full); }
      } catch (e) { if (e instanceof SyntaxError) return; throw e; }
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split(/\r?\n\r?\n/);
        buf = parts.pop() || '';
        for (const p of parts) handle(p);
      }
      buf += dec.decode();
      if (buf.trim()) handle(buf);
    } finally {
      try { reader.cancel(); } catch {}
    }
    return full;
  }

  // ---------- Dictée (Whisper via le Worker) ----------
  let sharedMic = null, micReleaseTimer = null;
  async function acquireMic() {
    if (micReleaseTimer) { clearTimeout(micReleaseTimer); micReleaseTimer = null; }
    if (sharedMic && sharedMic.getAudioTracks().some(t => t.readyState === 'live')) return sharedMic;
    sharedMic = await navigator.mediaDevices.getUserMedia({ audio: true });
    return sharedMic;
  }
  function scheduleMicRelease() {
    if (micReleaseTimer) clearTimeout(micReleaseTimer);
    micReleaseTimer = setTimeout(() => {
      try { sharedMic?.getTracks().forEach(t => t.stop()); } catch {}
      sharedMic = null; micReleaseTimer = null;
    }, 90000);
  }
  function pickMime() {
    for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac']) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
    }
    return '';
  }
  let recorder = null, recChunks = [];
  async function startRecording() {
    const stream = await acquireMic();
    const mime = pickMime();
    recChunks = [];
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) recChunks.push(e.data); });
    recorder.start();
  }
  function stopRecording() {
    return new Promise((res) => {
      if (!recorder) return res(new Blob());
      if (recorder.state === 'inactive') { scheduleMicRelease(); return res(new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' })); }
      recorder.addEventListener('stop', () => {
        scheduleMicRelease();
        res(new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' }));
      }, { once: true });
      try { recorder.stop(); } catch { res(new Blob()); }
    });
  }
  function cancelRecording() {
    try { recorder?.stop(); } catch {}
    recorder = null; recChunks = [];
    scheduleMicRelease();
  }
  async function transcribe(blob) {
    const tok = authToken();
    if (!tok) throw new Error('Active la sauvegarde cloud d\'abord.');
    const b64 = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => { const s = fr.result || ''; const c = s.indexOf(','); res(c >= 0 ? s.slice(c + 1) : s); };
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
    const r = await fetch(WORKER_BASE + '/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
      body: JSON.stringify({ audio: b64, language: 'fr' }),
    });
    if (!r.ok) throw new Error('Transcription HTTP ' + r.status);
    return ((await r.json()).text || '').trim();
  }

  // ---------- Vues ----------
  const app = document.getElementById('app');
  let currentId = null;
  let copilotBusy = false;
  let delArmedId = null, delArmedTimer = null;

  function current() { return state.chapters.find(c => c.id === currentId); }

  function stopDictationNav() {
    if (recorder) { cancelRecording(); }
  }

  function renderList() {
    stopDictationNav();
    currentId = null;
    const total = state.chapters.reduce((s, c) => s + countWords(c.content), 0);
    const items = state.chapters.length ? state.chapters.map(c => `
      <div class="chapter" data-open="${c.id}" role="button" tabindex="0">
        <div class="chapter__main">
          <div class="chapter__title">${escapeHTML(c.title)}</div>
          <div class="chapter__meta">${countWords(c.content)} mots · ${timeAgo(c.updatedAt)}</div>
        </div>
        <button class="chapter__del" data-del="${c.id}" type="button" aria-label="Supprimer">${ICONS.trash}</button>
      </div>`).join('')
      : '<div class="empty">Aucun chapitre.<br>Tape + pour commencer ton livre.</div>';

    app.innerHTML = `
      <div class="bar">
        <span class="bar__title">Écrire</span>
        <button class="bar__action" data-new type="button" aria-label="Nouveau chapitre">${ICONS.plus}</button>
      </div>
      <p class="stats-line">${state.chapters.length} chapitre${state.chapters.length > 1 ? 's' : ''} · ${total.toLocaleString('fr-FR')} mots</p>
      <div class="chapters">${items}</div>
      <div id="syncBox"></div>
    `;

    app.querySelector('[data-new]').addEventListener('click', () => {
      const c = { id: uid(), title: 'Chapitre ' + (state.chapters.length + 1), content: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.chapters.unshift(c);
      persist();
      currentId = c.id;
      renderEditor();
    });
    app.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', (e) => {
      if (e.target.closest('[data-del]')) return;
      currentId = el.dataset.open;
      renderEditor();
    }));
    // Suppression en deux taps (armée 3 s) — un livre ne se supprime pas par accident.
    app.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.dataset.del;
      if (delArmedId === id) {
        clearTimeout(delArmedTimer);
        delArmedId = null;
        state.chapters = state.chapters.filter(c => c.id !== id);
        persist();
        renderList();
      } else {
        app.querySelectorAll('.chapter__del--armed').forEach(x => x.classList.remove('chapter__del--armed'));
        delArmedId = id;
        b.classList.add('chapter__del--armed');
        clearTimeout(delArmedTimer);
        delArmedTimer = setTimeout(() => { delArmedId = null; b.classList.remove('chapter__del--armed'); }, 3000);
      }
    }));
    renderSyncBox();
  }

  function renderEditor() {
    const c = current();
    if (!c) { renderList(); return; }
    app.innerHTML = `
      <div class="bar">
        <button class="bar__back" data-back type="button">← Chapitres</button>
        <span class="bar__title bar__title--count" data-count>${countWords(c.content)} mots</span>
      </div>
      <input class="edit__title" type="text" data-title value="${escapeHTML(c.title)}" placeholder="Titre du chapitre">
      <div class="copilot">
        ${navigator.mediaDevices ? `<button class="copilot__btn" data-mic type="button">${ICONS.mic}<span data-mic-label>Dicter</span></button>` : ''}
        <button class="copilot__btn" data-task="continue" type="button">Continuer</button>
        <button class="copilot__btn" data-task="expand" type="button">Élargir</button>
        <button class="copilot__btn" data-task="deepen" type="button">Approfondir</button>
        <button class="copilot__btn" data-task="character" type="button">Personnage</button>
        <button class="copilot__btn" data-task="twist" type="button">Détour</button>
        <button class="copilot__btn" data-task="question" type="button">Question</button>
        <span class="copilot__status" data-status></span>
      </div>
      <textarea class="edit__content" data-content placeholder="Écris…">${escapeHTML(c.content)}</textarea>
    `;

    const titleEl = app.querySelector('[data-title]');
    const contentEl = app.querySelector('[data-content]');
    const countEl = app.querySelector('[data-count]');
    const statusEl = app.querySelector('[data-status]');

    // Lié à CE chapitre : un flux encore actif après navigation ne doit
    // jamais écrire dans un autre chapitre.
    const cid = currentId;
    const onChange = () => {
      if (currentId !== cid) return;
      const c2 = state.chapters.find(x => x.id === cid); if (!c2) return;
      c2.title = titleEl.value;
      c2.content = contentEl.value;
      c2.updatedAt = new Date().toISOString();
      countEl.textContent = countWords(c2.content) + ' mots';
      persistDebounced();
    };
    titleEl.addEventListener('input', onChange);
    contentEl.addEventListener('input', onChange);
    titleEl.addEventListener('blur', persist);
    contentEl.addEventListener('blur', persist);
    const adjust = () => { contentEl.style.height = 'auto'; contentEl.style.height = contentEl.scrollHeight + 'px'; };
    contentEl.addEventListener('input', adjust);
    setTimeout(adjust, 0);

    app.querySelector('[data-back]').addEventListener('click', () => { persist(); renderList(); });

    // Dictée : tap = enregistre, re-tap = transcrit + insère au curseur.
    const micBtn = app.querySelector('[data-mic]');
    if (micBtn) micBtn.addEventListener('click', async () => {
      const label = micBtn.querySelector('[data-mic-label]');
      if (recorder) {
        micBtn.classList.remove('copilot__btn--rec');
        label.textContent = 'Dicter';
        micBtn.disabled = true;
        statusEl.textContent = 'Transcription…';
        try {
          const blob = await stopRecording();
          recorder = null;
          if (!blob.size) throw new Error('aucun son capté');
          const text = await transcribe(blob);
          if (text && currentId === cid) {
            const pos = contentEl.selectionStart ?? contentEl.value.length;
            const before = contentEl.value.slice(0, pos);
            const sep = before && !/\s$/.test(before) ? ' ' : '';
            contentEl.value = before + sep + text + contentEl.value.slice(pos);
            const caret = (before + sep + text).length;
            contentEl.setSelectionRange(caret, caret);
            adjust(); onChange();
            statusEl.textContent = '✓ ' + text.length + ' caractères dictés';
          } else statusEl.textContent = text ? '' : 'Rien entendu.';
        } catch (e) {
          statusEl.textContent = 'Échec : ' + (e.message || e);
        } finally {
          micBtn.disabled = false;
          setTimeout(() => { statusEl.textContent = ''; }, 4000);
        }
        return;
      }
      if (copilotBusy) { statusEl.textContent = 'Génération en cours.'; return; }
      try {
        await startRecording();
        micBtn.classList.add('copilot__btn--rec');
        label.textContent = 'Stop';
        statusEl.textContent = 'Enregistrement… re-tape pour arrêter';
      } catch (e) {
        statusEl.textContent = 'Micro refusé : ' + (e.message || e);
      }
    });

    // Copilote : streaming dans le texte, avec restauration si échec immédiat.
    app.querySelectorAll('[data-task]').forEach(btn => btn.addEventListener('click', async () => {
      if (copilotBusy) { statusEl.textContent = 'Une génération est déjà en cours.'; return; }
      if (recorder) { statusEl.textContent = 'Dictée en cours — termine-la d\'abord.'; return; }
      if (!llmConfig()) { statusEl.textContent = 'Active la sync pour récupérer la config de l\'assistant.'; return; }
      const task = btn.dataset.task;
      const selStart = contentEl.selectionStart, selEnd = contentEl.selectionEnd;
      const full = contentEl.value;
      const selection = full.slice(selStart, selEnd);
      if (task === 'expand' && !selection.trim()) { statusEl.textContent = 'Sélectionne d\'abord un passage à élargir.'; return; }

      copilotBusy = true;
      btn.disabled = true;
      btn.classList.add('copilot__btn--busy');
      statusEl.textContent = 'En cours…';
      contentEl.readOnly = true;

      let insertStart, insertEnd;
      if (task === 'expand') { insertStart = selStart; insertEnd = selEnd; }
      else {
        insertStart = selEnd; insertEnd = selEnd;
        const prev = full.slice(insertStart - 1, insertStart);
        const sep = prev && !/\s$/.test(prev) ? '\n\n' : '';
        const prefix = task === 'question' ? '> Q · ' : '';
        contentEl.value = full.slice(0, insertStart) + sep + prefix + full.slice(insertStart);
        insertStart += sep.length + prefix.length;
        insertEnd = insertStart;
      }
      let acc = '';
      const baseBefore = contentEl.value.slice(0, insertStart);
      const baseAfter = contentEl.value.slice(insertEnd);
      const messages = task === 'question'
        ? [{ role: 'system', content: SYSTEM_QUESTION }, { role: 'user', content: `Contexte récent :\n${full.slice(-1500)}\n\nPose-moi la question.` }]
        : [{ role: 'system', content: SYSTEM_WRITER }, { role: 'user', content: buildUser(task, { selection, context: full }) }];
      try {
        await streamLLM(messages, (delta) => {
          acc += delta;
          if (currentId !== cid) return;
          contentEl.value = baseBefore + acc + baseAfter;
          adjust(); onChange();
        }, { temperature: task === 'question' ? 0.7 : 0.6, maxTokens: task === 'question' ? 200 : 800 });
        contentEl.setSelectionRange(insertStart, insertStart + acc.length);
        statusEl.textContent = '✓ ' + acc.length + ' caractères';
      } catch (e) {
        if (!acc && currentId === cid) {
          contentEl.value = full;
          contentEl.setSelectionRange(selStart, selEnd);
          adjust(); onChange();
        }
        statusEl.textContent = 'Échec : ' + (e.message || e);
      } finally {
        copilotBusy = false;
        contentEl.readOnly = false;
        btn.disabled = false;
        btn.classList.remove('copilot__btn--busy');
        setTimeout(() => { statusEl.textContent = ''; }, 4000);
      }
    }));
  }

  // ---------- Sauvegarde cloud (satellite) ----------
  function mergeWriter(local, remote) {
    if (!remote || typeof remote !== 'object') return local;
    const out = { chapters: Array.isArray(remote.chapters) ? remote.chapters.slice() : [] };
    const byId = new Map(out.chapters.map(c => [c.id, c]));
    for (const c of (Array.isArray(local.chapters) ? local.chapters : [])) {
      const r = byId.get(c.id);
      if (!r) out.chapters.push(c);
      else if (new Date(c.updatedAt || 0) > new Date(r.updatedAt || 0)) {
        Object.assign(r, c);   // conflit : la version la plus récente gagne
      }
    }
    out.chapters.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    return out;
  }

  function renderSyncBox() {
    const box = document.getElementById('syncBox');
    if (!box) return;
    if (!SYNC_STANDALONE || !window.BobSync) { box.hidden = true; return; }
    if (window.BobSync.isEnabled()) {
      box.outerHTML = '<p class="syncbox__on">Sauvegarde cloud active — chapitres synchronisés avec Bob.</p>';
      return;
    }
    box.innerHTML = `
      <p class="syncbox__txt">Synchronise tes chapitres avec Bob (et récupère la config du copilote) :</p>
      <form class="syncbox__form" data-sync-form>
        <input class="syncbox__input" type="password" placeholder="Passphrase de la sauvegarde Bob" autocomplete="current-password" data-sync-pass>
        <button class="syncbox__btn" type="submit">Activer</button>
      </form>
      <p class="syncbox__status" data-sync-status></p>`;
    box.className = 'syncbox';
    box.querySelector('[data-sync-form]').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pass = box.querySelector('[data-sync-pass]').value;
      const status = box.querySelector('[data-sync-status]');
      const btn = box.querySelector('.syncbox__btn');
      if (!pass) return;
      btn.disabled = true;
      status.textContent = 'Dérivation des clés… (~10 s, c\'est normal)';
      try {
        await window.BobSync.unlock(pass);
        status.textContent = 'Synchronisé — rechargement…';
        setTimeout(() => location.reload(), 600);
      } catch (err) {
        status.textContent = 'Échec : ' + (err.message || err);
        btn.disabled = false;
      }
    });
  }

  function initSync() {
    if (!SYNC_STANDALONE || !window.BobSync) return;
    window.BobSync.configure({ section: '_writer', localKey: KEY, merge: mergeWriter });
    if (!window.BobSync.isEnabled()) return;
    let lastPull = 0;
    const pull = () => {
      if (Date.now() - lastPull < 60000) return;
      lastPull = Date.now();
      window.BobSync.reconcile().then(r => {
        if (r && r.applied) {
          state = load();
          // En liste → re-rendre ; en édition → ne pas écraser la saisie en cours.
          if (!currentId) renderList();
        }
      }).catch(() => {});
    };
    pull();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
  }

  // ---------- Init ----------
  renderList();
  initSync();
})();
