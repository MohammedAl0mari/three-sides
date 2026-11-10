(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PLAYERS = [
    { name: 'Teal', color: '#0f9d94' },
    { name: 'Coral', color: '#e8553d' },
    { name: 'Violet', color: '#7c4ddb' },
    { name: 'Amber', color: '#d99a06' },
  ];
  // The three lattice directions and their opposites.
  const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  const MAX_SPAN = 3; // a line covers at most 3 segments (4 dots)
  const S = 60;       // distance between neighbouring dots, in SVG units

  const $ = id => document.getElementById(id);
  const boardEl = $('board');
  const scoresEl = $('scores');
  const statusEl = $('status');
  const remainingEl = $('remaining');
  const undoBtn = $('undo');

  let g; // current game

  // Online session. mode: 'local' (one device), 'host' (owns the game) or 'client'.
  const net = {
    mode: 'local', peer: null, code: '', seat: 0, started: false,
    seats: [],                 // host only: [{ id, conn }] in seat order, seat 0 is the host
    conn: null, linked: false, everLinked: false, pending: false, // client only
    joined: 1, connected: [], tries: 0, timer: null,
  };

  const key = (q, r) => q + ',' + r;
  const edgeKey = (a, b) => (a.k < b.k ? a.k + '|' + b.k : b.k + '|' + a.k);

  function svg(tag, attrs, parent) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const name in attrs) el.setAttribute(name, attrs[name]);
    if (parent) parent.appendChild(el);
    return el;
  }

  /* ---------- setup ---------- */

  function newGame(numPlayers, radius) {
    const points = new Map();
    for (let q = -radius; q <= radius; q++) {
      for (let r = -radius; r <= radius; r++) {
        if (Math.abs(q + r) > radius) continue;
        points.set(key(q, r), {
          q, r, k: key(q, r),
          x: S * (q + r / 2),
          y: S * r * Math.sqrt(3) / 2,
        });
      }
    }

    const edges = new Map();
    for (const p of points.values()) {
      for (const [dq, dr] of DIRS.slice(0, 3)) {
        const n = points.get(key(p.q + dq, p.r + dr));
        if (n) edges.set(edgeKey(p, n), { a: p, b: n, move: -1 });
      }
    }

    const tris = [];
    const addTri = (k1, k2, k3) => {
      const a = points.get(k1), b = points.get(k2), c = points.get(k3);
      if (!a || !b || !c) return;
      tris.push({
        pts: [a, b, c],
        edges: [edges.get(edgeKey(a, b)), edges.get(edgeKey(b, c)), edges.get(edgeKey(a, c))],
        owner: -1,
      });
    };
    for (let q = -radius - 1; q <= radius; q++) {
      for (let r = -radius - 1; r <= radius; r++) {
        addTri(key(q, r), key(q + 1, r), key(q, r + 1));
        addTri(key(q + 1, r), key(q, r + 1), key(q + 1, r + 1));
      }
    }

    g = {
      numPlayers, radius, points, edges, tris,
      scores: new Array(numPlayers).fill(0),
      current: 0,
      covered: 0,
      moves: [],        // [startKey, endKey] in play order
      lastEvent: null,  // { player, claimed } for the most recent move
      selected: null,
      targets: new Map(),
    };
    buildBoard();
    render();
  }

  // Clears all progress but keeps the board and its DOM.
  function resetState() {
    for (const e of g.edges.values()) e.move = -1;
    for (const t of g.tris) t.owner = -1;
    g.scores.fill(0);
    g.current = 0;
    g.covered = 0;
    g.moves = [];
    g.lastEvent = null;
    clearSelection();
  }

  // Rebuilds the game from a move list (used by undo and by online sync).
  function loadState(numPlayers, radius, moves) {
    if (!g || g.numPlayers !== numPlayers || g.radius !== radius) newGame(numPlayers, radius);
    else resetState();
    for (const [a, b] of moves) play(a, b);
    render();
  }

  function buildBoard() {
    boardEl.textContent = '';
    const w = g.radius * S + 34;
    const h = g.radius * S * Math.sqrt(3) / 2 + 34;
    boardEl.setAttribute('viewBox', `${-w} ${-h} ${2 * w} ${2 * h}`);

    const triLayer = svg('g', {}, boardEl);
    const edgeLayer = svg('g', {}, boardEl);
    g.previewEl = svg('line', { class: 'preview', visibility: 'hidden' }, boardEl);
    const pegLayer = svg('g', {}, boardEl);

    for (const t of g.tris) {
      t.el = svg('polygon', {
        class: 'tri',
        points: t.pts.map(p => `${p.x},${p.y}`).join(' '),
      }, triLayer);
      t.label = svg('text', {
        class: 'tri-label',
        x: (t.pts[0].x + t.pts[1].x + t.pts[2].x) / 3,
        y: (t.pts[0].y + t.pts[1].y + t.pts[2].y) / 3,
      }, triLayer);
    }

    for (const e of g.edges.values()) {
      e.el = svg('line', { class: 'edge', x1: e.a.x, y1: e.a.y, x2: e.b.x, y2: e.b.y }, edgeLayer);
    }

    for (const p of g.points.values()) {
      const el = svg('g', { class: 'peg', tabindex: 0, role: 'button', 'aria-label': `Dot ${p.q}, ${p.r}` }, pegLayer);
      svg('circle', { class: 'hit', cx: p.x, cy: p.y, r: 29 }, el);
      svg('circle', { class: 'ring', cx: p.x, cy: p.y, r: 14 }, el);
      svg('circle', { class: 'dot', cx: p.x, cy: p.y, r: 5.5 }, el);
      el.addEventListener('click', () => onPeg(p));
      el.addEventListener('keydown', ev => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onPeg(p); }
      });
      el.addEventListener('pointerenter', () => showPreview(p));
      el.addEventListener('pointerleave', hidePreview);
      el.addEventListener('focus', () => showPreview(p));
      el.addEventListener('blur', hidePreview);
      p.el = el;
    }
  }

  /* ---------- rules ---------- */

  // Every dot reachable from p with one legal line, mapped to the segments that line covers.
  function reachable(p) {
    const out = new Map();
    for (const [dq, dr] of DIRS) {
      const path = [];
      let prev = p;
      for (let step = 1; step <= MAX_SPAN; step++) {
        const next = g.points.get(key(p.q + dq * step, p.r + dr * step));
        if (!next) break;
        const e = g.edges.get(edgeKey(prev, next));
        if (e.move >= 0) break;
        path.push(e);
        out.set(next.k, path.slice());
        prev = next;
      }
    }
    return out;
  }

  const isOver = () => g.covered === g.edges.size;

  // Applies a move to the game state. Returns false if the move is illegal.
  function play(aKey, bKey) {
    if (isOver()) return false;
    const a = g.points.get(aKey);
    const path = a && reachable(a).get(bKey);
    if (!path) return false;

    const moveIndex = g.moves.length;
    const player = g.current;
    for (const e of path) e.move = moveIndex;
    g.covered += path.length;

    let claimed = 0;
    for (const t of g.tris) {
      if (t.owner < 0 && t.edges.every(e => e.move >= 0)) {
        t.owner = player;
        claimed++;
      }
    }
    g.scores[player] += claimed;
    g.moves.push([aKey, bKey]);
    g.lastEvent = { player, claimed };

    // Turn order: play always passes to the next player, triangle or not.
    if (!isOver()) g.current = (player + 1) % g.numPlayers;
    return true;
  }

  function undo() {
    if (net.mode !== 'local' || !g.moves.length) return;
    loadState(g.numPlayers, g.radius, g.moves.slice(0, -1));
  }

  /* ---------- interaction ---------- */

  function clearSelection() {
    g.selected = null;
    g.targets = new Map();
  }

  function select(p) {
    const targets = reachable(p);
    if (!targets.size) return false;
    g.selected = p;
    g.targets = targets;
    return true;
  }

  // On one device anyone may move; online, only the device whose colour is up.
  function canAct() {
    if (net.mode === 'local') return true;
    if (!net.started || net.pending || net.seat !== g.current) return false;
    return net.mode === 'host' || net.linked;
  }

  function onPeg(p) {
    if (isOver() || !canAct()) return;
    if (g.selected && g.targets.has(p.k)) {
      const a = g.selected.k;
      clearSelection();
      if (net.mode === 'client') {
        // The host owns the game: send the move and wait for its answer.
        net.pending = true;
        net.conn.send({ t: 'move', a, b: p.k });
      } else {
        play(a, p.k);
        if (net.mode === 'host') broadcast();
      }
    } else if (g.selected === p) {
      clearSelection();
    } else if (!select(p)) {
      clearSelection();
    }
    render();
  }

  function showPreview(p) {
    if (!g.selected || !g.targets.has(p.k)) return;
    const a = g.selected;
    g.previewEl.setAttribute('x1', a.x);
    g.previewEl.setAttribute('y1', a.y);
    g.previewEl.setAttribute('x2', p.x);
    g.previewEl.setAttribute('y2', p.y);
    g.previewEl.setAttribute('visibility', 'visible');
  }

  function hidePreview() {
    g.previewEl.setAttribute('visibility', 'hidden');
  }

  /* ---------- rendering ---------- */

  function seatOnline(i) {
    if (net.mode === 'host') return i === 0 || !!(net.seats[i] && net.seats[i].conn);
    if (net.mode === 'client') return net.connected[i] !== false;
    return true;
  }

  function statusText() {
    const online = net.mode !== 'local';
    const name = PLAYERS[g.current].name;

    if (net.mode === 'client' && !net.linked) {
      return net.everLinked ? 'Connection lost. Reconnecting…' : `Connecting to room ${net.code}…`;
    }
    if (online && !net.started) {
      if (net.mode === 'host') {
        return net.seats.length < 2
          ? `Room ${net.code} is open. Share the code so friends can join`
          : `${net.seats.length} players are in. Press Start game when everyone has joined`;
      }
      const me = PLAYERS[net.seat];
      return `You joined${me ? ' as ' + me.name : ''}. Waiting for the host to start`;
    }

    if (isOver()) {
      const best = Math.max(...g.scores);
      const winners = g.scores.map((s, i) => (s === best ? PLAYERS[i].name : null)).filter(Boolean);
      return winners.length === 1
        ? `Game over. ${winners[0]} wins with ${best} triangles!`
        : `Game over. It's a tie between ${winners.join(' and ')} with ${best} each.`;
    }

    if (online && !seatOnline(g.current)) return `Waiting for ${name} to reconnect`;
    const mine = online && net.seat === g.current;
    if (g.selected) return `${mine ? 'You' : name}: pick a highlighted dot to finish the line`;
    const turn = mine ? `Your turn (${name})` : `${name}'s turn`;
    const ev = g.lastEvent;
    if (ev && ev.claimed > 0) {
      return `${PLAYERS[ev.player].name} closed ${ev.claimed} triangle${ev.claimed > 1 ? 's' : ''}. ${turn}`;
    }
    return turn;
  }

  function renderOnline() {
    const online = net.mode !== 'local';
    const host = net.mode === 'host';
    $('onlineIdle').hidden = online;
    $('onlineActive').hidden = !online;
    $('roomCode').textContent = net.code;
    const me = PLAYERS[net.seat];
    $('onlineInfo').textContent = host
      ? `${net.seats.length} of 4 players in the room`
      : (me ? `You are ${me.name}` : '');
    $('startOnline').hidden = !host;
    $('startOnline').disabled = !host || net.seats.length < 2;
    $('startOnline').textContent = net.started ? 'Restart game' : 'Start game';
    $('shareRoom').hidden = !host;
    $('playerCount').disabled = online;   // online, the player count is whoever joined
    $('boardSize').disabled = net.mode === 'client';
    $('newGame').disabled = online;
    undoBtn.disabled = online || g.moves.length === 0;
  }

  function render() {
    const over = isOver();
    const online = net.mode !== 'local';
    const turnColor = PLAYERS[g.current].color;
    document.documentElement.style.setProperty('--turn', over ? 'var(--ink)' : turnColor);
    boardEl.classList.toggle('over', over);
    boardEl.classList.toggle('locked', !over && !canAct());

    scoresEl.textContent = '';
    const best = Math.max(...g.scores);
    for (let i = 0; i < g.numPlayers; i++) {
      const chip = document.createElement('div');
      const lit = over ? g.scores[i] === best : i === g.current;
      const offline = online && net.started && !seatOnline(i);
      chip.className = 'chip' + (lit ? ' active' : '') + (offline ? ' offline' : '');
      chip.style.setProperty('--c', PLAYERS[i].color);
      const you = online && net.started && i === net.seat ? ' <span class="you">you</span>' : '';
      chip.innerHTML = `<span class="badge">${i + 1}</span><span class="name">${PLAYERS[i].name}${you}</span><span class="score">${g.scores[i]}</span>`;
      scoresEl.appendChild(chip);
    }

    const lastMove = g.moves.length - 1;
    const lastColor = g.lastEvent ? PLAYERS[g.lastEvent.player].color : '';
    for (const e of g.edges.values()) {
      e.el.classList.toggle('covered', e.move >= 0);
      const isLast = e.move >= 0 && e.move === lastMove;
      e.el.classList.toggle('last', isLast);
      e.el.style.setProperty('--last', isLast ? lastColor : '');
    }

    let unclaimed = 0;
    for (const t of g.tris) {
      const owned = t.owner >= 0;
      if (!owned) unclaimed++;
      t.el.classList.toggle('claimed', owned);
      t.el.style.fill = owned ? PLAYERS[t.owner].color : '';
      t.label.textContent = owned ? t.owner + 1 : '';
    }

    for (const p of g.points.values()) {
      p.el.classList.toggle('selected', g.selected === p);
      p.el.classList.toggle('target', g.targets.has(p.k));
      p.el.classList.toggle('dead', !over && reachable(p).size === 0);
    }

    hidePreview();
    statusEl.textContent = statusText();
    remainingEl.textContent = `${unclaimed} of ${g.tris.length} triangles left`;
    renderOnline();
  }

  /* ---------- online play ---------- */
  // The host's device owns the game. Other devices send their moves to it, and it
  // answers everyone with the full move list, so all screens always agree.

  const ROOM_PREFIX = 'three-sides-room-';
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I/L)

  function rand(n) {
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    return Array.from(bytes, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
  }

  // Stable per-tab id so a player who drops and reconnects gets their colour back.
  let fallbackId = '';
  function clientId() {
    try {
      let id = sessionStorage.getItem('three-sides-id');
      if (!id) { id = rand(12); sessionStorage.setItem('three-sides-id', id); }
      return id;
    } catch (err) {
      return fallbackId || (fallbackId = rand(12));
    }
  }

  function setNote(text) {
    $('onlineNote').textContent = text;
  }

  function peerAvailable() {
    if (window.Peer) return true;
    setNote('Online play could not load. Check your internet connection and reload.');
    return false;
  }

  function leaveRoom() {
    clearTimeout(net.timer);
    const peer = net.peer;
    Object.assign(net, {
      mode: 'local', peer: null, code: '', seat: 0, started: false, seats: [],
      conn: null, linked: false, everLinked: false, pending: false,
      joined: 1, connected: [], tries: 0, timer: null,
    });
    if (peer) peer.destroy();
    clearSelection();
    render();
  }

  /* host side */

  function createRoom() {
    if (!peerAvailable()) return;
    leaveRoom();
    const code = rand(5);
    setNote('Creating room…');
    const peer = new Peer(ROOM_PREFIX + code);
    net.peer = peer;

    peer.on('open', () => {
      if (net.peer !== peer || net.mode === 'host') return;
      Object.assign(net, { mode: 'host', code, seat: 0, started: false, seats: [{ id: 'host', conn: null }] });
      setNote('');
      render();
    });
    peer.on('connection', conn => {
      conn.on('data', msg => hostReceive(conn, msg));
      conn.on('close', () => hostDrop(conn));
      conn.on('error', () => hostDrop(conn));
    });
    peer.on('disconnected', () => {
      if (net.peer === peer && !peer.destroyed) peer.reconnect();
    });
    peer.on('error', err => {
      if (net.peer !== peer || net.mode === 'host') return; // once hosting, reconnect handles it
      if (err.type === 'unavailable-id') { createRoom(); return; }
      leaveRoom();
      setNote('Could not create a room. Check your internet connection.');
    });
  }

  function hostReceive(conn, msg) {
    if (net.mode !== 'host' || !msg || typeof msg !== 'object') return;

    if (msg.t === 'hello') {
      const id = String(msg.id || '').slice(0, 40);
      let i = net.seats.findIndex((s, k) => k > 0 && s.id === id);      // returning player
      if (i < 0 && !net.started && net.seats.length < PLAYERS.length) { // new player in the lobby
        net.seats.push({ id, conn: null });
        i = net.seats.length - 1;
      }
      if (i < 0 && net.started) {                                       // take over an empty seat
        i = net.seats.findIndex((s, k) => k > 0 && !s.conn);
        if (i > 0) net.seats[i].id = id;
      }
      if (i < 0) {
        conn.send({ t: 'full' });
        setTimeout(() => conn.close(), 500);
        return;
      }
      const old = net.seats[i].conn;
      net.seats[i].conn = conn;
      if (old && old !== conn) old.close();
      broadcast();
      render();
    } else if (msg.t === 'move') {
      const i = net.seats.findIndex(s => s.conn === conn);
      // Only the player whose turn it is may move; play() rejects illegal lines.
      if (net.started && i === g.current) play(String(msg.a), String(msg.b));
      broadcast();
      render();
    }
  }

  function hostDrop(conn) {
    if (net.mode !== 'host') return;
    const i = net.seats.findIndex(s => s.conn === conn);
    if (i < 0) return;
    if (net.started) net.seats[i].conn = null; // keep the seat so they can come back
    else net.seats.splice(i, 1);
    broadcast();
    render();
  }

  function broadcast() {
    if (net.mode !== 'host') return;
    const connected = net.seats.map((s, i) => i === 0 || !!s.conn);
    net.seats.forEach((s, i) => {
      if (!s.conn || !s.conn.open) return;
      s.conn.send({
        t: 'sync', seat: i, started: net.started, joined: net.seats.length, connected,
        numPlayers: g.numPlayers, radius: g.radius, moves: g.moves,
      });
    });
  }

  function startOnline() {
    if (net.mode !== 'host' || net.seats.length < 2) return;
    net.started = true;
    newGame(net.seats.length, Number($('boardSize').value));
    broadcast();
  }

  /* client side */

  function joinRoom(raw) {
    const code = String(raw || '').trim().toUpperCase();
    if (!code) { setNote('Enter the room code first.'); return; }
    if (!peerAvailable()) return;
    leaveRoom();
    Object.assign(net, { mode: 'client', code, seat: -1 });
    setNote('');
    clientConnect();
    render();
  }

  function clientConnect() {
    if (net.mode !== 'client') return;
    clearTimeout(net.timer);
    if (net.peer) { const old = net.peer; net.peer = null; old.destroy(); }
    const peer = new Peer();
    net.peer = peer;
    const fail = why => { if (net.peer === peer) clientLost(why); };

    peer.on('open', () => {
      const conn = peer.connect(ROOM_PREFIX + net.code, { reliable: true, serialization: 'json' });
      net.conn = conn;
      conn.on('open', () => {
        clearTimeout(net.timer);
        Object.assign(net, { linked: true, everLinked: true, tries: 0, pending: false });
        conn.send({ t: 'hello', id: clientId() });
        setNote('');
        render();
      });
      conn.on('data', msg => { if (net.peer === peer) clientReceive(msg); });
      conn.on('close', () => fail());
      conn.on('error', () => fail());
    });
    peer.on('error', err => fail(err.type));
    net.timer = setTimeout(() => fail('timeout'), 15000);
  }

  function clientLost(why) {
    clearTimeout(net.timer);
    net.linked = false;
    net.pending = false;
    if (net.peer) { const old = net.peer; net.peer = null; old.destroy(); }

    if (!net.everLinked) {
      const code = net.code;
      leaveRoom();
      setNote(why === 'peer-unavailable'
        ? `Room ${code} was not found. Check the code with the host.`
        : 'Could not connect to the room. Try again, or switch to Wi-Fi.');
      return;
    }
    if (++net.tries > 20) {
      leaveRoom();
      setNote('The connection to the room was lost.');
      return;
    }
    net.timer = setTimeout(clientConnect, 2000);
    render();
  }

  function clientReceive(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'full') {
      leaveRoom();
      setNote('That room is full.');
    } else if (msg.t === 'sync') {
      Object.assign(net, {
        seat: msg.seat, started: !!msg.started, joined: msg.joined,
        connected: msg.connected || [], pending: false,
      });
      if (net.started) loadState(msg.numPlayers, msg.radius, msg.moves || []);
      else render();
    }
  }

  async function shareInvite() {
    const url = location.origin + location.pathname + '?room=' + net.code;
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Three Sides', text: `Join my Three Sides game. Room code: ${net.code}`, url });
      } else {
        await navigator.clipboard.writeText(url);
        setNote('Invite link copied.');
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      setNote('Invite link: ' + url);
    }
  }

  /* ---------- controls ---------- */

  function start() {
    if (net.mode !== 'local') return;
    newGame(Number($('playerCount').value), Number($('boardSize').value));
  }

  $('newGame').addEventListener('click', start);
  undoBtn.addEventListener('click', undo);
  $('createRoom').addEventListener('click', createRoom);
  $('joinRoom').addEventListener('click', () => joinRoom($('roomInput').value));
  $('roomInput').addEventListener('keydown', ev => {
    if (ev.key === 'Enter') joinRoom($('roomInput').value);
  });
  $('startOnline').addEventListener('click', startOnline);
  $('shareRoom').addEventListener('click', shareInvite);
  $('leaveRoom').addEventListener('click', () => { leaveRoom(); setNote(''); });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && g.selected) { clearSelection(); render(); }
  });
  // Phones drop the connection while the page is in the background: retry on return.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && net.mode === 'client' && net.everLinked && !net.linked) {
      net.tries = 0;
      clientConnect();
    }
  });

  start();

  // An invite link (?room=CODE) joins that room straight away.
  const invited = new URLSearchParams(location.search).get('room');
  if (invited) {
    $('roomInput').value = invited.toUpperCase().slice(0, 5);
    joinRoom(invited);
  }
})();
