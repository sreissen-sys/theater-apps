/* Live-Fassung · Regie-Modus (Schritt 1: Schreiben mit mehreren, Prototyp)
   Gearbeitet wird in Live, das Google Doc bleibt der Speicher. Jede Person schreibt in ihrem eigenen Editor (ProseMirror, fest eingebaut).
   Alle 0,7 s werden eigene Änderungen als kleinste Änderungsliste ans Doc geschickt; Google führt sie mit gleichzeitigen Änderungen
   anderer zusammen (targetRevisionId). Fremde Änderungen werden alle 1,5 s geholt und so eingearbeitet, dass die eigene Schreibstelle bleibt.
   „Wer ist da“ und „schreibt gerade“ laufen über kleine Eigenschaften der Datei (wie beim Folgen). */
(() => {
  'use strict';
  const { S, getJson, DOCS, DRIVE, toast, mk, $, store, FOL, folShare, refresh, shown, neutral, colorOf, hex2rgb, rgb2hex } = window.LFAPI;
  const { state: { EditorState, Plugin, PluginKey }, view: { EditorView, Decoration, DecorationSet }, model: { Schema, DOMParser: PMParser },
    transform: { Transform }, history: { history, undo, redo }, keymap: { keymap }, commands: { baseKeymap, toggleMark, chainCommands },
    collab: { collab, sendableSteps, receiveTransaction } } = window.PM;
  const R = window.REGIE = { on: false, busy: false, others: new Map(), err: 0, sentT: 0, inputT: 0, rev: null, base: null, view: null, last: 'ok' };
  const SEND_MS = 700, POLL_MS = 1500, PRES_MS = 3000;

  /* ---------- Schema: Absätze (mit Doc-Format), Text mit Gewerk-Farbe, Fett, Kursiv, Unterstrichen; Tabellen und Bilder als feste Bausteine ---------- */
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'inline*', attrs: { named: { default: 'NORMAL_TEXT' }, al: { default: null } },
        parseDOM: [{ tag: 'p' }, { tag: 'h1', attrs: { named: 'HEADING_1' } }, { tag: 'h2', attrs: { named: 'HEADING_2' } }, { tag: 'h3', attrs: { named: 'HEADING_3' } }, { tag: 'div' }],
        toDOM: n => ['p', { class: 'rg-p rg-' + n.attrs.named.toLowerCase(), style: n.attrs.al === 'CENTER' ? 'text-align:center' : n.attrs.al === 'END' ? 'text-align:right' : null }, 0] },
      blk: { group: 'block', atom: true, selectable: false, attrs: { id: {}, len: { default: 1 }, txt: { default: '' }, kind: { default: 'table' } },
        toDOM: n => ['div', { class: 'rg-blk', contenteditable: 'false' }, (n.attrs.kind === 'table' ? 'Tabelle – im Regie-Modus noch nicht bearbeitbar: ' : '') + n.attrs.txt.slice(0, 240)] },
      text: { group: 'inline' },
      br: { group: 'inline', inline: true, selectable: false, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
      obj: { group: 'inline', inline: true, atom: true, attrs: { id: {}, kind: { default: 'obj' }, src: { default: null }, len: { default: 1 } },
        toDOM: n => n.attrs.src ? ['img', { src: n.attrs.src, class: 'rg-img', referrerpolicy: 'no-referrer', alt: 'Bild' }] : ['span', { class: 'rg-obj' }, n.attrs.kind === 'pageBreak' ? '⤓ Seitenumbruch' : '◆'] }
    },
    marks: {
      bold: { parseDOM: [{ tag: 'b' }, { tag: 'strong' }, { style: 'font-weight', getAttrs: v => (/^(bold|[6-9]00)$/.test(v) ? null : false) }], toDOM: () => ['b', 0] },
      italic: { parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }], toDOM: () => ['i', 0] },
      underline: { parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }], toDOM: () => ['u', 0] },
      color: { attrs: { hex: {} }, parseDOM: [{ style: 'color', getAttrs: v => { const h = cssHex(v); return h && !neutral(h) ? { hex: h } : false; } }],
        toDOM: m => ['span', { style: 'color:' + (shown(m.attrs.hex) || m.attrs.hex), 'data-hex': m.attrs.hex }, 0] }
    }
  });
  function cssHex(v) { const m = /^#([0-9a-f]{6})$/i.exec(v.trim()); if (m) return '#' + m[1].toUpperCase(); const r = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v); return r ? rgb2hex(+r[1], +r[2], +r[3]) : null; }

  /* ---------- Doc (JSON von Google) → Editor-Dokument ---------- */
  function fromDocs(json) {
    const inl = json.inlineObjects || {}, out = [];
    let start = null;
    for (const el of json.body?.content || []) {
      if (el.sectionBreak && start == null) { start = el.endIndex ?? 1; continue; }
      if (start == null) start = el.startIndex ?? 1;
      if (el.paragraph) {
        const P = el.paragraph, kids = [];
        for (const e of P.elements || []) {
          if (e.textRun) {
            let t = e.textRun.content || ''; if (t.endsWith('\n')) t = t.slice(0, -1); if (!t) continue;
            const ts = e.textRun.textStyle || {}, marks = [];
            if (ts.bold) marks.push(schema.marks.bold.create()); if (ts.italic) marks.push(schema.marks.italic.create()); if (ts.underline) marks.push(schema.marks.underline.create());
            const c = colorOf(ts); if (c && !neutral(c)) marks.push(schema.marks.color.create({ hex: c }));
            t.split('\u000b').forEach((part, i) => { if (i) kids.push(schema.nodes.br.create(null, null, marks)); if (part) kids.push(schema.text(part, marks)); });
          } else {
            const len = (e.endIndex ?? 0) - (e.startIndex ?? 0) || 1;
            if (e.inlineObjectElement) { const ip = inl[e.inlineObjectElement.inlineObjectId]?.inlineObjectProperties?.embeddedObject?.imageProperties; kids.push(schema.nodes.obj.create({ id: e.inlineObjectElement.inlineObjectId, kind: 'img', src: ip?.contentUri || null, len })); }
            else kids.push(schema.nodes.obj.create({ id: 'o' + e.startIndex, kind: Object.keys(e).find(k => !/Index$/.test(k)) || 'obj', len }));
          }
        }
        const ps = P.paragraphStyle || {};
        out.push(schema.nodes.paragraph.create({ named: ps.namedStyleType || 'NORMAL_TEXT', al: ps.alignment && ps.alignment !== 'START' ? ps.alignment : null }, kids));
      } else {
        const len = (el.endIndex ?? 0) - (el.startIndex ?? 0), kind = el.table ? 'table' : el.tableOfContents ? 'toc' : el.sectionBreak ? 'sec' : 'blk';
        let txt = ''; if (el.table) { const walk = c => (c || []).forEach(x => { if (x.paragraph) txt += (x.paragraph.elements || []).map(e => e.textRun?.content || '').join('').replace(/\n/g, ' '); if (x.table) x.table.tableRows.forEach(r => r.tableCells.forEach(cl => { walk(cl.content); txt += ' · '; })); }); walk([el]); }
        out.push(schema.nodes.blk.create({ id: kind + el.startIndex, len, txt: txt.trim(), kind }));
      }
    }
    if (!out.length) out.push(schema.nodes.paragraph.create());
    return { doc: schema.nodes.doc.create(null, out), start: start ?? 1, rev: json.revisionId };
  }

  /* ---------- Zerlegen in Zeichen mit Format (für Vergleich und für die Änderungsliste) ---------- */
  const sigOf = marks => marks.map(m => m.type.name[0] + (m.attrs.hex || '')).join('');
  function tokens(doc, start) {
    const T = []; let idx = start;
    doc.forEach((node, off) => {
      if (node.type === schema.nodes.blk) { T.push({ k: 'B' + node.attrs.id, pos: off, idx, len: node.attrs.len, blk: 1 }); idx += node.attrs.len; return; }
      let p = off + 1;
      node.forEach(ch => {
        if (ch.isText) { const s = sigOf(ch.marks), t = ch.text; for (let i = 0; i < t.length; i++) T.push({ k: t[i] + '\u0001' + s, ch: t[i], s, marks: ch.marks, pos: p + i, idx: idx + i, len: 1 }); p += t.length; idx += t.length; }
        else if (ch.type === schema.nodes.br) { const s = sigOf(ch.marks); T.push({ k: '\u000b\u0001' + s, ch: '\u000b', s, marks: ch.marks, pos: p, idx, len: 1 }); p += 1; idx += 1; }
        else { T.push({ k: 'O' + ch.attrs.id, obj: 1, pos: p, idx, len: ch.attrs.len }); p += 1; idx += ch.attrs.len; }
      });
      T.push({ k: '\n\u0001' + node.attrs.named + (node.attrs.al || ''), end: 1, named: node.attrs.named, al: node.attrs.al, pos: p, idx, len: 1 }); idx += 1;
    });
    T.endPos = doc.content.size; T.endIdx = idx; return T;
  }
  const posAt = (T, i) => (i < T.length ? T[i].pos : T.endPos);
  // kürzeste Änderung zwischen zwei Folgen: gleicher Anfang und gleiches Ende weg, die Mitte mit Myers
  function diff(A, B) {
    let a0 = 0, b0 = 0, a1 = A.length, b1 = B.length;
    while (a0 < a1 && b0 < b1 && A[a0].k === B[b0].k) { a0++; b0++; }
    while (a1 > a0 && b1 > b0 && A[a1 - 1].k === B[b1 - 1].k) { a1--; b1--; }
    if (a0 === a1 || b0 === b1) return a0 === a1 && b0 === b1 ? [] : [[a0, a1, b0, b1]];
    const ids = new Map(), id = k => { let v = ids.get(k); if (v == null) { v = ids.size; ids.set(k, v); } return v; };
    const a = [], b = []; for (let i = a0; i < a1; i++) a.push(id(A[i].k)); for (let i = b0; i < b1; i++) b.push(id(B[i].k));
    const n = a.length, m = b.length;
    if ((n + m) > 20000 && n * m > 4e6) return [[a0, a1, b0, b1]];   // sehr große Umbauten: als ein Stück
    const max = n + m, off = max, V = new Int32Array(2 * max + 2), trace = [];
    outer: for (let d = 0; d <= max; d++) {
      trace.push(V.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? V[off + k + 1] : V[off + k - 1] + 1, y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        V[off + k] = x; if (x >= n && y >= m) break outer;
      }
    }
    const ed = []; let x = n, y = m;                        // zurückverfolgen: '=' gleich, '-' weg, '+' neu
    for (let d = trace.length - 1; d >= 0; d--) {
      const v = trace[d], k = x - y, pk = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? k + 1 : k - 1, px = v[off + pk], py = px - pk;
      while (x > px && y > py) { ed.push(0); x--; y--; }
      if (d > 0) ed.push(x === px ? 1 : -1);
      x = px; y = py;
    }
    ed.reverse();
    const H = []; let ai = a0, bi = b0, cur = null;
    for (const e of ed) {
      if (e === 0) { if (cur) { H.push(cur); cur = null; } ai++; bi++; continue; }
      if (!cur) cur = [ai, ai, bi, bi];
      if (e < 0) { ai++; cur[1] = ai; } else { bi++; cur[3] = bi; }
    }
    if (cur) H.push(cur);
    return H;
  }

  /* ---------- Änderungsliste fürs Doc (von hinten nach vorn, damit die Stellen stimmen) ---------- */
  const rgb = hex => { const [r, g, b] = hex2rgb(hex); return { red: r / 255, green: g / 255, blue: b / 255 }; };
  const styleOf = marks => { const st = {}; for (const m of marks || []) { if (m.type.name === 'bold') st.bold = true; if (m.type.name === 'italic') st.italic = true; if (m.type.name === 'underline') st.underline = true; if (m.type.name === 'color') st.foregroundColor = { color: { rgbColor: rgb(m.attrs.hex) } }; } return st; };
  const FIELDS = 'bold,italic,underline,foregroundColor';
  function requests(A, B) {
    const H = diff(A, B), reqs = [];
    for (let h = H.length - 1; h >= 0; h--) {
      let [a0, a1, b0, b1] = H[h];
      let shifted = false; if (a0 === A.length && a0 > 0 && b0 > 0) { a0--; a1--; b0--; b1--; shifted = true; }   // Einfügen hinter dem letzten Umbruch = davor einfügen (Zeichen davor sind gleich)
      const da = A.slice(a0, a1), ib = B.slice(b0, b1);
      if (da.some(t => t.blk)) return null;                // Tabellen nicht anfassen (Bilder einfügen kommt in Schritt 3)
      const plain = t => (t.end ? '\n' : t.obj ? '￼' : t.ch);
      if (da.length === ib.length && da.every((t, i) => plain(t) === plain(ib[i]))) {        // nur Format geändert
        da.forEach((t, i) => {
          const u = ib[i]; if (t.k === u.k) return;
          if (t.end) reqs.push({ updateParagraphStyle: { range: { startIndex: t.idx, endIndex: t.idx + 1 }, paragraphStyle: { namedStyleType: u.named, alignment: u.al || 'START' }, fields: 'namedStyleType,alignment' } });
          else if (!t.obj) reqs.push({ updateTextStyle: { range: { startIndex: t.idx, endIndex: t.idx + 1 }, textStyle: styleOf(u.marks), fields: FIELDS } });
        });
        continue;
      }
      const last = A.length - 1; let keepEnd = null;
      if (a1 === A.length && ib.length && ib[ib.length - 1].end) { keepEnd = ib[ib.length - 1]; a1--; b1--; }   // der letzte Zeilenumbruch des Docs darf nicht weg
      else if (a1 === A.length && a0 > 0 && A[a0 - 1].end) { a0--; a1--; }   // statt des letzten den Umbruch davor löschen (gleiches Ergebnis)
      const at = a0 < A.length ? A[a0].idx : A.endIdx - 1;
      const ins = B.slice(b0, b1).filter(t => !t.obj && !t.blk), delLen = a1 > a0 ? A[a1 - 1].idx + A[a1 - 1].len - A[a0].idx : 0;
      if (a1 > a0) reqs.push({ deleteContentRange: { range: { startIndex: A[a0].idx, endIndex: A[a0].idx + delLen } } });
      if (ins.length) {
        reqs.push({ insertText: { location: { index: at }, text: ins.map(t => (t.end ? '\n' : t.ch)).join('') } });
        let j = 0; while (j < ins.length) {               // Format der neuen Zeichen genau setzen (sonst erben sie vom Zeichen davor)
          if (ins[j].end) { reqs.push({ updateParagraphStyle: { range: { startIndex: at + j, endIndex: at + j + 1 }, paragraphStyle: { namedStyleType: ins[j].named, alignment: ins[j].al || 'START' }, fields: 'namedStyleType,alignment' } }); j++; continue; }
          let k = j; while (k + 1 < ins.length && !ins[k + 1].end && ins[k + 1].s === ins[j].s) k++;
          reqs.push({ updateTextStyle: { range: { startIndex: at + j, endIndex: at + k + 1 }, textStyle: styleOf(ins[j].marks), fields: FIELDS } }); j = k + 1;
        }
      }
      if (shifted && !keepEnd) keepEnd = B[B.length - 1];
      if (keepEnd && A[last].k !== keepEnd.k) { const e = A[last].idx - delLen + ins.length; reqs.push({ updateParagraphStyle: { range: { startIndex: e, endIndex: e + 1 }, paragraphStyle: { namedStyleType: keepEnd.named, alignment: keepEnd.al || 'START' }, fields: 'namedStyleType,alignment' } }); }
    }
    return reqs;
  }
  // Schritte, die Dokument A in Dokument B verwandeln (für fremde Änderungen)
  function stepsBetween(docA, docB) {
    const A = tokens(docA, 1), B = tokens(docB, 1), H = diff(A, B), tr = new Transform(docA);
    for (let h = H.length - 1; h >= 0; h--) { let [a0, a1, b0, b1] = H[h]; if (a0 === A.length && a0 > 0 && b0 > 0) { a0--; a1--; b0--; b1--; } else if (a1 === A.length && b0 === b1 && a0 > 0 && b0 > 0 && A[a0 - 1].k === A[a1 - 1].k) { a0--; a1--; b0--; b1--; } try { tr.replace(posAt(A, a0), posAt(A, a1), docB.slice(posAt(B, b0), posAt(B, b1))); } catch (e) { if (R.fbx) R.fbx.push(['ex', String(e), JSON.stringify(H[h])]); return wholeSteps(docA, docB); } }
    if (!tr.doc.eq(docB) && tr.doc.childCount === docB.childCount) {   // Absatzformate (Überschrift …) gleichziehen
      let pos = 0; for (let i = 0; i < docB.childCount; i++) { const x = tr.doc.child(i), y = docB.child(i); if (x.type === y.type && x.type === schema.nodes.paragraph && JSON.stringify(x.attrs) !== JSON.stringify(y.attrs)) tr.setNodeMarkup(pos, null, y.attrs); pos += x.nodeSize; }
    }
    if (!tr.doc.eq(docB)) return wholeSteps(docA, docB);
    return tr.steps;
  }
  function wholeSteps(docA, docB) { R.fb = (R.fb || 0) + 1; if (R.fbx && R.fbx.length < 3) R.fbx.push([docA.textBetween(0, docA.content.size, '¶'), docB.textBetween(0, docB.content.size, '¶'), JSON.stringify(docB.toJSON().content.map(p => p.attrs.named))]); const tr = new Transform(docA); tr.replaceWith(0, docA.content.size, docB.content); return tr.steps; }

  /* ---------- Stelle im Doc ↔ Stelle im Editor (für „wer schreibt wo“) ---------- */
  function idxAt(doc, pos) { const T = tokens(doc, 1); let lo = 0, hi = T.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (T[mid].pos <= pos) lo = mid; else hi = mid - 1; } return T[lo] ? T[lo].idx + Math.max(0, pos - T[lo].pos) : 1; }
  function posAtIdx(doc, idx) { const T = tokens(doc, 1); let lo = 0, hi = T.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (T[mid].idx <= idx) lo = mid; else hi = mid - 1; } return T[lo] ? Math.min(T[lo].pos, doc.content.size) : 1; }

  /* ---------- Anzeige der anderen (Fähnchen mit Namen an ihrer Stelle) ---------- */
  const presKey = new PluginKey('rg-pres');
  const COLS = ['#D21F26', '#1F5FD2', '#1B8A3A', '#B04ACB', '#F28C1E', '#14A39A', '#7A4A21', '#E0457B'];
  const colOf = id => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLS[h % COLS.length]; };
  const presPlugin = new Plugin({
    key: presKey,
    state: { init: () => DecorationSet.empty, apply(tr, old, _s, ns) {
      if (!tr.getMeta(presKey) && !tr.docChanged) return old;
      const now = Date.now() / 1000, decos = [];
      for (const [id, o] of R.others) {
        if (now - o.t > 90 || o.i == null) continue;
        const pos = Math.max(1, Math.min(posAtIdx(ns.doc, o.i), ns.doc.content.size - 1)), typing = o.w && now - o.t < 8;
        decos.push(Decoration.widget(pos, () => { const s = document.createElement('span'); s.className = 'rg-flag' + (typing ? ' typing' : ''); s.style.setProperty('--c', colOf(id)); s.dataset.n = o.n + (typing ? ' schreibt …' : ''); return s; }, { side: -1, key: id + (typing ? 't' : '') + pos }));
        const $p = ns.doc.resolve(pos); if ($p.depth >= 1) { const a = $p.before(1), n = ns.doc.nodeAt(a); if (n && typing) decos.push(Decoration.node(a, a + n.nodeSize, { class: 'rg-busy', style: '--c:' + colOf(id) })); }
      }
      return DecorationSet.create(ns.doc, decos);
    } },
    props: { decorations: st => presKey.getState(st) }
  });
  // Tabellen und Blöcke nicht versehentlich löschen
  const guard = new Plugin({ filterTransaction: tr => { if (!tr.docChanged || tr.getMeta('rg-remote')) return true; let a = 0, b = 0; tr.before.forEach(n => { if (n.type === schema.nodes.blk) a++; }); tr.doc.forEach(n => { if (n.type === schema.nodes.blk) b++; }); if (b < a) { toast('Tabellen lassen sich im Regie-Modus noch nicht löschen.'); return false; } return true; } });

  /* ---------- Seiten wie in Docs: A4; ein Absatz, der nicht mehr auf die Seite passt, beginnt die nächste ---------- */
  const pgKey = new PluginKey('rg-pg');
  const pgPlugin = new Plugin({
    key: pgKey,
    state: { init: () => DecorationSet.empty, apply(tr, old) { const m = tr.getMeta(pgKey); if (m) return m; return tr.docChanged ? old.map(tr.mapping, tr.doc) : old; } },
    props: { decorations: st => pgKey.getState(st) },
    view: () => ({ update: (v, prev) => { if (v.state.doc !== prev.doc) pgSoon(); } })
  });
  function pgSoon() { clearTimeout(R.pgt); R.pgt = setTimeout(() => requestAnimationFrame(pgCalc), 80); }
  function pgCalc() {
    const v = R.view; if (!v || !R.on) return; const dom = v.dom, cs = getComputedStyle(dom);
    const W = dom.offsetWidth; if (!W) return;
    const H = Math.round(W * 1.4142), pT = parseFloat(cs.paddingTop), pB = parseFloat(cs.paddingBottom), pL = parseFloat(cs.paddingLeft), pR = parseFloat(cs.paddingRight), GAP = 26, C = H - pT - pB;
    let acc = 0; const box = [];
    for (const el of dom.children) {
      if (el.classList.contains('rg-pgbrk') || el.classList.contains('rg-pgend')) { if (el.classList.contains('rg-pgbrk')) acc += el.offsetHeight; continue; }
      const mt = parseFloat(getComputedStyle(el).marginTop) || 0; box.push([el.offsetTop - acc - mt, el.offsetTop - acc + el.offsetHeight]);
    }
    const pos = []; v.state.doc.forEach((n, off) => pos.push(off)); if (pos.length !== box.length) return;
    const want = []; let top = pT, page = 1;
    for (let i = 1; i < box.length; i++) {
      const [t, b] = box[i];
      if (b - top > C && t > top + 1) { const rest = Math.max(0, top + C - t); page++; want.push([pos[i], Math.round(rest), page]); top = t; }
    }
    const last = box.length ? box[box.length - 1][1] : pT, endH = Math.max(0, Math.round(top + C - last));
    const sig = W + '|' + want.map(w => w.join(':')).join(',') + '|' + endH; if (sig === R.pgsig) return; R.pgsig = sig;
    const decos = want.map(([p, rest, n]) => Decoration.widget(p, () => {
      const d = document.createElement('div'); d.className = 'rg-pgbrk'; d.contentEditable = 'false'; d.style.height = (rest + pB + GAP + pT) + 'px';
      const g = document.createElement('div'); g.className = 'rg-gap'; g.style.cssText = 'top:' + (rest + pB) + 'px;left:' + (-pL) + 'px;right:' + (-pR) + 'px;height:' + GAP + 'px'; g.textContent = 'Seite ' + n; d.append(g); return d;
    }, { side: -1, key: 'pg' + p + '-' + rest + '-' + n, ignoreSelection: true, stopEvent: () => true }));
    decos.push(Decoration.widget(v.state.doc.content.size, () => { const d = document.createElement('div'); d.className = 'rg-pgend'; d.contentEditable = 'false'; d.style.height = endH + 'px'; return d; }, { side: 1, key: 'pgend' + endH, ignoreSelection: true, stopEvent: () => true }));
    v.dispatch(v.state.tr.setMeta(pgKey, DecorationSet.create(v.state.doc, decos)).setMeta('addToHistory', false));
  }

  /* ---------- Bedienung ---------- */
  const setPara = (named) => (state, dispatch) => { const { from, to } = state.selection; const tr = state.tr; state.doc.nodesBetween(from, to, (n, pos) => { if (n.type === schema.nodes.paragraph) tr.setNodeMarkup(pos, null, { ...n.attrs, named }); return false; }); if (dispatch) dispatch(tr); return true; };
  function setColor(hex) {
    const v = R.view, st = v.state, { from, to, empty } = st.selection, mt = schema.marks.color;
    let tr = st.tr;
    if (empty) { tr = hex ? tr.addStoredMark(mt.create({ hex })) : tr.removeStoredMark(mt); }
    else { tr = tr.removeMark(from, to, mt); if (hex) tr = tr.addMark(from, to, mt.create({ hex })); }
    v.dispatch(tr); v.focus();
  }
  const ME = () => FOL.me + '-' + FOL.tab;
  const myName = () => store.get('rg-name', null) || folShare()?.name || '';

  function css() {
    if (document.getElementById('rg-css')) return;
    const s = document.createElement('style'); s.id = 'rg-css';
    s.textContent = `
#regie{position:fixed;inset:0;z-index:60;display:flex;flex-direction:column;background:var(--bg)}
#regie .rg-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:max(8px,env(safe-area-inset-top)) 12px 8px;background:var(--head,#16181B);color:var(--head-ink,#ECEDE8);box-shadow:0 2px 0 #E0457B}
#regie .rg-bar .btn,#regie .rg-bar select{background-color:#2E3137;color:rgba(236,237,232,.88);border:0;border-radius:2px;clip-path:var(--torn);min-height:38px;padding:0 12px;font:700 18px/1 var(--f-cond,system-ui);letter-spacing:.02em;cursor:pointer}
#regie .rg-bar .btn:hover,#regie .rg-bar select:hover{background-color:#383C43;color:#ECEDE8}
#regie .rg-bar .btn[aria-pressed=true]{background:var(--tape,#FFC21A);color:#16181B}
#regie .rg-bar select{-webkit-appearance:none;appearance:none;padding-right:32px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5l5 5 5-5' fill='none' stroke='%23ECEDE8' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 11px center}
#regie .rg-bar select option{color:#16181B;background:#fff}
#regie .rg-logo{font:700 20px/1 var(--f-cond,system-ui);letter-spacing:.02em;background:#E0457B;color:#fff;padding:5px 10px 3px;border-radius:2px;clip-path:var(--torn);transform:rotate(-2deg)}
#regie .rg-sep{width:1px;align-self:stretch;margin:6px 2px;background:rgba(236,237,232,.26)}
#regie .rg-chip{border-radius:2px;clip-path:var(--torn);padding:0 12px;min-height:34px;border:0;font:700 17px/1 var(--f-cond,system-ui);letter-spacing:.01em;cursor:pointer;opacity:.45;transition:opacity .15s,transform .15s;display:inline-flex;align-items:center;gap:6px}
#regie .rg-chip:hover{opacity:.75}
#regie .rg-chip.on{opacity:1;transform:translateY(-2px) rotate(-1deg);box-shadow:inset 0 -4px 0 rgba(0,0,0,.28)}
#regie .rg-chip.on::before{content:'';width:14px;height:14px;flex:none;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 20l1-4.5L15.5 5a2.1 2.1 0 013 3L8 18.5z' fill='none' stroke='black' stroke-width='2.4' stroke-linejoin='round'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M4 20l1-4.5L15.5 5a2.1 2.1 0 013 3L8 18.5z' fill='none' stroke='black' stroke-width='2.4' stroke-linejoin='round'/%3E%3C/svg%3E") center/contain no-repeat}
#regie .rg-who{display:flex;gap:6px;align-items:center;font:600 13px/1 var(--f-ui,system-ui);margin-left:auto}
#regie .rg-who span{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;border-radius:12px;background:rgba(236,237,232,.12)}
#regie .rg-who span i{width:8px;height:8px;border-radius:50%;background:var(--c)}
#regie .rg-who span.typing i{animation:rgPulse 1s infinite}
@keyframes rgPulse{50%{opacity:.25}}
#regie .rg-st{font:600 12px/1 var(--f-ui,system-ui);opacity:.75;min-width:90px;text-align:right}
#regie .rg-st.err{color:#FFB000;opacity:1}
#regie .rg-scroll{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:18px 10px 40vh}
#regie .ProseMirror{max-width:820px;margin:0 auto;background:var(--paper,#fff);color:var(--ink);padding:clamp(28px,7vw,68px) clamp(16px,6vw,72px);border-radius:2px;box-shadow:0 2px 0 rgba(22,24,27,.14),0 14px 40px rgba(22,24,27,.16);outline:none;position:relative;font:var(--fs,18px)/1.5 var(--f-read,Georgia,serif);white-space:pre-wrap;word-wrap:break-word;caret-color:#E0457B;tab-size:3.2em;-moz-tab-size:3.2em}
#regie .rg-p{margin:0 0 .35em;min-height:1em;position:relative}
#regie .rg-pgbrk{position:relative;user-select:none;-webkit-user-select:none;pointer-events:none}
#regie .rg-pgend{user-select:none;pointer-events:none}
#regie .rg-gap{position:absolute;background:var(--bg);display:flex;align-items:center;justify-content:center;font:700 12px/1 var(--f-ui,system-ui);letter-spacing:.04em;color:var(--mute);box-shadow:inset 0 6px 6px -6px rgba(0,0,0,.25),inset 0 -6px 6px -6px rgba(0,0,0,.25)}
#regie .rg-heading_1{font-size:1.45em;font-weight:700;margin-top:.8em}
#regie .rg-heading_2{font-size:1.22em;font-weight:700;margin-top:.6em}
#regie .rg-heading_3{font-size:1.08em;font-weight:700}
#regie p.rg-title{font-size:1.7em;font-weight:800}
#regie p.rg-subtitle{font-size:1.2em;color:var(--mute)}
#regie .rg-blk{margin:.6em 0;padding:10px 12px;border:1px dashed var(--line,#bbb);border-radius:6px;color:var(--mute,#666);font:13px/1.4 var(--f-ui,system-ui);user-select:none}
#regie .rg-img{max-width:100%;height:auto;vertical-align:bottom}
#regie .rg-obj{font:12px var(--f-ui,system-ui);color:var(--mute,#777);border:1px solid var(--line,#ccc);border-radius:4px;padding:0 4px}
#regie .rg-flag{position:relative;display:inline-block;width:0;height:1.2em;vertical-align:text-bottom;border-left:2px solid var(--c);margin-right:-2px}
#regie .rg-flag::after{content:attr(data-n);position:absolute;left:-2px;top:-1.35em;white-space:nowrap;background:var(--c);color:#fff;font:600 11px/1 var(--f-ui,system-ui);padding:3px 5px;border-radius:3px 3px 3px 0;pointer-events:none}
#regie .rg-busy{box-shadow:-6px 0 0 -3px var(--c)}
#regie .rg-name{display:flex;gap:8px;align-items:center;flex-wrap:wrap;max-width:820px;margin:0 auto 12px;font:14px/1.4 var(--f-ui,system-ui);color:var(--ink)}
#regie .rg-name input{min-height:36px;border:1px solid var(--line,#bbb);border-radius:8px;padding:0 10px;font:inherit}
body.regie-on{overflow:hidden}
body.regie-on #bar,body.regie-on #jump,body.regie-on #next,body.regie-on #walk{display:none!important}
`;
    document.head.append(s);
  }

  function chips(bar) {
    const box = mk('span'); box.style.display = 'contents';
    const light = h => { const c = hex2rgb(h); return c && (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000 > 160; };
    const add = (name, hex, tip) => { const b = mk('button', 'rg-chip', name); b.type = 'button'; b.title = tip || ('Auswahl dem Gewerk „' + name + '“ zuordnen'); const bg = hex ? (shown(hex) || hex) : '#ECEDE8'; b.style.background = bg; b.style.color = !hex || light(bg) ? '#16181B' : '#fff'; b.dataset.hex = (hex || '').toLowerCase(); b.onmousedown = e => e.preventDefault(); b.onclick = () => setColor(hex); box.append(b); };
    add('Text', null, 'Auswahl als Text der Spielenden (schwarz)');
    for (const l of S.legend || []) add(l.name, l.hex);
    if (!(S.legend || []).length) for (const c of [...(S.cats?.values() || [])]) if (c.hex) add(c.name, c.hex);
    bar.append(box);
  }

  function build() {
    css();
    const root = mk('div'); root.id = 'regie';
    const bar = mk('div', 'rg-bar'), btn = (t, title, fn) => { const b = mk('button', 'btn', t); b.type = 'button'; b.title = title || ''; b.onmousedown = e => e.preventDefault(); b.onclick = fn; bar.append(b); return b; };
    bar.append(mk('span', 'rg-logo', 'REGIE'));
    btn('Beenden', 'Regie-Modus verlassen, zurück zur Live-Fassung', () => stop());
    bar.append(mk('span', 'rg-sep'));
    btn('↶', 'Rückgängig (eigene Änderungen)', () => { undo(R.view.state, R.view.dispatch); R.view.focus(); });
    btn('↷', 'Wiederholen', () => { redo(R.view.state, R.view.dispatch); R.view.focus(); });
    bar.append(mk('span', 'rg-sep'));
    const B = R.B = btn('F', 'Fett', () => { toggleMark(schema.marks.bold)(R.view.state, R.view.dispatch); R.view.focus(); }); B.style.fontWeight = '800';
    const I = R.I = btn('K', 'Kursiv (Regieanweisung)', () => { toggleMark(schema.marks.italic)(R.view.state, R.view.dispatch); R.view.focus(); }); I.style.fontStyle = 'italic';
    const ps = mk('select'); ps.title = 'Absatzformat'; [['NORMAL_TEXT', 'Text'], ['HEADING_1', 'Überschrift 1 (Akt)'], ['HEADING_2', 'Überschrift 2 (Szene)'], ['HEADING_3', 'Überschrift 3'], ['TITLE', 'Titel']].forEach(([v, t]) => ps.append(new Option(t, v)));
    ps.onchange = () => { setPara(ps.value)(R.view.state, R.view.dispatch); R.view.focus(); }; bar.append(ps); R.ps = ps;
    bar.append(mk('span', 'rg-sep'));
    chips(bar);
    const who = mk('span', 'rg-who'); bar.append(who); R.who = who;
    const st = mk('span', 'rg-st', ''); bar.append(st); R.st = st;
    const sc = mk('div', 'rg-scroll'); root.append(bar, sc); R.sc = sc;
    if (!myName()) {
      const nm = mk('div', 'rg-name'); nm.append(mk('span', '', 'Dein Name für die anderen:')); const inp = mk('input'); inp.placeholder = 'z. B. Regie, Sam, Inspizienz'; inp.maxLength = 20; const ok = mk('button', 'btn', 'Übernehmen'); ok.type = 'button';
      ok.onclick = () => { const v = inp.value.trim(); if (!v) return; store.set('rg-name', v); nm.remove(); presSend(true); }; nm.append(inp, ok); sc.append(nm);
    }
    const host = mk('div'); sc.append(host);
    document.body.append(root); document.body.classList.add('regie-on');
    return host;
  }

  function status(t, err) { R.last = t; if (!R.st) return; R.st.textContent = t; R.st.classList.toggle('err', !!err); }
  function syncMarks() {                                    // welches Gewerk (Farbe) und welche Auszeichnung gerade gilt – am Knopf sichtbar
    const st = R.view.state, { from, empty, $from } = st.selection;
    const marks = empty ? (st.storedMarks || $from.marks()) : (st.doc.nodeAt(from)?.marks || $from.marks());
    const col = marks.find(m => m.type === schema.marks.color)?.attrs.hex?.toLowerCase() || '';
    document.querySelectorAll('#regie .rg-chip').forEach(b => { const on = b.dataset.hex === col; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    R.B?.setAttribute('aria-pressed', marks.some(m => m.type === schema.marks.bold)); R.I?.setAttribute('aria-pressed', marks.some(m => m.type === schema.marks.italic));
  }
  function syncPs() { const $f = R.view.state.selection.$from, n = $f.depth >= 1 ? $f.node(1) : null; if (n && n.type === schema.nodes.paragraph && R.ps.value !== n.attrs.named) R.ps.value = n.attrs.named; }

  /* ---------- Abgleich mit dem Doc ---------- */
  async function fetchDoc() { const j = await getJson(DOCS + encodeURIComponent(S.id)); const f = fromDocs(j); R.json = j; return f; }
  function receive(fromDoc, srv, sent) {                     // Server-Stand einarbeiten; eigene gesendete Schritte gelten als bestätigt
    const v = R.view, delta = stepsBetween(fromDoc, srv.doc);
    if (R.dbg) R.dbg.push(['recv', !!sent, delta.length, fromDoc.childCount, srv.doc.childCount, v.state.doc.childCount, sendableSteps(v.state)?.steps.length || 0]);
    const steps = sent ? [...sent.steps, ...delta] : delta, ids = sent ? [...sent.steps.map(() => sent.clientID), ...delta.map(() => 'srv')] : delta.map(() => 'srv');
    if (steps.length) { const tr = receiveTransaction(v.state, steps, ids, { mapSelectionBackward: true }); tr.setMeta('rg-remote', true); v.dispatch(tr); }
    R.base = srv.doc; R.st0 = srv.start; R.rev = srv.rev;
  }
  async function tick() {
    if (!R.on || R.busy) return;
    const v = R.view, sendable = sendableSteps(v.state), now = Date.now();
    if (now < (R.waitT || 0)) return;                       // Google bremst gerade (zu viele Anfragen): kurz Pause
    if (sendable && (now - R.sentT < 1100 || (now - R.inputT < 350 && now - R.sentT < 2500))) return;   // höchstens etwa einmal pro Sekunde schreiben (Google erlaubt 60 je Minute); mitten im Tippen kurz warten, aber nie länger als 2,5 s
    if (!sendable && now - R.pollT < POLL_MS) return;
    R.busy = true;
    try {
      if (sendable) {
        const L = v.state.doc, reqs = requests(tokens(R.base, R.st0), tokens(L, R.st0));
        R.sentT = now;
        if (reqs === null) { toast('Diese Änderung geht im Regie-Modus noch nicht.'); restart(await fetchDoc()); return; }
        status('speichert …');
        if (reqs.length) {
          try { await getJson(DOCS + encodeURIComponent(S.id) + ':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: reqs, writeControl: { targetRevisionId: R.rev } }) }); }
          catch (e) {
            R.fail = (R.fail || 0) + 1;
            if (R.fail >= 3) { toast('Eine Änderung ließ sich nicht ins Doc schreiben und wurde verworfen.', 5000); const srv = await fetchDoc(); restart(srv); R.fail = 0; return; }
            const srv = await fetchDoc(); receive(R.base, srv, null); throw e;   // neu einordnen und gleich noch einmal
          }
          R.fail = 0;
        }
        const srv = await fetchDoc(); receive(L, srv, sendable);
      } else {
        R.pollT = now; const from = v.state.doc;            // bestätigter Stand – vor dem Warten festhalten
        const j = await getJson(DOCS + encodeURIComponent(S.id) + '?fields=revisionId');
        if (j.revisionId && j.revisionId !== R.rev) { const srv = await fetchDoc(); receive(from, srv, null); }   // inzwischen Getipptes wird darüber neu eingeordnet
      }
      R.err = 0; status(sendableSteps(R.view.state) ? 'ungespeichert' : 'gespeichert');
    } catch (e) { R.err++; if (e.status === 429) R.waitT = Date.now() + Math.min(20000, 2000 * R.err); status(e.login ? 'Anmeldung nötig' : e.status === 429 ? 'Google bremst – gleich weiter' : 'kein Netz – versucht weiter', true); }
    finally { R.busy = false; }
  }
  function restart(srv) {
    R.view.updateState(EditorState.create({ doc: srv.doc, plugins: R.view.state.plugins }));
    R.base = srv.doc; R.st0 = srv.start; R.rev = srv.rev;
  }

  /* ---------- Wer ist da, wer schreibt ---------- */
  async function presSend(force) {
    if (!R.on) return; const now = Date.now(), typing = now - R.inputT < 5000;
    const i = idxAt(R.view.state.doc, R.view.state.selection.head), n = (myName() || 'Ohne Namen').slice(0, 16);
    const v = { n, i, t: Math.floor(now / 1000), w: typing ? 1 : 0 }, sig = n + '|' + Math.round(i / 3) + '|' + v.w;
    if (!force && sig === R.psig && now - R.presT < 30000) return;
    if (!force && now - R.presT < 1200) return;
    R.psig = sig; R.presT = now;
    try { R.bc?.postMessage({ doc: S.id, id: ME(), v }); } catch (e) {}
    if (S.mode === 'demo') return;
    try { await getJson(DRIVE + encodeURIComponent(S.id) + '?fields=id&supportsAllDrives=true', { method: 'PATCH', body: JSON.stringify({ appProperties: { ['lfr_' + ME()]: JSON.stringify(v) } }) }); } catch (e) {}
  }
  async function presPoll() {
    if (!R.on || S.mode === 'demo') return;
    try {
      const j = await getJson(DRIVE + encodeURIComponent(S.id) + '?fields=appProperties&supportsAllDrives=true'), ap = j.appProperties || {}, seen = new Set();
      for (const [k, val] of Object.entries(ap)) { if (!k.startsWith('lfr_')) continue; const id = k.slice(4); if (id === ME()) continue; try { R.others.set(id, JSON.parse(val)); seen.add(id); } catch (e) {} }
      for (const id of [...R.others.keys()]) if (!seen.has(id) && !R.others.get(id)?.bc) R.others.delete(id);
      showWho();
    } catch (e) {}
  }
  function showWho() {
    if (!R.who) return; const now = Date.now() / 1000; R.who.textContent = '';
    const me = mk('span', '', (myName() || 'Ich') + ' (ich)'); const mi = mk('i'); me.prepend(mi); me.style.setProperty('--c', colOf(ME())); R.who.append(me);
    for (const [id, o] of R.others) { if (now - o.t > 90) continue; const typing = o.w && now - o.t < 8; const s = mk('span', typing ? 'typing' : '', o.n + (typing ? ' schreibt …' : '')); const i = mk('i'); s.prepend(i); s.style.setProperty('--c', colOf(id)); R.who.append(s); }
    if (R.view) R.view.dispatch(R.view.state.tr.setMeta(presKey, true));
  }

  /* ---------- Start und Ende ---------- */
  async function start() {
    if (R.on) return;
    if (!S.id || !(S.canEdit || S.mode === 'demo')) { toast('Der Regie-Modus braucht Bearbeitungsrechte am Doc.'); return; }
    R.on = true; R.others.clear();
    const host = build(); status('lädt …');
    let srv; try { srv = await fetchDoc(); } catch (e) { toast('Fassung ließ sich nicht laden: ' + e.message); stop(); return; }
    R.base = srv.doc; R.st0 = srv.start; R.rev = srv.rev; R.pollT = Date.now();
    const st = EditorState.create({ doc: srv.doc, plugins: [history(), keymap({ 'Mod-z': undo, 'Mod-y': redo, 'Shift-Mod-z': redo, 'Mod-b': toggleMark(schema.marks.bold), 'Mod-i': toggleMark(schema.marks.italic), 'Mod-u': toggleMark(schema.marks.underline), 'Tab': (s, d) => { if (d) d(s.tr.insertText('\t').scrollIntoView()); return true; }, 'Shift-Enter': (s, d) => { if (d) d(s.tr.replaceSelectionWith(schema.nodes.br.create()).scrollIntoView()); return true; } }), keymap(baseKeymap), collab({ clientID: ME() }), presPlugin, guard, pgPlugin] });
    R.view = new EditorView(host, { state: st, attributes: { spellcheck: 'true', autocapitalize: 'sentences' },
      dispatchTransaction(tr) { const ns = R.view.state.apply(tr); R.view.updateState(ns); if (tr.docChanged && !tr.getMeta('rg-remote')) { R.inputT = Date.now(); status('ungespeichert'); presSend(); } if (tr.selectionSet || tr.docChanged || tr.storedMarksSet) { syncPs(); syncMarks(); } if (tr.selectionSet || tr.docChanged) presSend(); } });
    try { R.bc = new BroadcastChannel('livefassung-regie'); R.bc.onmessage = e => { const d = e.data; if (d?.doc === S.id && d.id !== ME()) { if (d.v) R.others.set(d.id, { ...d.v, bc: 1 }); else R.others.delete(d.id); showWho(); } }; } catch (e) {}
    R.ti = setInterval(tick, 250); R.pi = setInterval(() => { presPoll(); presSend(); showWho(); }, PRES_MS);
    presSend(true); presPoll(); status('gespeichert'); R.view.focus(); syncMarks();
    R.pgsig = ''; pgSoon(); document.fonts?.ready?.then(pgSoon); R.rz = () => { R.pgsig = ''; pgSoon(); }; addEventListener('resize', R.rz);
  }
  async function stop() {
    const was = R.on; R.on = false; clearInterval(R.ti); clearInterval(R.pi);
    if (was && R.view && sendableSteps(R.view.state)) { try { R.on = true; R.busy = false; R.inputT = 0; R.sentT = 0; await tick(); } catch (e) {} R.on = false; }   // Letztes noch speichern
    try { R.bc?.postMessage({ doc: S.id, id: ME(), v: null }); R.bc?.close(); } catch (e) {}
    if (was && S.mode !== 'demo') { try { await getJson(DRIVE + encodeURIComponent(S.id) + '?fields=id&supportsAllDrives=true', { method: 'PATCH', body: JSON.stringify({ appProperties: { ['lfr_' + ME()]: null } }) }); } catch (e) {} }
    removeEventListener('resize', R.rz); clearTimeout(R.pgt);
    R.view?.destroy(); R.view = null; document.getElementById('regie')?.remove(); document.body.classList.remove('regie-on');
    if (was) { try { await refresh(true); } catch (e) {} }
  }
  R.start = start; R.stop = stop; R._ = { fromDocs, tokens, diff, requests, stepsBetween, tick };
  addEventListener('pagehide', () => { if (R.on) { try { R.bc?.postMessage({ doc: S.id, id: ME(), v: null }); } catch (e) {} } });
})();
