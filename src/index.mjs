const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

function json(status, data) {
  return new Response(JSON.stringify(data), { status: status, headers: JSON_HEADERS });
}

function randomInt(max) {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] % max;
}

function randomCode() {
  return String(100000 + randomInt(900000));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
        }
      });
    }

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== 'GET' && request.method !== 'POST') {
      return json(405, { error: 'ไม่รองรับคำขอนี้' });
    }

    let data = {};
    let bodyText = '';
    if (request.method === 'POST') {
      try {
        bodyText = await request.text();
        if (bodyText.length > 2_000_000) {
          return json(413, { error: 'ข้อมูลมีขนาดใหญ่เกินไป' });
        }
        data = JSON.parse(bodyText || '{}');
      } catch {
        return json(400, { error: 'ข้อมูลไม่ถูกต้อง' });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/create') {
      for (let attempt = 0; attempt < 25; attempt++) {
        const code = randomCode();
        const id = env.ROOMS.idFromName(code);
        const stub = env.ROOMS.get(id);
        const response = await stub.fetch('https://room.internal/api/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...data, code })
        });
        if (response.status !== 409) return response;
      }
      return json(503, { error: 'สร้างรหัสห้องไม่สำเร็จ ลองใหม่อีกครั้ง' });
    }

    let code = '';
    if (request.method === 'GET' && url.pathname === '/api/state') {
      code = String(url.searchParams.get('room') || '').trim();
    } else if (request.method === 'POST') {
      code = String(data.code || '').trim();
    }

    if (!/^\d{6}$/.test(code)) {
      return json(400, { error: 'รหัสห้องไม่ถูกต้อง' });
    }

    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    const init = {
      method: request.method,
      headers: request.headers
    };
    if (request.method === 'POST') init.body = bodyText;
    const internalUrl = new URL(request.url);
    internalUrl.hostname = 'room.internal';
    internalUrl.protocol = 'https:';
    return stub.fetch(new Request(internalUrl.toString(), init));
  }
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS room_state (id INTEGER PRIMARY KEY CHECK (id = 1), data_json TEXT NOT NULL)'
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS players (pid TEXT PRIMARY KEY, data_json TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '', secret_json TEXT)"
    );
  }

  getRoom() {
    const row = this.sql.exec('SELECT data_json FROM room_state WHERE id = 1').toArray()[0];
    return row ? JSON.parse(row.data_json) : null;
  }

  saveRoom(room) {
    this.sql.exec(
      'INSERT INTO room_state (id, data_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data_json = excluded.data_json',
      JSON.stringify(room)
    );
  }

  getPlayer(pid) {
    const row = this.sql.exec(
      'SELECT data_json, avatar, secret_json FROM players WHERE pid = ?',
      pid
    ).toArray()[0];
    if (!row) return null;
    const player = JSON.parse(row.data_json);
    player.avatar = row.avatar || '';
    player.secret = row.secret_json ? JSON.parse(row.secret_json) : null;
    return player;
  }

  savePlayer(player) {
    const meta = { ...player };
    delete meta.avatar;
    delete meta.secret;
    this.sql.exec(
      'INSERT INTO players (pid, data_json, avatar, secret_json) VALUES (?, ?, ?, ?) ON CONFLICT(pid) DO UPDATE SET data_json = excluded.data_json, avatar = excluded.avatar, secret_json = excluded.secret_json',
      player.id,
      JSON.stringify(meta),
      player.avatar || '',
      player.secret ? JSON.stringify(player.secret) : null
    );
  }

  getPlayers(room) {
    return room.playerIds.map((pid) => this.getPlayer(pid)).filter(Boolean);
  }

  getRanking(room) {
    return this.getPlayers(room)
      .filter((player) => player.status)
      .sort((a, b) => a.rank - b.rank)
      .map((player) => ({ name: player.name, status: player.status, rank: player.rank }));
  }

  publicRoom(room, pid) {
    const players = this.getPlayers(room);
    const meIndex = room.playerIds.indexOf(pid);
    const guessVotes = (room.lastGuess && room.lastGuess.votes) || {};
    const voteValues = Object.values(guessVotes);
    const lastGuess = room.lastGuess ? {
      id: room.lastGuess.id,
      by: room.lastGuess.by,
      guess: room.lastGuess.guess,
      isGuesser: room.lastGuess.pid === pid,
      myVote: guessVotes[pid] || null,
      votesCorrect: voteValues.filter((value) => value === 'correct').length,
      votesWrong: voteValues.filter((value) => value === 'wrong').length,
      votesCast: voteValues.length,
      votesNeeded: Math.max(0, players.length - 1),
      verdict: room.lastGuess.verdict || null
    } : null;

    return {
      code: room.code,
      maxPlayers: room.maxPlayers,
      phase: room.phase,
      players: players.map((player, index) => ({
        id: player.id === pid ? player.id : undefined,
        name: player.name,
        avatar: player.avatar || '',
        isHost: player.id === room.hostId,
        secret: (player.id !== pid || !!player.status) && player.secret
          ? { text: player.secret.text, image: player.secret.image }
          : null,
        status: player.status,
        rank: player.rank,
        hasSecret: !!player.secret,
        assigned: !!player.assigned,
        ready: !!player.ready,
        canGiveHint: room.phase === 'play' && index !== room.turn && players.length > 1
          && (players.length >= 3 || index === (room.turn - 1 + players.length) % players.length)
      })),
      turn: room.turn,
      countdown: room.countdown,
      answering: players[room.turn] ? players[room.turn].id === pid : false,
      canRespond: room.phase === 'play' && meIndex !== room.turn && players.length > 1
        && (players.length >= 3 || meIndex === (room.turn - 1 + players.length) % players.length),
      lastReply: room.lastReply || null,
      lastGuess: lastGuess,
      ranking: room.lastResults || this.getRanking(room),
      lastResults: room.lastResults || null
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/state') {
      const room = this.getRoom();
      const pid = String(url.searchParams.get('pid') || '');
      if (!room || !room.playerIds.includes(pid) || !this.getPlayer(pid)) {
        return json(404, { error: 'ไม่พบห้องหรือผู้เล่น' });
      }
      return json(200, this.publicRoom(room, pid));
    }

    if (request.method !== 'POST' || !url.pathname.startsWith('/api/')) {
      return json(404, { error: 'ไม่พบ API' });
    }

    let data;
    try {
      const raw = await request.text();
      if (raw.length > 2_000_000) return json(413, { error: 'ข้อมูลมีขนาดใหญ่เกินไป' });
      data = JSON.parse(raw || '{}');
    } catch {
      return json(400, { error: 'ข้อมูลไม่ถูกต้อง' });
    }

    if (url.pathname === '/api/create') {
      const existing = this.getRoom();
      if (existing) return json(409, { error: 'รหัสห้องซ้ำ' });
      const maxPlayers = Math.max(data.testSolo ? 1 : 2, Math.min(20, Number(data.maxPlayers) || 2));
      const code = String(data.code || '');
      if (!/^\d{6}$/.test(code)) return json(400, { error: 'รหัสห้องไม่ถูกต้อง' });
      const pid = crypto.randomUUID();
      const player = {
        id: pid,
        name: String(data.name || 'ผู้เล่น 1').slice(0, 20),
        avatar: '',
        secret: null,
        assigned: false,
        status: null,
        rank: null,
        ready: false
      };
      const room = {
        code: code,
        maxPlayers: maxPlayers,
        phase: 'lobby',
        hostId: pid,
        playerIds: [pid],
        turn: 0,
        countdown: null,
        lastResults: null,
        lastReply: null,
        lastGuess: null
      };
      this.savePlayer(player);
      this.saveRoom(room);
      return json(200, { pid: pid, room: this.publicRoom(room, pid) });
    }

    const room = this.getRoom();
    if (!room) return json(404, { error: 'ไม่พบห้องนี้' });

    if (url.pathname === '/api/join') {
      if (room.code !== String(data.code || '').trim()) return json(404, { error: 'ไม่พบห้องนี้' });
      if (room.phase !== 'lobby' || room.playerIds.length >= room.maxPlayers) {
        return json(409, { error: 'ห้องเต็มหรือเริ่มเกมแล้ว' });
      }
      const pid = crypto.randomUUID();
      const player = {
        id: pid,
        name: String(data.name || ('ผู้เล่น ' + (room.playerIds.length + 1))).slice(0, 20),
        avatar: '',
        secret: null,
        assigned: false,
        status: null,
        rank: null,
        ready: false
      };
      room.playerIds.push(pid);
      this.savePlayer(player);
      this.saveRoom(room);
      return json(200, { pid: pid, room: this.publicRoom(room, pid) });
    }

    const code = String(data.code || '').trim();
    const pid = String(data.pid || '');
    const player = this.getPlayer(pid);
    if (room.code !== code || !room.playerIds.includes(pid) || !player) {
      return json(404, { error: 'ไม่พบห้องหรือผู้เล่น' });
    }

    if (url.pathname === '/api/profile') {
      if (room.phase !== 'lobby') {
        return json(409, { error: 'แก้ไขโปรไฟล์ได้เฉพาะตอนอยู่ในล็อบบี้ก่อนเริ่มเกม' });
      }
      const name = String(data.name || '').trim().slice(0, 20);
      if (!name) return json(400, { error: 'ใส่ชื่อผู้เล่นก่อน' });
      let avatar = player.avatar || '';
      if (data.avatar !== undefined) {
        avatar = String(data.avatar || '');
        if (avatar && (avatar.length > 100000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(avatar))) {
          return json(400, { error: 'รูปโปรไฟล์ไม่ถูกต้องหรือมีขนาดใหญ่เกินไป' });
        }
      }
      player.name = name;
      player.avatar = avatar;
      this.savePlayer(player);
      return json(200, { room: this.publicRoom(room, pid) });
    }

    if (url.pathname === '/api/ready') {
      if (room.phase !== 'lobby' && room.phase !== 'countdown') {
        return json(409, { error: 'ตอนนี้ยังเปลี่ยนสถานะพร้อมไม่ได้' });
      }
      player.ready = !player.ready;
      this.savePlayer(player);
      let cancelAlarm = false;
      let startAlarm = false;
      if (room.phase === 'countdown' &&
        (room.playerIds.length !== room.maxPlayers || !this.getPlayers(room).every((item) => item.ready))) {
        room.phase = 'lobby';
        room.countdown = null;
        cancelAlarm = true;
      } else if (room.phase === 'lobby' &&
        room.playerIds.length === room.maxPlayers && this.getPlayers(room).every((item) => item.ready)) {
        room.phase = 'countdown';
        room.countdown = 3;
        startAlarm = true;
      }
      this.saveRoom(room);
      if (cancelAlarm) await this.ctx.storage.deleteAlarm();
      if (startAlarm) await this.ctx.storage.setAlarm(Date.now() + 1000);
      return json(200, { room: this.publicRoom(room, pid) });
    }

    if (url.pathname === '/api/secret') {
      if (room.phase !== 'setup') return json(409, { error: 'ตอนนี้ตั้งคำไม่ได้' });
      if (player.assigned) return json(409, { error: 'ส่งคำไปแล้ว' });
      const text = String(data.text || '').trim().slice(0, 100);
      const image = String(data.image || '').slice(0, 1500000);
      if (!text && !image) return json(400, { error: 'ใส่คำหรือรูปก่อน' });
      const targetId = room.playerIds[(room.playerIds.indexOf(player.id) + 1) % room.playerIds.length];
      const secret = { text: text, image: image, setterId: player.id };
      if (targetId === player.id) {
        player.secret = secret;
        player.assigned = true;
        this.savePlayer(player);
      } else {
        const target = this.getPlayer(targetId);
        target.secret = secret;
        this.savePlayer(target);
        player.assigned = true;
        this.savePlayer(player);
      }
      if (this.getPlayers(room).every((item) => item.assigned)) {
        room.phase = 'play';
        room.turn = randomInt(room.playerIds.length);
        room.lastReply = null;
        room.lastGuess = null;
      }
      this.saveRoom(room);
      return json(200, { room: this.publicRoom(room, pid) });
    }

    if (url.pathname === '/api/action') {
      if (room.phase !== 'play') return json(409, { error: 'เกมยังไม่เริ่ม' });

      if (['yes', 'no', 'maybe'].includes(data.action)) {
        const asker = this.getPlayer(room.playerIds[room.turn]);
        const clueGiverIndex = (room.turn - 1 + room.playerIds.length) % room.playerIds.length;
        const clueGiver = this.getPlayer(room.playerIds[clueGiverIndex]);
        const allowed = room.playerIds.length >= 3
          ? !!asker && asker.id !== player.id
          : room.playerIds.length === 2 && !!clueGiver && clueGiver.id === player.id;
        if (!allowed) return json(409, { error: 'คนถามไม่มีสิทธิ์ตอบคำถามนี้' });
        room.lastReply = { by: player.name, value: data.action };
        this.saveRoom(room);
        return json(200, { room: this.publicRoom(room, pid) });
      }

      if (data.action === 'verdict') {
        if (!room.lastGuess || room.lastGuess.verdict) {
          return json(409, { error: 'ไม่มีคำตอบที่รอการตัดสิน' });
        }
        if (room.lastGuess.pid === player.id) {
          return json(409, { error: 'คนทายห้ามตัดสินคำตอบของตัวเอง' });
        }
        if (!['correct', 'wrong'].includes(data.verdict)) {
          return json(400, { error: 'เลือกถูกหรือผิดก่อน' });
        }
        if (!room.lastGuess.votes) room.lastGuess.votes = {};
        if (Object.prototype.hasOwnProperty.call(room.lastGuess.votes, player.id)) {
          return json(409, { error: 'คุณโหวตคำตอบนี้ไปแล้ว' });
        }
        room.lastGuess.votes[player.id] = data.verdict;
        const votes = Object.values(room.lastGuess.votes);
        const votesNeeded = Math.max(0, room.playerIds.length - 1);
        if (votesNeeded > 0 && votes.length >= votesNeeded) {
          const correctVotes = votes.filter((value) => value === 'correct').length;
          const wrongVotes = votes.filter((value) => value === 'wrong').length;
          const finalVerdict = correctVotes > wrongVotes ? 'correct' : 'wrong';
          room.lastGuess.verdict = finalVerdict;
          const guesser = this.getPlayer(room.lastGuess.pid);
          if (guesser) {
            const finishedBefore = this.getPlayers(room).filter((item) => item.status).length;
            guesser.status = finalVerdict === 'correct' ? 'winner' : 'loser';
            guesser.rank = finishedBefore + 1;
            this.savePlayer(guesser);
          }
          this.nextTurn(room);
        }
        this.saveRoom(room);
        return json(200, { room: this.publicRoom(room, pid) });
      }

      if (room.playerIds[room.turn] !== player.id) {
        return json(409, { error: 'ยังไม่ใช่ตาของคุณ' });
      }

      if (data.action === 'answer') {
        if (room.lastGuess && !room.lastGuess.verdict) {
          return json(409, { error: 'รอผู้เล่นตัดสินคำตอบก่อน' });
        }
        const guess = String(data.guess || '').trim().slice(0, 100);
        if (!guess) return json(400, { error: 'พิมพ์คำตอบก่อน' });
        room.lastGuess = {
          id: crypto.randomUUID(),
          pid: player.id,
          by: player.name,
          guess: guess,
          verdict: null
        };
        room.lastReply = null;
      } else if (data.action === 'pass') {
        if (room.lastGuess && !room.lastGuess.verdict) {
          return json(409, { error: 'รอผู้เล่นตัดสินคำตอบก่อน' });
        }
        this.nextTurn(room);
      } else {
        return json(400, { error: 'ไม่รู้จักคำสั่งนี้' });
      }
      this.saveRoom(room);
      return json(200, { room: this.publicRoom(room, pid) });
    }

    return json(404, { error: 'ไม่พบ API' });
  }

  nextTurn(room) {
    room.lastReply = null;
    const count = room.playerIds.length;
    const players = this.getPlayers(room);
    for (let step = 1; step <= count; step++) {
      const index = (room.turn + step) % count;
      if (!players[index].status) {
        room.turn = index;
        return;
      }
    }
    room.lastResults = this.getRanking(room);
    room.phase = 'lobby';
    room.countdown = null;
    for (const player of players) {
      player.ready = false;
      this.savePlayer(player);
    }
  }

  async alarm() {
    const room = this.getRoom();
    if (!room || room.phase !== 'countdown') return;
    const players = this.getPlayers(room);
    if (room.playerIds.length !== room.maxPlayers || !players.every((player) => player.ready)) {
      room.phase = 'lobby';
      room.countdown = null;
      this.saveRoom(room);
      return;
    }
    if (room.countdown <= 1) {
      for (const player of players) {
        player.secret = null;
        player.assigned = false;
        player.status = null;
        player.rank = null;
        this.savePlayer(player);
      }
      room.lastResults = null;
      room.lastReply = null;
      room.lastGuess = null;
      room.phase = 'setup';
      room.countdown = null;
      room.turn = 0;
      this.saveRoom(room);
      return;
    }
    room.countdown -= 1;
    this.saveRoom(room);
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
}