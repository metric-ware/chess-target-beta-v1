/* ==========================================================
   Chess Target — Main Application
   ========================================================== */

// ── State ──
var platform = 'lichess';
var board = null;
var puzzles = [];
var currentPuzzle = 0;
var puzzleActive = false;  // true while waiting for user move
var puzzlePhase = 'info';  // 'info' = showing blunder info, 'play' = interactive puzzle

// ── Stockfish ──
var stockfish = null;
var engineReady = false;
var sfResolve = null;
var sfResult = {};

function initEngine() {
  stockfish = new Worker('chess_engine/stockfish-18-lite-single.js');
  stockfish.onmessage = function (e) {
    var msg = e.data;
    if (msg === 'uciok') return;
    if (msg === 'readyok') {
      engineReady = true;
      if (sfResolve) { sfResolve(); sfResolve = null; }
      return;
    }
    if (typeof msg === 'string' && msg.startsWith('info') && msg.indexOf('score') !== -1) {
      var sm = msg.match(/\bscore (cp|mate) (-?\d+)/);
      if (sm) sfResult.score = { type: sm[1], value: parseInt(sm[2], 10) };
      var pm = msg.match(/ pv (\S+)/);
      if (pm) sfResult.pv = pm[1];
    }
    if (typeof msg === 'string' && msg.startsWith('bestmove')) {
      var bm = msg.split(' ')[1] || null;
      if (bm === '(none)') bm = null;
      sfResult.bestMove = bm;
      if (sfResolve) { sfResolve(sfResult); sfResolve = null; }
    }
  };
  stockfish.postMessage('uci');
  stockfish.postMessage('setoption name Threads value 1');
  stockfish.postMessage('setoption name Hash value 16');
  stockfish.postMessage('isready');
}

function waitReady() {
  if (engineReady) return Promise.resolve();
  return new Promise(function (r) { sfResolve = r; stockfish.postMessage('isready'); });
}

function sfAnalyze(fen, depth) {
  return new Promise(function (resolve) {
    sfResult = {};
    sfResolve = resolve;
    stockfish.postMessage('position fen ' + fen);
    stockfish.postMessage('go depth ' + depth);
  });
}

// ── Screens ──
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('active'); });
  document.getElementById(id).classList.add('active');
}

// ── Platform toggle ──
function setPlatform(p) {
  platform = p;
  document.getElementById('btnLichess').classList.toggle('active', p === 'lichess');
  document.getElementById('btnChesscom').classList.toggle('active', p === 'chesscom');
}

// Slider label
document.getElementById('gameCountSlider').addEventListener('input', function () {
  document.getElementById('gameCountLabel').textContent = this.value;
});

// ── Fetch games ──
function fetchGames(username, count) {
  if (platform === 'lichess') return fetchLichess(username, count);
  return fetchChessCom(username, count);
}

function fetchLichess(username, count) {
  return fetch('https://lichess.org/api/games/user/' + encodeURIComponent(username) + '?max=' + count + '&pgnInBody=true&clocks=false&evals=false', {
    headers: { 'Accept': 'application/x-chess-pgn' }
  }).then(function (r) {
    if (r.status === 404) throw new Error('Player not found on Lichess');
    if (!r.ok) throw new Error('Lichess API error (' + r.status + ')');
    return r.text();
  }).then(function (text) {
    return splitPGNs(text);
  });
}

function fetchChessCom(username, count) {
  return fetch('https://api.chess.com/pub/player/' + encodeURIComponent(username.toLowerCase()) + '/games/archives')
    .then(function (r) {
      if (!r.ok) throw new Error('Player not found on Chess.com');
      return r.json();
    }).then(function (data) {
      var archives = data.archives;
      if (!archives || !archives.length) throw new Error('No games found');
      return collectChessComGames(archives, count);
    });
}

function collectChessComGames(archives, count) {
  var pgns = [];
  var idx = archives.length - 1;
  function next() {
    if (idx < 0 || pgns.length >= count) return Promise.resolve(pgns.slice(0, count));
    return fetch(archives[idx--]).then(function (r) { return r.json(); }).then(function (data) {
      var games = data.games || [];
      for (var i = games.length - 1; i >= 0 && pgns.length < count; i--) {
        if (games[i].pgn) pgns.push(games[i].pgn);
      }
      return next();
    });
  }
  return next();
}

