const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, 'public');
const rooms = new Map();
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.gif':'image/gif'};

const send = (res, status, data) => {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
};
const getRanking = room => [...room.players]
  .filter(player => player.status)
  .sort((a,b) => a.rank-b.rank)
  .map(player => ({name:player.name,status:player.status,rank:player.rank}));

function publicRoom(room, pid) {
  const meIndex = room.players.findIndex(player => player.id === pid);
  const guessVotes = room.lastGuess?.votes || {};
  const guessVoteValues = Object.values(guessVotes);
  const lastGuess = room.lastGuess ? {
    id: room.lastGuess.id,
    by: room.lastGuess.by,
    guess: room.lastGuess.guess,
    isGuesser: room.lastGuess.pid === pid,
    myVote: guessVotes[pid] || null,
    votesCorrect: guessVoteValues.filter(value => value === 'correct').length,
    votesWrong: guessVoteValues.filter(value => value === 'wrong').length,
    votesCast: guessVoteValues.length,
    votesNeeded: Math.max(0, room.players.length - 1),
    verdict: room.lastGuess.verdict || null
  } : null;
  return {
    code: room.code,
    maxPlayers: room.maxPlayers,
    phase: room.phase,
    players: room.players.map((player,index) => ({
      id: player.id === pid ? player.id : undefined,
      name: player.name,
      avatar: player.avatar || '',
      isHost: player.id === room.hostId,
      secret: (player.id !== pid || !!player.status) && player.secret
        ? {text:player.secret.text,image:player.secret.image}
        : null,
      status: player.status,
      rank: player.rank,
      hasSecret: !!player.secret,
      assigned: !!player.assigned,
      ready: !!player.ready,
      canGiveHint: room.phase === 'play' && index !== room.turn && room.players.length > 1
        && (room.players.length >= 3 || index === (room.turn - 1 + room.players.length) % room.players.length)
    })),
    turn: room.turn,
    countdown: room.countdown,
    answering: room.players[room.turn]?.id === pid,
    canRespond: room.phase === 'play' && meIndex !== room.turn && room.players.length > 1
      && (room.players.length >= 3 || meIndex === (room.turn - 1 + room.players.length) % room.players.length),
    lastReply: room.lastReply || null,
    lastGuess,
    ranking: room.lastResults || getRanking(room),
    lastResults: room.lastResults || null
  };
}

function body(req) {
  return new Promise((resolve,reject) => {
    let raw = '';
    req.on('data',chunk => {
      raw += chunk;
      if (raw.length > 2e6) reject(new Error('Payload too large'));
    });
    req.on('end',() => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch (error) { reject(error); }
    });
  });
}

function beginCountdown(room) {
  room.phase = 'countdown';
  room.countdown = 3;
  const tick = () => {
    if (!rooms.has(room.code) || room.phase !== 'countdown') return;
    if (room.players.length !== room.maxPlayers || !room.players.every(player => player.ready)) {
      room.phase = 'lobby';
      room.countdown = null;
      return;
    }
    if (room.countdown <= 1) {
      for (const player of room.players) {
        player.secret = null;
        player.assigned = false;
        player.status = null;
        player.rank = null;
      }
      room.lastResults = null;
      room.lastReply = null;
      room.lastGuess = null;
      room.phase = 'setup';
      room.countdown = null;
      room.turn = 0;
      return;
    }
    room.countdown--;
    setTimeout(tick,1000);
  };
  setTimeout(tick,1000);
}

function nextTurn(room) {
  room.lastReply = null;
  const count = room.players.length;
  for (let step = 1; step <= count; step++) {
    const index = (room.turn + step) % count;
    if (!room.players[index].status) {
      room.turn = index;
      return;
    }
  }
  room.lastResults = getRanking(room);
  room.phase = 'lobby';
  room.countdown = null;
  for (const player of room.players) player.ready = false;
}

