// BobSync — client de sauvegarde cloud « satellite » pour les apps autonomes.
//
// Contexte : iOS donne un conteneur de stockage séparé à chaque app installée.
// Bob (cockpit) porte la sync chiffrée de bout en bout ; les apps installées en
// solo (Santé, Écrire) n'ont ni les clés ni les données. Ce module réplique
// exactement la crypto de Bob (PBKDF2 600k, labels 'auth'/'data', AES-GCM) et
// synchronise le MÊME blob :
//   - pull : si le distant est plus récent, on écrit le miroir local complet
//     (cockpit-v3 + _writer + _healthTracker + _notes) — ce qui apporte aussi
//     la config LLM nécessaire à la dictée vocale.
//   - push : on retire le blob le plus frais, on y greffe UNIQUEMENT notre
//     section, on re-chiffre, on renvoie. Les autres sections ne sont jamais
//     écrasées par ce client.
//   - première activation : FUSION locale+distant (rien de saisi en solo
//     n'est perdu), puis push du résultat.
//
// API : BobSync.configure({section, localKey, merge}) ; .isEnabled() ;
//       .unlock(passphrase) ; .reconcile() ; .schedulePush() ; .status()
(function () {
  'use strict';

  const WORKER_URL = 'https://bob.jz7w76ry59.workers.dev';
  const LS_KEY = 'bob-sync-v1';
  const MIRRORS = {
    _writer: 'bob-writer-v1',
    _healthTracker: 'health-tracker-v1',
    _notes: 'bob-notes-v1',
  };
  const PUSH_DEBOUNCE_MS = 4000;

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let cfg = { section: null, localKey: null, merge: null };
  let pushTimer = null;
  let pushInFlight = null;
  let lastPushedSectionHash = null;

  // ---------- crypto (réplique exacte de cockpit/modules/crypto.js) ----------
  function bytesToHex(buf) {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.substr(i, 2), 16);
    return out;
  }
  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return bytesToHex(buf);
  }
  async function deriveBits(passphrase, salt, label) {
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    return crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: enc.encode(salt + ':' + label), iterations: 600000, hash: 'SHA-256' },
      baseKey, 256,
    );
  }
  async function deriveKeys(passphrase, salt) {
    const [authBytes, dataBytes] = await Promise.all([
      deriveBits(passphrase, salt, 'auth'),
      deriveBits(passphrase, salt, 'data'),
    ]);
    return { authToken: bytesToHex(authBytes), dataKeyHex: bytesToHex(dataBytes) };
  }
  async function importDataKey(hex) {
    return crypto.subtle.importKey('raw', hexToBytes(hex), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  async function encryptText(plaintext, dataKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dataKey, enc.encode(plaintext));
    return { iv: bytesToHex(iv), ciphertext: bytesToHex(ct) };
  }
  async function decryptText(ivHex, ctHex, dataKey) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(ivHex) }, dataKey, hexToBytes(ctHex));
    return dec.decode(pt);
  }

  // ---------- état local ----------
  function readLocal() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { return null; }
  }
  function writeLocal(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {}
  }
  function readMirror(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  }

  // ---------- réseau ----------
  async function fetchBlob(local) {
    const resp = await fetch(WORKER_URL + '/sync/data', {
      headers: { 'Authorization': 'Bearer ' + local.authToken },
    });
    if (resp.status === 401) throw new Error('Passphrase incorrecte.');
    if (!resp.ok) throw new Error('Worker HTTP ' + resp.status);
    return resp.json();   // null si aucun blob
  }

  // Applique un blob déchiffré au conteneur local : miroir complet.
  function applyBlob(parsed) {
    const root = Object.assign({}, parsed);
    for (const k of Object.keys(MIRRORS)) delete root[k];
    try { localStorage.setItem('cockpit-v3', JSON.stringify(root)); } catch {}
    for (const [field, key] of Object.entries(MIRRORS)) {
      if (parsed[field] && typeof parsed[field] === 'object') {
        try { localStorage.setItem(key, JSON.stringify(parsed[field])); } catch {}
      }
    }
  }

  // ---------- API ----------
  const BobSync = {
    configure(options) { cfg = Object.assign(cfg, options || {}); },

    isEnabled() {
      const s = readLocal();
      return !!(s && s.authToken && s.dataKeyHex);
    },

    status() {
      const s = readLocal() || {};
      return { enabled: this.isEnabled(), lastSyncAt: s.lastPulledAt || null };
    },

    // Première activation : dérive les clés, vérifie, PULL + FUSION de la
    // section locale (rien de saisi hors-sync n'est perdu), puis push.
    async unlock(passphrase) {
      const saltResp = await fetch(WORKER_URL + '/sync/salt');
      if (!saltResp.ok) throw new Error('Worker indisponible (HTTP ' + saltResp.status + ').');
      const remote = await saltResp.json();
      if (!remote.setup) throw new Error('Aucune sauvegarde cloud — active la sync dans Bob d\'abord.');

      const keys = await deriveKeys(passphrase, remote.salt);
      const local = { salt: remote.salt, authToken: keys.authToken, dataKeyHex: keys.dataKeyHex };
      const data = await fetchBlob(local);   // 401 → passphrase incorrecte

      const localSection = cfg.localKey ? readMirror(cfg.localKey) : null;
      if (data && data.iv) {
        const dataKey = await importDataKey(local.dataKeyHex);
        const parsed = JSON.parse(await decryptText(data.iv, data.ciphertext, dataKey));
        // Fusion de NOTRE section avant d'écraser quoi que ce soit.
        if (cfg.section && localSection && typeof cfg.merge === 'function') {
          parsed[cfg.section] = cfg.merge(localSection, parsed[cfg.section] || null) || parsed[cfg.section];
        }
        applyBlob(parsed);
        local.lastPulledAt = data.updatedAt || Date.now();
        writeLocal(local);
        // Pousse la fusion pour que Bob et les autres appareils la voient.
        await this._pushSection(parsed);
      } else {
        local.lastPulledAt = 0;
        writeLocal(local);
      }
      return true;
    },

    // Pull-si-plus-récent. Retourne {applied:true} si le local a été remplacé.
    async reconcile() {
      if (!this.isEnabled()) return { applied: false };
      if (pushInFlight) { try { await pushInFlight; } catch {} }
      const local = readLocal();
      let data;
      try { data = await fetchBlob(local); } catch { return { applied: false }; }
      if (!data || !data.updatedAt) return { applied: false };
      if (data.updatedAt <= (local.lastPulledAt || 0)) return { applied: false };
      const dataKey = await importDataKey(local.dataKeyHex);
      const parsed = JSON.parse(await decryptText(data.iv, data.ciphertext, dataKey));
      applyBlob(parsed);
      writeLocal(Object.assign(readLocal(), { lastPulledAt: data.updatedAt }));
      lastPushedSectionHash = null;
      return { applied: true };
    },

    // À appeler après chaque sauvegarde locale de la section.
    schedulePush() {
      if (!this.isEnabled() || !cfg.section || !cfg.localKey) return;
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => { this._runPush(); }, PUSH_DEBOUNCE_MS);
    },

    async _runPush() {
      if (pushInFlight) { try { await pushInFlight; } catch {} }
      pushInFlight = (async () => {
        const local = readLocal();
        if (!local) return;
        const section = readMirror(cfg.localKey);
        if (!section) return;
        const sectionHash = await sha256Hex(JSON.stringify(section));
        if (sectionHash === lastPushedSectionHash) return;   // rien de neuf

        // Greffe sur le blob le plus frais — jamais d'écrasement des autres
        // sections depuis ce client.
        let parsed = null;
        try {
          const data = await fetchBlob(local);
          if (data && data.iv) {
            const dataKey = await importDataKey(local.dataKeyHex);
            parsed = JSON.parse(await decryptText(data.iv, data.ciphertext, dataKey));
          }
        } catch { return; }   // hors-ligne — retentera à la prochaine sauvegarde
        if (!parsed) parsed = readMirror('cockpit-v3') || { version: 3 };
        parsed[cfg.section] = section;
        await this._pushSection(parsed);
        lastPushedSectionHash = sectionHash;
      })();
      try { await pushInFlight; } finally { pushInFlight = null; }
    },

    async _pushSection(parsedBlob) {
      const local = readLocal();
      const dataKey = await importDataKey(local.dataKeyHex);
      const payload = await encryptText(JSON.stringify(parsedBlob), dataKey);
      const resp = await fetch(WORKER_URL + '/sync/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + local.authToken },
        body: JSON.stringify({ iv: payload.iv, ciphertext: payload.ciphertext, version: 1 }),
      });
      if (resp.ok) {
        const out = await resp.json().catch(() => ({}));
        writeLocal(Object.assign(readLocal(), { lastPulledAt: out.updatedAt || Date.now() }));
      }
    },
  };

  window.BobSync = BobSync;
})();