function splitPGNs(text) {
  if (!text || !text.trim()) return [];
  return text.trim().split(/\n\n(?=\[Event )/g).filter(function (p) { return p.trim().length > 0; });
}

// ── PGN parsing ──
function parseGame(pgn, username) {
  var g = new Chess();
  // Clean annotations
  var clean = pgn.replace(/\{[^}]*\}/g, '').replace(/\$\d+/g, '');
  if (!g.load_pgn(clean, { sloppy: true })) return null;
  var headers = g.header();
  var white = (headers.White || '').trim();
  var black = (headers.Black || '').trim();
  var userIsWhite = white.toLowerCase() === username.toLowerCase();
  var userIsBlack = black.toLowerCase() === username.toLowerCase();
  if (!userIsWhite && !userIsBlack) return null;
  var playerColor = userIsWhite ? 'w' : 'b';
  var moves = g.history({ verbose: true });
  if (moves.length < 6) return null; // skip very short games
  return {
    pgn: pgn,
    headers: headers,
    playerColor: playerColor,
    opponent: userIsWhite ? black : white,
    moves: moves
  };
}

// ── Analysis pipeline ──
function analyzeAllGames(games, onProgress) {
  // Count total positions
  var totalPos = 0;
  games.forEach(function (g) { totalPos += g.moves.length + 1; });
  var donePos = 0;

  var gameIdx = 0;
  function nextGame() {
    if (gameIdx >= games.length) return Promise.resolve();
    var g = games[gameIdx];
    var chess = new Chess();
    g.evals = [];
    g.bestMoves = [];
    var moveIdx = 0;

    function nextPos() {
      var fen = chess.fen();
      return sfAnalyze(fen, 10).then(function (res) {
        var score = res.score || { type: 'cp', value: 0 };
        // normalize to white perspective
        var turn = chess.turn();
        var normVal;
        if (score.type === 'mate') {
          var raw = score.value;
          normVal = { type: 'mate', value: turn === 'w' ? raw : -raw };
        } else {
          normVal = { type: 'cp', value: turn === 'w' ? score.value : -score.value };
        }
        g.evals.push(normVal);
        g.bestMoves.push(res.bestMove);
        donePos++;
        onProgress(donePos, totalPos, gameIdx + 1, games.length);

        if (moveIdx < g.moves.length) {
          chess.move(g.moves[moveIdx].san);
          moveIdx++;
          return nextPos();
        }
        // done with this game
      });
    }

    return nextPos().then(function () {
      classifyGameMoves(g);
      gameIdx++;
      return nextGame();
    });
  }

  return waitReady().then(nextGame);
}

// ── Classification ──
function evalToCp(ev) {
  if (!ev) return 0;
  if (ev.type === 'mate') {
    return ev.value > 0 ? (10000 - Math.abs(ev.value) * 10) : -(10000 - Math.abs(ev.value) * 10);
  }
  return ev.value;
}

function classifyGameMoves(g) {
  g.classifications = [];
  var isWhite = g.playerColor === 'w';
  for (var i = 0; i < g.moves.length; i++) {
    var isPlayerMove = (g.moves[i].color === g.playerColor);
    if (!isPlayerMove) {
      g.classifications.push(null);
      continue;
    }
    var evBefore = evalToCp(g.evals[i]);
    var evAfter = evalToCp(g.evals[i + 1]);
    var loss = isWhite ? (evBefore - evAfter) : (evAfter - evBefore);
    if (loss < 0) loss = 0; // move was actually better than engine expected

    // Check for missed mate
    var beforeIsMate = g.evals[i] && g.evals[i].type === 'mate';
    var mateForUser = beforeIsMate && ((isWhite && g.evals[i].value > 0) || (!isWhite && g.evals[i].value < 0));
    var afterIsMate = g.evals[i + 1] && g.evals[i + 1].type === 'mate';
    var afterStillWinning = afterIsMate && ((isWhite && g.evals[i + 1].value > 0) || (!isWhite && g.evals[i + 1].value < 0));

    // Check if player's move matches engine bestmove first
    var bm = g.bestMoves[i];
    var mv = g.moves[i];
    var isEngineBest = bm && mv && bm === (mv.from + mv.to + (mv.promotion || ''));

    var cls;
    if (isEngineBest) {
      cls = 'best';
    } else if (mateForUser && !afterStillWinning) {
      cls = 'mate';
    } else if (loss <= 0) {
      cls = 'best';
    } else if (loss <= 15) {
      cls = 'excellent';
    } else if (loss <= 80) {
      cls = 'good';
    } else if (loss <= 150) {
      cls = 'inaccuracy';
    } else if (loss <= 300) {
      cls = 'mistake';
    } else {
      cls = 'blunder';
    }

    g.classifications.push({ cls: cls, loss: loss, moveIndex: i });
  }
}