const server = http.createServer(async (req,res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'});
    return res.end();
  }
  const url = new URL(req.url,'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const room = rooms.get(url.searchParams.get('room'));
    const player = room?.players.find(item => item.id === url.searchParams.get('pid'));
    return room && player ? send(res,200,publicRoom(room,player.id)) : send(res,404,{error:'ไม่พบห้องหรือผู้เล่น'});
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    let data;
    try { data = await body(req); }
    catch { return send(res,400,{error:'ข้อมูลไม่ถูกต้อง'}); }

    if (url.pathname === '/api/create') {
      const maxPlayers = Math.max(data.testSolo ? 1 : 2,Math.min(20,Number(data.maxPlayers) || 2));
      const code = String(crypto.randomInt(100000,999999));
      const pid = crypto.randomUUID();
      const room = {
        code,maxPlayers,phase:'lobby',hostId:pid,
        players:[{id:pid,name:String(data.name || 'ผู้เล่น 1').slice(0,20),avatar:'',secret:null,assigned:false,status:null,rank:null,ready:false}],
        turn:0,countdown:null,lastResults:null,lastReply:null,lastGuess:null
      };
      rooms.set(code,room);
      return send(res,200,{pid,room:publicRoom(room,pid)});
    }

    if (url.pathname === '/api/join') {
      const room = rooms.get(String(data.code || '').trim());
      if (!room) return send(res,404,{error:'ไม่พบห้องนี้'});
      if (room.phase !== 'lobby' || room.players.length >= room.maxPlayers) return send(res,409,{error:'ห้องเต็มหรือเริ่มเกมแล้ว'});
      const pid = crypto.randomUUID();
      room.players.push({id:pid,name:String(data.name || ('ผู้เล่น ' + (room.players.length + 1))).slice(0,20),avatar:'',secret:null,assigned:false,status:null,rank:null,ready:false});
      return send(res,200,{pid,room:publicRoom(room,pid)});
    }

    const room = rooms.get(data.code);
    const player = room?.players.find(item => item.id === data.pid);
    if (!room || !player) return send(res,404,{error:'ไม่พบห้องหรือผู้เล่น'});

    if (url.pathname === '/api/profile') {
      if (room.phase !== 'lobby') return send(res,409,{error:'แก้ไขโปรไฟล์ได้เฉพาะตอนอยู่ในล็อบบี้ก่อนเริ่มเกม'});
      const name = String(data.name || '').trim().slice(0,20);
      if (!name) return send(res,400,{error:'ใส่ชื่อผู้เล่นก่อน'});
      if (data.avatar !== undefined) {
        const avatar = String(data.avatar || '');
        if (avatar && (avatar.length > 100000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(avatar))) {
          return send(res,400,{error:'รูปโปรไฟล์ไม่ถูกต้องหรือมีขนาดใหญ่เกินไป'});
        }
        player.avatar = avatar;
      }
      player.name = name;
      return send(res,200,{room:publicRoom(room,player.id)});
    }

    if (url.pathname === '/api/ready') {
      if (!['lobby','countdown'].includes(room.phase)) return send(res,409,{error:'ตอนนี้ยังเปลี่ยนสถานะพร้อมไม่ได้'});
      player.ready = !player.ready;
      if (room.phase === 'countdown' && (room.players.length !== room.maxPlayers || !room.players.every(item => item.ready))) {
        room.phase = 'lobby';
        room.countdown = null;
      } else if (room.phase === 'lobby' && room.players.length === room.maxPlayers && room.players.every(item => item.ready)) {
        beginCountdown(room);
      }
      return send(res,200,{room:publicRoom(room,player.id)});
    }

    if (url.pathname === '/api/secret') {
      if (room.phase !== 'setup') return send(res,409,{error:'ตอนนี้ตั้งคำไม่ได้'});
      if (player.assigned) return send(res,409,{error:'ส่งคำไปแล้ว'});
      const text = String(data.text || '').trim().slice(0,100);
      const image = String(data.image || '').slice(0,1500000);
      if (!text && !image) return send(res,400,{error:'ใส่คำหรือรูปก่อน'});
      const target = room.players[(room.players.indexOf(player) + 1) % room.players.length];
      target.secret = {text,image,setterId:player.id};
      player.assigned = true;
      if (room.players.every(item => item.assigned)) {
        room.phase = 'play';
        room.turn = crypto.randomInt(0,room.players.length);
        room.lastReply = null;
        room.lastGuess = null;
      }
      return send(res,200,{room:publicRoom(room,player.id)});
    }

    if (url.pathname === '/api/action') {
      if (room.phase !== 'play') return send(res,409,{error:'เกมยังไม่เริ่ม'});

      if (['yes','no','maybe'].includes(data.action)) {
        const asker = room.players[room.turn];
        const clueGiverIndex = (room.turn - 1 + room.players.length) % room.players.length;
        const clueGiver = room.players[clueGiverIndex];
        const allowed = room.players.length >= 3
          ? !!asker && asker.id !== player.id
          : room.players.length === 2 && clueGiver?.id === player.id;
        if (!allowed) return send(res,409,{error:'คนถามไม่มีสิทธิ์ตอบคำถามนี้'});
        room.lastReply = {by:player.name,value:data.action};
        return send(res,200,{room:publicRoom(room,player.id)});
      }

      if (data.action === 'verdict') {
        if (!room.lastGuess || room.lastGuess.verdict) return send(res,409,{error:'ไม่มีคำตอบที่รอการตัดสิน'});
        if (room.lastGuess.pid === player.id) return send(res,409,{error:'คนทายห้ามตัดสินคำตอบของตัวเอง'});
        if (!['correct','wrong'].includes(data.verdict)) return send(res,400,{error:'เลือกถูกหรือผิดก่อน'});
        if (!room.lastGuess.votes) room.lastGuess.votes = {};
        if (Object.prototype.hasOwnProperty.call(room.lastGuess.votes,player.id)) {
          return send(res,409,{error:'คุณโหวตคำตอบนี้ไปแล้ว'});
        }
        room.lastGuess.votes[player.id] = data.verdict;
        const votes = Object.values(room.lastGuess.votes);
        const votesNeeded = Math.max(0,room.players.length - 1);
        if (votesNeeded > 0 && votes.length >= votesNeeded) {
          const correctVotes = votes.filter(value => value === 'correct').length;
          const wrongVotes = votes.filter(value => value === 'wrong').length;
          // Require a strict majority for "correct"; ties count as wrong.
          const finalVerdict = correctVotes > wrongVotes ? 'correct' : 'wrong';
          room.lastGuess.verdict = finalVerdict;
          const guesser = room.players.find(item => item.id === room.lastGuess.pid);
          if (guesser) {
            guesser.status = finalVerdict === 'correct' ? 'winner' : 'loser';
            guesser.rank = room.players.filter(item => item.status).length;
          }
          nextTurn(room);
        }
        return send(res,200,{room:publicRoom(room,player.id)});
      }

      if (room.players[room.turn]?.id !== player.id) return send(res,409,{error:'ยังไม่ใช่ตาของคุณ'});

      if (data.action === 'answer') {
        if (room.lastGuess && !room.lastGuess.verdict) return send(res,409,{error:'รอผู้เล่นตัดสินคำตอบก่อน'});
        const guess = String(data.guess || '').trim().slice(0,100);
        if (!guess) return send(res,400,{error:'พิมพ์คำตอบก่อน'});
        room.lastGuess = {id:crypto.randomUUID(),pid:player.id,by:player.name,guess,verdict:null};
        room.lastReply = null;
      } else if (data.action === 'pass') {
        if (room.lastGuess && !room.lastGuess.verdict) return send(res,409,{error:'รอผู้เล่นตัดสินคำตอบก่อน'});
        nextTurn(room);
      } else {
        return send(res,400,{error:'ไม่รู้จักคำสั่งนี้'});
      }
      return send(res,200,{room:publicRoom(room,player.id)});
    }

    return send(res,404,{error:'ไม่พบ API'});
  }

  let requestedPath;
  try { requestedPath = decodeURIComponent(url.pathname); }
  catch { return send(res,400,{error:'Path ไม่ถูกต้อง'}); }
  const file = path.resolve(root,requestedPath === '/' ? 'index.html' : '.' + requestedPath);
  if (file !== root && !file.startsWith(root + path.sep)) return send(res,403,{error:'Forbidden'});
  fs.readFile(file,(error,buffer) => {
    if (error) {
      res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});
      return res.end('Not found');
    }
    res.writeHead(200,{'Content-Type':mime[path.extname(file).toLowerCase()] || 'application/octet-stream','Cache-Control':'no-store'});
    res.end(buffer);
  });
});

server.listen(process.env.PORT || 3000,'0.0.0.0',() => console.log('Who Am I? running on http://localhost:' + (process.env.PORT || 3000)));
