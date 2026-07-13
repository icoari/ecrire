// Écrire — l'atelier du livre. App autonome (installable, hors-ligne) qui
// partage les chapitres avec Bob via la sauvegarde cloud satellite
// (bob-sync.js, section _writer).
//
// L'atelier complet :
//   - objectif d'écriture quotidien (mots/jour, série de jours tenus) ;
//   - stats du livre (mots, pages, temps de lecture) ;
//   - recherche plein texte, réorganisation des chapitres ;
//   - éditeur serif avec mode focus, mode lecture, notes de chapitre ;
//   - historique de versions local (filet de sécurité, jamais synchronisé) ;
//   - copilote créatif en streaming + « œil critique » (analyse en panneau) ;
//   - dictée Whisper au curseur ; export du manuscrit en Markdown.
(() => {
  'use strict';

  const KEY = 'bob-writer-v1';
  const META_KEY = 'ecrire-meta-v1';          // objectif, jours, versions — local only
  const WORKER_BASE = 'https://bob.jz7w76ry59.workers.dev';
  const WORDS_PER_PAGE = 250;
  const WORDS_PER_MIN = 220;
  const SYNC_STANDALONE = (() => { try { return window.top === window; } catch { return false; } })();

  const svg = (p, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const ICONS = {
    plus:    svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', 1.8),
    trash:   svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>'),
    mic:     svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>'),
    search:  svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
    order:   svg('<polyline points="8 7 12 3 16 7"/><polyline points="8 17 12 21 16 17"/><line x1="12" y1="3" x2="12" y2="21"/>'),
    export:  svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
    book:    svg('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
    clock:   svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>'),
    focus:   svg('<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>'),
    history: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/><polyline points="12 7 12 12 15 14"/>'),
    notes:   svg('<line x1="5" y1="7" x2="19" y2="7"/><line x1="5" y1="12" x2="19" y2="12"/><line x1="5" y1="17" x2="14" y2="17"/>'),
    eye:     svg('<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>'),
    up:      svg('<polyline points="6 14 12 8 18 14"/>', 1.9),
    down:    svg('<polyline points="6 10 12 16 18 10"/>', 1.9),
    close:   svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 1.8),
    target:  svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>'),
  };

  // ---------- État ----------
  function load() {
    try {
      const p = JSON.parse(localStorage.getItem(KEY) || 'null');
      return (p && Array.isArray(p.chapters)) ? p : { chapters: [] };
    } catch { return { chapters: [] }; }
  }
  let state = load();

  function loadMeta() {
    try {
      const m = JSON.parse(localStorage.getItem(META_KEY) || 'null') || {};
      if (typeof m.goal !== 'number') m.goal = 300;
      if (!m.daily || typeof m.daily !== 'object') m.daily = {};
      if (!m.versions || typeof m.versions !== 'object') m.versions = {};
      return m;
    } catch { return { goal: 300, daily: {}, versions: {} }; }
  }
  let meta = loadMeta();
  function saveMeta() { try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch {} }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { return; }
    trackDaily();
    try { if (SYNC_STANDALONE && window.BobSync) window.BobSync.schedulePush(); } catch {}
  }
  let persistTimer = null;
  function persistDebounced() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 400); }

  // ---------- Utils ----------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function countWords(t) { return t ? t.trim().split(/\s+/).filter(Boolean).length : 0; }
  function totalWords() { return state.chapters.reduce((s, c) => s + countWords(c.content), 0); }
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
  function fmtInt(n) { return n.toLocaleString('fr-FR'); }
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ---------- Objectif quotidien ----------
  // daily[date] = { base: mots au premier passage du jour, max: plus haut atteint }
  function trackDaily() {
    const k = todayKey();
    const total = totalWords();
    if (!meta.daily[k]) meta.daily[k] = { base: total, max: total };
    else if (total > meta.daily[k].max) meta.daily[k].max = total;
    // borne l'historique à ~120 jours
    const keys = Object.keys(meta.daily).sort();
    while (keys.length > 120) delete meta.daily[keys.shift()];
    saveMeta();
  }
  function writtenToday() {
    const d = meta.daily[todayKey()];
    if (!d) return 0;
    return Math.max(0, d.max - d.base);
  }
  function streak() {
    let n = 0;
    const d = new Date();
    if (writtenToday() >= meta.goal) n++;
    for (let i = 1; i < 365; i++) {
      const dd = new Date(d); dd.setDate(d.getDate() - i);
      const k = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
      const rec = meta.daily[k];
      if (rec && Math.max(0, rec.max - rec.base) >= meta.goal) n++;
      else break;
    }
    return n;
  }

  // ---------- Versions (filet de sécurité local) ----------
  function snapshotChapter(c) {
    if (!c || !c.content) return;
    const list = meta.versions[c.id] || (meta.versions[c.id] = []);
    const last = list[list.length - 1];
    if (last && last.content === c.content) return;
    list.push({ ts: Date.now(), title: c.title, content: c.content, words: countWords(c.content) });
    while (list.length > 10) list.shift();
    // purge les versions des chapitres supprimés
    const ids = new Set(state.chapters.map(x => x.id));
    for (const id of Object.keys(meta.versions)) if (!ids.has(id)) delete meta.versions[id];
    saveMeta();
  }

  // ---------- LLM ----------
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
  const SYSTEM_CRITIC = `Tu es le premier lecteur de confiance de Nicolas, romancier en cours d'écriture. Il te montre un chapitre.
Ton retour, en français, court et dense (150 mots max), structuré ainsi :
**Ce qui tient** — une ou deux forces réelles du passage (précises, pas de flatterie).
**Ce qui accroche** — un ou deux endroits où le lecteur décroche : rythme, clarté, tension (cite 3-5 mots du texte pour situer).
**Une piste** — UNE suggestion narrative concrète (pas une correction de style).
Jamais de réécriture, jamais de leçon de grammaire. Franc mais allié.`;

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
      const dataStr = evt.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n').trim();
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

  // ---------- Dictée ----------
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
      fr.onload = () => { const s = fr.result || ''; const i = s.indexOf(','); res(i >= 0 ? s.slice(i + 1) : s); };
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

  // ---------- Overlay générique ----------
  function openOverlay(title, bodyHtml) {
    closeOverlay();
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.id = 'overlay';
    ov.innerHTML = `
      <div class="overlay__panel">
        <div class="overlay__head">
          <span class="overlay__title">${escapeHTML(title)}</span>
          <button class="overlay__close" data-ov-close type="button" aria-label="Fermer">${ICONS.close}</button>
        </div>
        <div class="overlay__body" data-ov-body>${bodyHtml}</div>
      </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeOverlay(); });
    ov.querySelector('[data-ov-close]').addEventListener('click', closeOverlay);
    return ov.querySelector('[data-ov-body]');
  }
  function closeOverlay() { document.getElementById('overlay')?.remove(); }
  function tinyMd(s) {
    let h = escapeHTML(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    return h.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
  }

  // ---------- Export du manuscrit ----------
  function exportManuscript() {
    const parts = ['# Mon livre', ''];
    for (const c of state.chapters) {
      parts.push(`## ${c.title}`, '', c.content.trim(), '');
    }
    parts.push('---', `${fmtInt(totalWords())} mots · exporté le ${new Date().toLocaleDateString('fr-FR')}`);
    const blob = new Blob(['﻿' + parts.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mon-livre.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---------- Vues ----------
  const app = document.getElementById('app');
  let currentId = null;
  let copilotBusy = false;
  let delArmedId = null, delArmedTimer = null;
  let searchQuery = '';
  let reorderMode = false;

  function current() { return state.chapters.find(c => c.id === currentId); }
  function stopDictationNav() { if (recorder) cancelRecording(); }

  // ----- Liste -----
  function renderList() {
    stopDictationNav();
    closeOverlay();
    document.body.classList.remove('focus-mode');
    currentId = null;
    trackDaily();

    const total = totalWords();
    const pages = Math.max(1, Math.round(total / WORDS_PER_PAGE));
    const readMin = Math.max(1, Math.round(total / WORDS_PER_MIN));
    const written = writtenToday();
    const goal = meta.goal;
    const pct = Math.min(100, Math.round(written / goal * 100));
    const st = streak();

    const q = searchQuery.trim().toLowerCase();
    let list = state.chapters;
    let snippets = {};
    if (q) {
      list = state.chapters.filter(c => {
        const inTitle = c.title.toLowerCase().includes(q);
        const idx = c.content.toLowerCase().indexOf(q);
        if (idx >= 0) {
          const s = Math.max(0, idx - 40);
          snippets[c.id] = (s > 0 ? '…' : '') + c.content.slice(s, idx + q.length + 60).replace(/\s+/g, ' ') + '…';
        }
        return inTitle || idx >= 0;
      });
    }

    const R = 15.9;   // rayon de l'anneau (circonférence ≈ 100)
    const items = list.length ? list.map((c, i) => {
      const excerpt = snippets[c.id]
        ? `<div class="chapter__excerpt">${highlight(snippets[c.id], q)}</div>`
        : (c.content ? `<div class="chapter__excerpt">${escapeHTML(c.content.replace(/\s+/g, ' ').slice(0, 90))}…</div>` : '');
      const realIdx = state.chapters.indexOf(c);
      const controls = reorderMode
        ? `<span class="chapter__order">
             <button class="chapter__move" data-move="up" data-idx="${realIdx}" type="button" ${realIdx === 0 ? 'disabled' : ''} aria-label="Monter">${ICONS.up}</button>
             <button class="chapter__move" data-move="down" data-idx="${realIdx}" type="button" ${realIdx === state.chapters.length - 1 ? 'disabled' : ''} aria-label="Descendre">${ICONS.down}</button>
           </span>`
        : `<button class="chapter__del" data-del="${c.id}" type="button" aria-label="Supprimer">${ICONS.trash}</button>`;
      return `
      <div class="chapter" data-open="${c.id}" role="button" tabindex="0">
        <span class="chapter__num">${realIdx + 1}</span>
        <div class="chapter__main">
          <div class="chapter__title">${q ? highlight(escapeHTML(c.title), q) : escapeHTML(c.title)}</div>
          <div class="chapter__meta">${fmtInt(countWords(c.content))} mots · ${timeAgo(c.updatedAt)}</div>
          ${excerpt}
        </div>
        ${controls}
      </div>`;
    }).join('')
      : `<div class="empty">${q ? 'Aucun chapitre ne contient « ' + escapeHTML(searchQuery) + ' ».' : 'Aucun chapitre.<br>Tape + pour commencer ton livre.'}</div>`;

    app.innerHTML = `
      <div class="bar">
        <span class="bar__title">Écrire</span>
        <span class="bar__spacer"></span>
        <button class="bar__action ${reorderMode ? 'bar__action--on' : ''}" data-reorder type="button" aria-label="Réorganiser">${ICONS.order}</button>
        <button class="bar__action" data-export type="button" aria-label="Exporter le manuscrit">${ICONS.export}</button>
        <button class="bar__action bar__action--primary" data-new type="button" aria-label="Nouveau chapitre">${ICONS.plus}</button>
      </div>

      <div class="goalcard">
        <svg class="goalring" viewBox="0 0 36 36" aria-hidden="true">
          <circle class="goalring__bg" cx="18" cy="18" r="${R}"/>
          <circle class="goalring__fg" cx="18" cy="18" r="${R}" stroke-dasharray="${pct} 100" transform="rotate(-90 18 18)"/>
          <text class="goalring__pct" x="18" y="21" text-anchor="middle">${pct}%</text>
        </svg>
        <div class="goalcard__main">
          <div class="goalcard__line"><strong>${fmtInt(written)}</strong> / ${fmtInt(goal)} mots aujourd'hui</div>
          <div class="goalcard__sub">${st > 0 ? `${ICONS.target} série : ${st} jour${st > 1 ? 's' : ''}` : 'L\'objectif du jour t\'attend'}</div>
        </div>
        <button class="goalcard__edit" data-goal type="button" aria-label="Changer l'objectif">${ICONS.target}</button>
      </div>

      <p class="stats-line">${ICONS.book} ${state.chapters.length} chapitre${state.chapters.length > 1 ? 's' : ''} · ${fmtInt(total)} mots · ≈ ${pages} pages ${ICONS.clock} ${readMin} min de lecture</p>

      <div class="searchrow">
        <span class="searchrow__icon">${ICONS.search}</span>
        <input class="searchrow__input" type="search" placeholder="Chercher dans le livre…" value="${escapeHTML(searchQuery)}" data-search autocomplete="off">
      </div>

      <div class="chapters">${items}</div>
      <div id="syncBox"></div>
    `;

    // Wiring
    app.querySelector('[data-new]').addEventListener('click', () => {
      const c = { id: uid(), title: 'Chapitre ' + (state.chapters.length + 1), content: '', notes: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.chapters.push(c);
      persist();
      currentId = c.id;
      renderEditor();
    });
    app.querySelector('[data-export]').addEventListener('click', exportManuscript);
    app.querySelector('[data-reorder]').addEventListener('click', () => { reorderMode = !reorderMode; renderList(); });
    app.querySelector('[data-goal]').addEventListener('click', () => {
      const v = prompt('Objectif quotidien (mots) :', String(meta.goal));
      const n = parseInt(v, 10);
      if (n > 0) { meta.goal = n; saveMeta(); renderList(); }
    });
    const searchEl = app.querySelector('[data-search]');
    let searchTimer = null;
    searchEl.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchQuery = searchEl.value;
        const pos = searchEl.selectionStart;
        renderList();
        const el = app.querySelector('[data-search]');
        el.focus();
        try { el.setSelectionRange(pos, pos); } catch {}
      }, 250);
    });
    app.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', (e) => {
      if (e.target.closest('[data-del]') || e.target.closest('[data-move]')) return;
      if (reorderMode) return;
      currentId = el.dataset.open;
      renderEditor();
    }));
    app.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const i = Number(b.dataset.idx);
      const j = b.dataset.move === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= state.chapters.length) return;
      const [c] = state.chapters.splice(i, 1);
      state.chapters.splice(j, 0, c);
      persist();
      renderList();
    }));
    app.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.dataset.del;
      if (delArmedId === id) {
        clearTimeout(delArmedTimer);
        delArmedId = null;
        const c = state.chapters.find(x => x.id === id);
        if (c) snapshotChapter(c);   // dernier filet avant suppression
        state.chapters = state.chapters.filter(x => x.id !== id);
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

  function highlight(escapedText, q) {
    if (!q) return escapedText;
    const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    return escapedText.replace(re, '<mark>$1</mark>');
  }

  // ----- Éditeur -----
  function renderEditor() {
    const c = current();
    if (!c) { renderList(); return; }
    closeOverlay();
    snapshotChapter(c);   // version de sécurité à l'ouverture

    const words = countWords(c.content);
    app.innerHTML = `
      <div class="bar bar--editor">
        <button class="bar__back" data-back type="button">← Chapitres</button>
        <span class="bar__title bar__title--count" data-count>${fmtInt(words)} mots · ${Math.max(1, Math.round(words / WORDS_PER_MIN))} min</span>
        <span class="bar__spacer"></span>
        <button class="bar__action" data-read type="button" aria-label="Lire">${ICONS.book}</button>
        <button class="bar__action" data-history type="button" aria-label="Versions">${ICONS.history}</button>
        <button class="bar__action" data-notes type="button" aria-label="Notes">${ICONS.notes}</button>
        <button class="bar__action" data-focus type="button" aria-label="Mode focus">${ICONS.focus}</button>
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
        <button class="copilot__btn" data-critic type="button">${ICONS.eye}<span>Œil critique</span></button>
        <span class="copilot__status" data-status></span>
      </div>
      <textarea class="edit__content" data-content placeholder="Écris…">${escapeHTML(c.content)}</textarea>
      <button class="focus-exit" data-focus-exit type="button" aria-label="Quitter le mode focus">${ICONS.close}</button>
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
      const w = countWords(c2.content);
      countEl.textContent = `${fmtInt(w)} mots · ${Math.max(1, Math.round(w / WORDS_PER_MIN))} min`;
      persistDebounced();
    };
    titleEl.addEventListener('input', onChange);
    contentEl.addEventListener('input', onChange);
    titleEl.addEventListener('blur', persist);
    contentEl.addEventListener('blur', persist);
    const adjust = () => { contentEl.style.height = 'auto'; contentEl.style.height = contentEl.scrollHeight + 'px'; };
    contentEl.addEventListener('input', adjust);
    setTimeout(adjust, 0);

    app.querySelector('[data-back]').addEventListener('click', () => {
      stopDictationNav();
      persist();
      const cc = current();
      if (cc) snapshotChapter(cc);
      renderList();
    });

    // Mode focus : juste toi et le texte.
    const setFocus = (on) => {
      document.body.classList.toggle('focus-mode', on);
      if (on) contentEl.focus();
    };
    app.querySelector('[data-focus]').addEventListener('click', () => setFocus(true));
    app.querySelector('[data-focus-exit]').addEventListener('click', () => setFocus(false));

    // Mode lecture : le chapitre comme une page de livre.
    app.querySelector('[data-read]').addEventListener('click', () => {
      const cc = current(); if (!cc) return;
      const paras = cc.content.split(/\n{2,}/).map(p => `<p>${escapeHTML(p).replace(/\n/g, '<br>')}</p>`).join('');
      const w = countWords(cc.content);
      openOverlay(cc.title, `
        <div class="read">
          ${paras || '<p class="read__empty">Rien à lire encore.</p>'}
          <p class="read__end">✦ ${fmtInt(w)} mots · ≈ ${Math.max(1, Math.round(w / WORDS_PER_MIN))} min</p>
        </div>`);
    });

    // Notes du chapitre (synopsis, idées) — voyagent avec la sync.
    app.querySelector('[data-notes]').addEventListener('click', () => {
      const cc = current(); if (!cc) return;
      const body = openOverlay('Notes — ' + cc.title, `
        <textarea class="notes-area" data-notes-area placeholder="Synopsis, idées, choses à ne pas oublier…">${escapeHTML(cc.notes || '')}</textarea>
        <p class="overlay__hint">Sauvegardées automatiquement et synchronisées — jamais incluses dans le manuscrit exporté.</p>`);
      const area = body.querySelector('[data-notes-area]');
      area.addEventListener('input', () => {
        const c3 = state.chapters.find(x => x.id === cid); if (!c3) return;
        c3.notes = area.value;
        c3.updatedAt = new Date().toISOString();
        persistDebounced();
      });
      setTimeout(() => area.focus(), 100);
    });

    // Versions locales : consulter et restaurer.
    app.querySelector('[data-history]').addEventListener('click', () => {
      const list = (meta.versions[cid] || []).slice().reverse();
      const rows = list.length ? list.map((v, i) => `
        <div class="version">
          <div class="version__main">
            <div class="version__title">${escapeHTML(v.title)}</div>
            <div class="version__meta">${new Date(v.ts).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${fmtInt(v.words)} mots</div>
          </div>
          <button class="version__restore" data-restore="${i}" type="button">Restaurer</button>
        </div>`).join('')
        : '<p class="overlay__hint">Aucune version encore — elles se créent automatiquement à chaque ouverture du chapitre.</p>';
      const body = openOverlay('Versions (sur cet appareil)', rows);
      body.querySelectorAll('[data-restore]').forEach(b => b.addEventListener('click', () => {
        const v = list[Number(b.dataset.restore)];
        const c3 = state.chapters.find(x => x.id === cid); if (!c3 || !v) return;
        snapshotChapter(c3);   // la version actuelle devient elle-même restaurable
        c3.title = v.title; c3.content = v.content;
        c3.updatedAt = new Date().toISOString();
        persist();
        closeOverlay();
        renderEditor();
      }));
    });

    // Œil critique : analyse en panneau, ne touche jamais au texte.
    app.querySelector('[data-critic]').addEventListener('click', async () => {
      if (copilotBusy) { statusEl.textContent = 'Une génération est déjà en cours.'; return; }
      const cc = current(); if (!cc || !cc.content.trim()) { statusEl.textContent = 'Rien à lire encore.'; return; }
      if (!llmConfig()) { statusEl.textContent = 'Active la sync pour récupérer la config de l\'assistant.'; return; }
      copilotBusy = true;
      const body = openOverlay('Œil critique — ' + cc.title, '<p class="overlay__hint">Lecture en cours…</p>');
      let acc = '';
      try {
        await streamLLM(
          [{ role: 'system', content: SYSTEM_CRITIC }, { role: 'user', content: cc.content.slice(-6000) }],
          (d) => { acc += d; body.innerHTML = tinyMd(acc); },
          { temperature: 0.4, maxTokens: 500 },
        );
      } catch (e) {
        body.innerHTML = `<p class="overlay__hint">Échec : ${escapeHTML(e.message || e)}</p>`;
      } finally {
        copilotBusy = false;
      }
    });

    // Dictée.
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

    // Copilote (streaming dans le texte, restauration si échec immédiat).
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
    // L'ordre distant fait foi (il porte la réorganisation) ; les chapitres
    // locaux inconnus sont ajoutés à la suite ; conflit → le plus récent gagne.
    const out = { chapters: Array.isArray(remote.chapters) ? remote.chapters.slice() : [] };
    const byId = new Map(out.chapters.map(c => [c.id, c]));
    for (const c of (Array.isArray(local.chapters) ? local.chapters : [])) {
      const r = byId.get(c.id);
      if (!r) out.chapters.push(c);
      else if (new Date(c.updatedAt || 0) > new Date(r.updatedAt || 0)) Object.assign(r, c);
    }
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
    box.className = 'syncbox';
    box.innerHTML = `
      <p class="syncbox__txt">Synchronise tes chapitres avec Bob (et récupère la config du copilote) :</p>
      <form class="syncbox__form" data-sync-form>
        <input class="syncbox__input" type="password" placeholder="Passphrase de la sauvegarde Bob" autocomplete="current-password" data-sync-pass>
        <button class="syncbox__btn" type="submit">Activer</button>
      </form>
      <p class="syncbox__status" data-sync-status></p>`;
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
          if (!currentId) renderList();   // en édition : ne pas écraser la saisie
        }
      }).catch(() => {});
    };
    pull();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); });
  }

  // ---------- Init ----------
  trackDaily();
  renderList();
  initSync();
})();