// ── Puzzle generation ──
function generatePuzzles(games) {
  var raw = [];
  for (var gi = 0; gi < games.length; gi++) {
    var g = games[gi];
    var isWhite = g.playerColor === 'w';
    for (var mi = 0; mi < g.classifications.length; mi++) {
      var c = g.classifications[mi];
      if (!c) continue;
      if (c.cls !== 'blunder' && c.cls !== 'mate') continue;

      // Skip if already dead lost before the mistake
      var userEvalBefore = isWhite ? evalToCp(g.evals[mi]) : -evalToCp(g.evals[mi]);
      if (userEvalBefore < -400) continue;

      var moveNum = Math.floor(mi / 2) + 1;

      // Reconstruct FEN at this position
      var chess = new Chess();
      for (var k = 0; k < mi; k++) chess.move(g.moves[k].san);
      var fen = chess.fen();

      // Get best move in SAN
      var bestUCI = g.bestMoves[mi];
      var bestSAN = '';
      if (bestUCI) {
        var tmp = new Chess(fen);
        var bmObj = tmp.move({ from: bestUCI.slice(0, 2), to: bestUCI.slice(2, 4), promotion: bestUCI.length > 4 ? bestUCI[4] : undefined });
        bestSAN = bmObj ? bmObj.san : bestUCI;
      }

      raw.push({
        gameIndex: gi,
        opponent: g.opponent,
        gameDate: g.headers.Date || '',
        result: g.headers.Result || '',
        moveNumber: moveNum,
        plyIndex: mi,
        fen: fen,
        playerColor: g.playerColor,
        bestMoveUCI: bestUCI,
        bestMoveSAN: bestSAN,
        playerMoveSAN: g.moves[mi].san,
        playerMoveFrom: g.moves[mi].from,
        playerMoveTo: g.moves[mi].to,
        classification: c.cls,
        evalLoss: c.loss,
        evalBefore: g.evals[mi],
        evalAfter: g.evals[mi + 1] || g.evals[mi]
      });
    }
  }

  // Sort by move number — earlier blunders first
  raw.sort(function (a, b) {
    return a.moveNumber - b.moveNumber;
  });
  return raw;
}

// ── UI: Progress ──
function setProgress(pct, detail) {
  document.getElementById('progressBar').style.width = pct + '%';
  if (detail) document.getElementById('loadingDetail').textContent = detail;
}

// ── Start analysis flow ──
function startAnalysis() {
  var username = document.getElementById('usernameInput').value.trim();
  if (!username) { showError('Please enter a username'); return; }
  var count = parseInt(document.getElementById('gameCountSlider').value, 10);
  showError('');
  document.getElementById('goBtn').disabled = true;

  showScreen('loadingScreen');
  document.getElementById('loadingTitle').textContent = 'Fetching games...';
  setProgress(0, 'Connecting to ' + (platform === 'lichess' ? 'Lichess' : 'Chess.com') + '...');

  fetchGames(username, count).then(function (pgns) {
    if (!pgns.length) throw new Error('No games found for this player');

    if (pgns.length < count) {
      alert("You don't have enough games, only found " + pgns.length + " games — starting analysis with those.");
    }

    setProgress(0, 'Parsing ' + pgns.length + ' games...');

    var games = [];
    pgns.forEach(function (p) {
      var g = parseGame(p, username);
      if (g) games.push(g);
    });
    if (!games.length) throw new Error('Could not parse any games. Check your username.');

    document.getElementById('loadingTitle').textContent = 'Analyzing with Stockfish...';
    return analyzeAllGames(games, function (done, total, gIdx, gTotal) {
      var pct = Math.round((done / total) * 100);
      setProgress(pct, 'Game ' + gIdx + '/' + gTotal + '  —  Position ' + done + '/' + total);
    }).then(function () { return games; });

  }).then(function (games) {
    puzzles = generatePuzzles(games);
    if (!puzzles.length) {
      showScreen('msgScreen');
      document.getElementById('msgTitle').textContent = 'No mistakes found!';
      document.getElementById('msgText').textContent = 'You played well across all ' + games.length + ' games analyzed. Try analyzing more games.';
      return;
    }
    currentPuzzle = 0;
    initPuzzleBoard();
    showScreen('puzzleScreen');
    loadPuzzle(0);

  }).catch(function (err) {
    showScreen('inputScreen');
    document.getElementById('goBtn').disabled = false;
    showError(err.message || 'Something went wrong');
  });
}

function showError(msg) {
  document.getElementById('errorMsg').textContent = msg;
}

// ── Puzzle board ──
function initPuzzleBoard() {
  if (board) board.destroy();
  board = Chessboard('board', {
    draggable: true,
    position: 'start',
    onDragStart: onPuzzleDragStart,
    onDrop: onPuzzleDrop,
    onSnapEnd: onPuzzleSnapEnd,
    pieceTheme: 'chessboardjs/img/chesspieces/wikipedia/{piece}.png'
  });
  $(window).off('resize.puzzle').on('resize.puzzle', function () { board.resize(); });
}

var puzzleChess = null;

function loadPuzzle(idx) {
  if (idx >= puzzles.length) {
    showScreen('msgScreen');
    document.getElementById('msgTitle').textContent = 'All done!';
    document.getElementById('msgText').textContent = 'You completed all ' + puzzles.length + ' puzzles.';
    return;
  }
  currentPuzzle = idx;
  var p = puzzles[idx];

  // Show position AFTER blunder for info phase
  puzzleChess = new Chess(p.fen);
  puzzleChess.move({ from: p.playerMoveFrom, to: p.playerMoveTo, promotion: 'q' });
  var afterFen = puzzleChess.fen();
  board.position(afterFen, false);
  board.orientation(p.playerColor === 'b' ? 'black' : 'white');

  // Bottom = user, Top = opponent
  document.getElementById('bottomLabel').textContent = 'You';
  document.getElementById('topLabel').textContent = p.opponent;
  // Swap pip colors to match orientation
  var topPip = document.getElementById('topPip');
  var botPip = document.getElementById('bottomPip');
  if (p.playerColor === 'b') {
    topPip.className = 'player-pip pip-white';
    botPip.className = 'player-pip pip-black';
  } else {
    topPip.className = 'player-pip pip-black';
    botPip.className = 'player-pip pip-white';
  }

  // Eval bar — show eval after blunder
  renderEvalBar(p.evalAfter);

  // Header
  document.getElementById('puzzleCounter').textContent = 'Puzzle ' + (idx + 1) + ' of ' + puzzles.length;
  var info = 'vs ' + p.opponent;
  if (p.gameDate) info += '  \u00B7  ' + p.gameDate.replace(/\./g, '/');
  document.getElementById('puzzleGameInfo').textContent = info;

  // Phase 1: Show blunder info
  puzzlePhase = 'info';
  puzzleActive = false;
  clearBadges();
  clearHighlights();

  // Show blunder badge on the destination square
  setTimeout(function () {
    showBadge(p.playerMoveTo, p.classification);
    highlightSquare(p.playerMoveFrom, 'highlight-from');
    highlightSquare(p.playerMoveTo, 'highlight-to');
  }, 50);

  var evalStr = formatEvalPawn(p.evalBefore) + ' \u2192 ' + formatEvalPawn(p.evalAfter);
  document.getElementById('promptText').style.display = 'none';
  var ra = document.getElementById('resultArea');
  ra.style.display = 'block';
  ra.innerHTML =
    '<div class="info-blunder-label">' +
      '<img src="classifications/' + p.classification + '.png" style="width:24px;height:24px;vertical-align:middle;margin-right:6px">' +
      '<span>You played <strong>' + p.playerMoveSAN + '</strong></span>' +
    '</div>' +
    '<div class="info-eval">' + evalStr + '</div>' +
    '<div class="info-hint">Can you find the better move?</div>';
  document.getElementById('puzzleBtns').innerHTML =
    '<button class="pbtn" onclick="skipPuzzle()">Skip</button>' +
    '<button class="pbtn pbtn-primary" onclick="activatePuzzle()">Find the move</button>';

  // Progress
  updateProgress(idx);
}

// ── Activate puzzle (Phase 2) ──
function activatePuzzle() {
  var p = puzzles[currentPuzzle];
  puzzlePhase = 'play';
  puzzleActive = true;

  // Reset board to BEFORE the blunder
  puzzleChess = new Chess(p.fen);
  board.position(p.fen, false);
  clearBadges();
  clearHighlights();

  // Show eval before the blunder
  renderEvalBar(p.evalBefore);

  document.getElementById('promptText').textContent = 'Find the best move!';
  document.getElementById('promptText').style.display = '';
  document.getElementById('resultArea').style.display = 'none';
  document.getElementById('resultArea').innerHTML = '';
  document.getElementById('puzzleBtns').innerHTML = '<button class="pbtn" onclick="skipPuzzle()">Skip</button>';
}

// ── Puzzle interaction ──
function onPuzzleDragStart(source, piece) {
  if (!puzzleActive) return false;
  var p = puzzles[currentPuzzle];
  // Only allow user's pieces
  if (p.playerColor === 'w' && piece.search(/^b/) !== -1) return false;
  if (p.playerColor === 'b' && piece.search(/^w/) !== -1) return false;
  return true;
}

var puzzleHandled = false;

function onPuzzleDrop(source, target) {
  if (!puzzleActive) return 'snapback';
  var p = puzzles[currentPuzzle];

  // Validate move is legal
  var testChess = new Chess(p.fen);
  var move = testChess.move({ from: source, to: target, promotion: 'q' });
  if (!move) return 'snapback';

  // Compare with best move
  var bestFrom = p.bestMoveUCI ? p.bestMoveUCI.slice(0, 2) : '';
  var bestTo = p.bestMoveUCI ? p.bestMoveUCI.slice(2, 4) : '';

  puzzleHandled = true;
  if (source === bestFrom && target === bestTo) {
    puzzleCorrect(source, target);
  } else {
    // Evaluate the user's move to see if it's a good alternative
    puzzleActive = false;
    var fenAfterMove = testChess.fen();
    sfAnalyze(fenAfterMove, 10).then(function (res) {
      var score = res.score || { type: 'cp', value: 0 };
      // Normalize to white perspective
      var turn = testChess.turn();
      var normEv;
      if (score.type === 'mate') {
        var mv = turn === 'w' ? score.value : -score.value;
        normEv = { type: 'mate', value: mv };
      } else {
        normEv = { type: 'cp', value: turn === 'w' ? score.value : -score.value };
      }
      var normVal = evalToCp(normEv);
      // Compute loss: how much worse is this than before?
      var evBefore = evalToCp(p.evalBefore);
      var isWhite = p.playerColor === 'w';
      var loss = isWhite ? (evBefore - normVal) : (normVal - evBefore);
      if (loss < 0) loss = 0;

      if (loss <= 80) {
        // Good or excellent alternative
        puzzleGoodAlternative(source, target, move.san);
      } else {
        puzzleWrong(source, target);
      }
    });
  }
}

function onPuzzleSnapEnd() {
  // Only sync if we didn't manually handle the result
  if (puzzleHandled) {
    puzzleHandled = false;
    return;
  }
  if (puzzleChess) board.position(puzzleChess.fen());
}

function puzzleCorrect(from, to) {
  puzzleActive = false;
  var p = puzzles[currentPuzzle];

  // Play the move on the puzzle chess
  puzzleChess.move({ from: from, to: to, promotion: 'q' });
  board.position(puzzleChess.fen());

  // Show badge
  showBadge(to, 'best');

  // Update prompt
  document.getElementById('promptText').style.display = 'none';
  var ra = document.getElementById('resultArea');
  ra.style.display = 'block';
  var evalStr = formatEvalPawn(p.evalBefore) + ' \u2192 ' + formatEvalPawn(p.evalAfter);
  ra.innerHTML = '<div class="result-row"><img src="classifications/best.png"><span class="result-correct">Correct!</span></div>' +
    '<div class="result-detail">You found the best move: ' + p.bestMoveSAN + '</div>' +
    '<div class="original-move"><img src="classifications/' + p.classification + '.png" style="width:18px;height:18px;vertical-align:middle;margin-right:4px">You played ' + p.playerMoveSAN + ' (' + evalStr + ')</div>';

  document.getElementById('puzzleBtns').innerHTML =
    '<button class="pbtn pbtn-primary" onclick="nextPuzzle()">Next</button>';

  updateProgress(currentPuzzle + 1);
}

function puzzleGoodAlternative(from, to, moveSAN) {
  puzzleActive = false;
  var p = puzzles[currentPuzzle];

  // Play the move on the board
  puzzleChess = new Chess(p.fen);
  puzzleChess.move({ from: from, to: to, promotion: 'q' });
  board.position(puzzleChess.fen());

  // Show good badge
  showBadge(to, 'good');

  // Update prompt
  document.getElementById('promptText').style.display = 'none';
  var ra = document.getElementById('resultArea');
  ra.style.display = 'block';
  ra.innerHTML = '<div class="result-row"><img src="classifications/good.png"><span class="result-good-alt">Good alternative!</span></div>' +
    '<div class="result-detail">You played <strong>' + moveSAN + '</strong></div>' +
    '<div class="result-detail" style="margin-top:2px">The absolute best was <strong>' + p.bestMoveSAN + '</strong></div>';

  document.getElementById('puzzleBtns').innerHTML =
    '<button class="pbtn pbtn-primary" onclick="nextPuzzle()">Next</button>';

  updateProgress(currentPuzzle + 1);
}

function puzzleWrong(from, to) {
  puzzleActive = false;
  var p = puzzles[currentPuzzle];

  // Reset board to puzzle position
  board.position(p.fen, false);

  // Highlight best move squares
  highlightSquare(p.bestMoveUCI.slice(0, 2), 'highlight-from');
  highlightSquare(p.bestMoveUCI.slice(2, 4), 'highlight-to');

  // Animate best move after short delay
  setTimeout(function () {
    var bFrom = p.bestMoveUCI.slice(0, 2);
    var bTo = p.bestMoveUCI.slice(2, 4);
    board.move(bFrom + '-' + bTo);
    showBadge(bTo, 'best');
  }, 400);

  // Update prompt
  document.getElementById('promptText').style.display = 'none';
  var ra = document.getElementById('resultArea');
  ra.style.display = 'block';
  var evalStr = formatEvalPawn(p.evalBefore) + ' \u2192 ' + formatEvalPawn(p.evalAfter);
  ra.innerHTML = '<div class="result-row"><span class="result-wrong">Not quite</span></div>' +
    '<div class="result-detail">The best move was <strong>' + p.bestMoveSAN + '</strong></div>' +
    '<div class="original-move"><img src="classifications/' + p.classification + '.png" style="width:18px;height:18px;vertical-align:middle;margin-right:4px">You played ' + p.playerMoveSAN + ' (' + evalStr + ')</div>';

  document.getElementById('puzzleBtns').innerHTML =
    '<button class="pbtn pbtn-primary" onclick="nextPuzzle()">Next</button>';

  updateProgress(currentPuzzle + 1);
}

function updateProgress(completed) {
  document.getElementById('puzzleProgress').innerHTML =
    '<div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:' + Math.round((completed / puzzles.length) * 100) + '%"></div></div>' +
    '<span class="progress-label">' + completed + ' / ' + puzzles.length + '</span>';
}

function nextPuzzle() {
  loadPuzzle(currentPuzzle + 1);
}

function skipPuzzle() {
  loadPuzzle(currentPuzzle + 1);
}

// ── Eval bar ──
function renderEvalBar(ev) {
  var cp = evalToCp(ev);
  var blackPct;
  if (ev && ev.type === 'mate') {
    blackPct = ev.value > 0 ? 2 : 98;
  } else {
    cp = Math.max(-600, Math.min(600, cp));
    blackPct = 50 - (cp / 600) * 48;
  }
  document.getElementById('evalBlack').style.height = blackPct + '%';
  document.getElementById('evalWhite').style.height = (100 - blackPct) + '%';

  var text;
  if (ev && ev.type === 'mate') {
    text = (ev.value > 0 ? '+' : '-') + 'M' + Math.abs(ev.value);
  } else {
    var p = (cp / 100).toFixed(1);
    text = cp >= 0 ? '+' + p : '' + p;
  }
  document.getElementById('evalScore').textContent = text;
}

// ── Eval formatting ──
function formatEvalPawn(ev) {
  if (!ev) return '0.0';
  if (ev.type === 'mate') {
    return (ev.value > 0 ? '+' : '-') + 'M' + Math.abs(ev.value);
  }
  var p = (ev.value / 100).toFixed(1);
  return ev.value >= 0 ? '+' + p : '' + p;
}

// ── Board overlays ──
function showBadge(square, classification) {
  clearBadges();
  var el = $('[data-square="' + square + '"]');
  if (!el.length) return;
  el.css('position', 'relative');
  el.append($('<img>').addClass('move-badge').attr('src', 'classifications/' + classification + '.png'));
}

function clearBadges() {
  $('.move-badge').remove();
}

function highlightSquare(sq, cls) {
  $('[data-square="' + sq + '"]').addClass(cls);
}

function clearHighlights() {
  $('.highlight-from, .highlight-to').removeClass('highlight-from highlight-to');
}

// ── Init ──
initEngine();

// Enter key on username field
document.getElementById('usernameInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') startAnalysis();
});
