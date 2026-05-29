const crypto = require('crypto');

class GameRoom {
  constructor(config) {
    this.pin = this.generatePin();
    this.adminToken = crypto.randomBytes(16).toString('hex');

    // Round 4 Issue #2: Honor questionCount setting
    const questionCount = config.questionCount || config.questions?.length || 20;
    const allQuestions = config.questions || [];

    // Slice questions based on questionCount and randomize if requested
    let selectedQuestions = allQuestions;
    if (config.randomizeOrder && allQuestions.length > questionCount) {
      // Shuffle and take first questionCount
      const shuffled = [...allQuestions].sort(() => Math.random() - 0.5);
      selectedQuestions = shuffled.slice(0, questionCount);
    } else {
      // Take first questionCount
      selectedQuestions = allQuestions.slice(0, questionCount);
    }

    this.config = {
      ...config,
      questions: selectedQuestions, // Use sliced array
      reviewDurationSec: config.reviewDurationSec || 4,
      turnTimeLimitSec: config.turnTimeLimitSec || 15,
      comparisonDurationSec: config.comparisonDurationSec || 8
    };

    console.log(`[room ${this.pin}] game config: questionCount=${questionCount} (of ${allQuestions.length} in pool), randomize=${!!config.randomizeOrder}, keyCount=${config.boardSize || 16}`);

    this.adminSocketId = null;
    this.players = [];

    // State machine: LOBBY → ASKING → REVIEW → (ASKING ↺ | KEY_WALL) → KEY_WALL_DONE → RESULTS_COMPARISON → RESULTS_REVEAL → END
    this.gameState = 'LOBBY';

    // Quiz state (Round 3: turn-based, two-window model)
    this.currentQuestionIndex = 0;
    this.quizPhase = null; // 'primary' (20s, active player) or 'open' (10s, all players)
    this.quizTurnQueue = []; // Rotates through players
    this.currentQuizTurnIndex = 0;
    this.currentQuestionDeadlineMs = null;
    this.questionAdvanced = false; // Guard against double-advance
    this.playerAnswers = new Map(); // playerId → answerIndex (for open window)

    // Key wall state
    this.keys = this.generateKeys();
    this.turnQueue = [];
    this.currentTurnPlayerIndex = 0;
    this.currentTurnDeadlineMs = null;
    this.turnAdvanced = false;

    this.createdAt = Date.now();
  }

  generatePin() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  generateKeys() {
    const { boardSize, babyGender } = this.config;
    const dominantCount = Math.floor(boardSize * (0.6 + Math.random() * 0.1));
    const minorCount = boardSize - dominantCount;

    const keys = [
      ...Array(dominantCount).fill(babyGender),
      ...Array(minorCount).fill(babyGender === 'boy' ? 'girl' : 'boy')
    ];

    // Shuffle
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }

    return keys.map((gender, index) => ({
      id: index,
      gender,
      claimed: false,
      claimedBy: null
    }));
  }

  addPlayer(socketId, name) {
    const playerToken = crypto.randomBytes(16).toString('hex');
    const player = {
      id: Date.now() + Math.random(),
      playerToken,
      socketId,
      name,
      connected: true,
      inGame: true,
      ready: false,
      keysWon: 0,
      quizScore: 0,
      guess: null // 'boy' or 'girl' - set during setup
    };

    this.players.push(player);
    return { ...player, socketId: undefined }; // Don't expose socketId to clients
  }

  // Issue #2: Reconnection handling
  reconnectPlayer(playerToken, newSocketId) {
    const player = this.players.find(p => p.playerToken === playerToken && p.inGame);
    if (player) {
      player.socketId = newSocketId;
      player.connected = true;
      console.log(`[room ${this.pin}] Player ${player.name} reconnected`);
      return player;
    }
    return null;
  }

  disconnectPlayer(socketId) {
    const player = this.players.find(p => p.socketId === socketId);
    if (player) {
      player.connected = false;
      player.socketId = null;
      console.log(`[room ${this.pin}] Player ${player.name} disconnected (still in game)`);
      return player;
    }
    return null;
  }

  leaveGame(playerToken) {
    const playerIndex = this.players.findIndex(p => p.playerToken === playerToken);
    if (playerIndex >= 0) {
      const player = this.players[playerIndex];
      player.inGame = false;
      player.connected = false;
      this.players.splice(playerIndex, 1);
      console.log(`[room ${this.pin}] Player ${player.name} left game (explicit)`);
      return player;
    }
    return null;
  }

  togglePlayerReady(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      player.ready = !player.ready;
    }
  }

  areAllPlayersReady() {
    const inGamePlayers = this.players.filter(p => p.inGame);
    return inGamePlayers.length > 0 &&
           inGamePlayers.length === this.config.numPlayers &&
           inGamePlayers.every(p => p.ready);
  }

  // Round 3 Issue #1: Quiz state machine - turn-based ASKING phase
  startQuiz() {
    console.log(`[room ${this.pin}] LOBBY → ASKING`);
    this.gameState = 'ASKING';
    this.currentQuestionIndex = 0;

    // Initialize quiz turn queue (rotate through players)
    this.quizTurnQueue = this.players
      .filter(p => p.inGame && p.connected)
      .map(p => p.id);
    this.currentQuizTurnIndex = 0;

    this.startQuestion();
  }

  startQuestion() {
    this.questionAdvanced = false;
    this.playerAnswers.clear();

    // Check if active player is connected
    const activePlayerId = this.quizTurnQueue[this.currentQuizTurnIndex];
    const activePlayer = this.players.find(p => p.id === activePlayerId);

    // If active player disconnected, skip straight to open window
    if (!activePlayer || !activePlayer.connected) {
      console.log(`[room ${this.pin}] Q${this.currentQuestionIndex + 1} active player disconnected, skipping to open`);
      this.openQuestion();
      return;
    }

    // Start primary turn window (20 seconds, active player only)
    this.quizPhase = 'primary';
    this.currentQuestionDeadlineMs = Date.now() + 20000; // 20 seconds
    console.log(`[room ${this.pin}] Q${this.currentQuestionIndex + 1} TURN_PRIMARY started (active: ${activePlayer.name})`);
  }

  // Open question to all players (10 seconds)
  openQuestion() {
    if (this.quizPhase === 'open') {
      console.log(`[room ${this.pin}] Question already open, ignoring`);
      return;
    }

    this.quizPhase = 'open';
    this.currentQuestionDeadlineMs = Date.now() + 10000; // 10 seconds
    console.log(`[room ${this.pin}] Q${this.currentQuestionIndex + 1} TURN_PRIMARY → TURN_OPEN`);
  }

  getCurrentQuestion() {
    return this.config.questions[this.currentQuestionIndex];
  }

  // Round 3 Issue #1: Submit answer with turn validation
  submitAnswer(playerId, answerIndex) {
    const question = this.getCurrentQuestion();
    const isCorrect = answerIndex === question.correct;
    const activePlayerId = this.quizTurnQueue[this.currentQuizTurnIndex];

    // PRIMARY PHASE: only active player can answer
    if (this.quizPhase === 'primary') {
      if (playerId !== activePlayerId) {
        throw new Error('Not your turn');
      }

      console.log(`[room ${this.pin}] Q${this.currentQuestionIndex + 1} active player answered ${isCorrect ? 'correct' : 'wrong'}`);

      if (isCorrect) {
        // Award key and score
        const player = this.players.find(p => p.id === playerId);
        if (player) {
          player.keysWon += 1;
          player.quizScore += 1;
        }

        // Correct answer ends the question
        return {
          isCorrect: true,
          shouldEndQuestion: true,
          resolvedBy: playerId,
          reason: 'correct_primary'
        };
      } else {
        // Wrong answer opens to everyone
        return {
          isCorrect: false,
          shouldEndQuestion: false,
          shouldOpenQuestion: true,
          reason: 'wrong_primary'
        };
      }
    }

    // OPEN PHASE: any player can answer (once)
    if (this.quizPhase === 'open') {
      // Check if player already answered in this open window
      if (this.playerAnswers.has(playerId)) {
        throw new Error('Already answered this question');
      }

      this.playerAnswers.set(playerId, answerIndex);
      console.log(`[room ${this.pin}] Q${this.currentQuestionIndex + 1} player ${playerId} answered ${isCorrect ? 'correct' : 'wrong'} (open)`);

      if (isCorrect) {
        // First correct answer in open window wins
        const player = this.players.find(p => p.id === playerId);
        if (player) {
          player.keysWon += 1;
          player.quizScore += 1;
        }

        return {
          isCorrect: true,
          shouldEndQuestion: true,
          resolvedBy: playerId,
          reason: 'correct_open'
        };
      }

      // Wrong answer in open window - just record it, keep waiting
      return {
        isCorrect: false,
        shouldEndQuestion: false,
        reason: 'wrong_open'
      };
    }

    throw new Error('Invalid quiz phase');
  }

  // Round 3 Issue #1: End question and transition to REVIEW
  endQuestion(reason, resolvedBy = null) {
    if (this.questionAdvanced) {
      console.log(`[room ${this.pin}] Q${this.currentQuestionIndex + 1} already advanced, ignoring`);
      return { alreadyAdvanced: true };
    }

    this.questionAdvanced = true;
    console.log(`[room ${this.pin}] Q${this.currentQuestionIndex + 1} ${this.quizPhase === 'primary' ? 'TURN_PRIMARY' : 'TURN_OPEN'} → REVIEW (reason: ${reason})`);
    this.gameState = 'REVIEW';

    const question = this.getCurrentQuestion();
    const results = this.players.map(p => ({
      playerId: p.id,
      answerIndex: this.playerAnswers.get(p.id),
      isCorrect: this.playerAnswers.get(p.id) === question.correct
    }));

    return {
      alreadyAdvanced: false,
      correctAnswer: question.correct,
      resolvedBy,
      results,
      reviewDurationMs: this.config.reviewDurationSec * 1000
    };
  }

  // Round 3 Issue #1: Advance to next question or KEY_WALL (rotate turn)
  advanceFromReview() {
    this.currentQuestionIndex += 1;

    // Rotate to next player in quiz turn queue
    this.currentQuizTurnIndex = (this.currentQuizTurnIndex + 1) % this.quizTurnQueue.length;

    if (this.currentQuestionIndex >= this.config.questions.length) {
      // Quiz finished
      console.log(`[room ${this.pin}] REVIEW → KEY_WALL`);
      this.gameState = 'KEY_WALL';
      this.startKeyWall();
      return { quizFinished: true };
    }

    console.log(`[room ${this.pin}] REVIEW → ASKING (Q${this.currentQuestionIndex + 1})`);
    this.gameState = 'ASKING';
    this.startQuestion();
    return { quizFinished: false };
  }

  // Issue #3: Key Wall turn-based system
  startKeyWall() {
    this.turnQueue = this.players
      .filter(p => p.inGame && p.keysWon > 0)
      .map(p => p.id);

    this.currentTurnPlayerIndex = 0;
    this.startTurn();
  }

  startTurn() {
    if (this.turnQueue.length === 0) {
      console.log(`[room ${this.pin}] No players with keys, ending keywall`);
      this.endKeyWall();
      return;
    }

    // Check if all keys claimed
    if (this.keys.every(k => k.claimed)) {
      console.log(`[room ${this.pin}] All keys claimed`);
      this.endKeyWall();
      return;
    }

    this.turnAdvanced = false;
    const currentPlayerId = this.turnQueue[this.currentTurnPlayerIndex];
    const currentPlayer = this.players.find(p => p.id === currentPlayerId);

    // Skip if disconnected
    if (!currentPlayer || !currentPlayer.connected) {
      console.log(`[room ${this.pin}] keywall turn → skipping ${currentPlayer?.name || 'unknown'} (disconnected)`);
      this.advanceTurn('skip_disconnected');
      return;
    }

    // Skip if no keys left
    if (currentPlayer.keysWon <= 0) {
      console.log(`[room ${this.pin}] keywall turn → skipping ${currentPlayer.name} (no keys)`);
      this.advanceTurn('no_keys');
      return;
    }

    this.currentTurnDeadlineMs = Date.now() + (this.config.turnTimeLimitSec * 1000);
    console.log(`[room ${this.pin}] keywall turn → ${currentPlayer.name}`);
  }

  claimKey(playerId, keyId) {
    const key = this.keys.find(k => k.id === keyId);
    if (!key) {
      throw new Error('Key not found');
    }

    if (key.claimed) {
      throw new Error('Key already claimed');
    }

    const currentPlayerId = this.turnQueue[this.currentTurnPlayerIndex];
    if (playerId !== currentPlayerId) {
      throw new Error('Not your turn');
    }

    const player = this.players.find(p => p.id === playerId);
    if (!player || player.keysWon <= 0) {
      throw new Error('No keys available');
    }

    key.claimed = true;
    key.claimedBy = playerId;
    player.keysWon -= 1;

    console.log(`[room ${this.pin}] keywall ${player.name} claimed key ${keyId} (${key.gender})`);

    return { gender: key.gender };
  }

  advanceTurn(reason) {
    if (this.turnAdvanced) {
      console.log(`[room ${this.pin}] Turn already advanced, ignoring`);
      return { alreadyAdvanced: true };
    }

    this.turnAdvanced = true;

    // Move to next player in queue
    this.currentTurnPlayerIndex = (this.currentTurnPlayerIndex + 1) % this.turnQueue.length;

    console.log(`[room ${this.pin}] keywall turn advanced (reason: ${reason})`);

    // Start next turn
    this.startTurn();

    return { alreadyAdvanced: false };
  }

  // Auto-pick random key for timeout
  autoPickKey() {
    const currentPlayerId = this.turnQueue[this.currentTurnPlayerIndex];
    const unclaimedKeys = this.keys.filter(k => !k.claimed);

    if (unclaimedKeys.length > 0) {
      const randomKey = unclaimedKeys[Math.floor(Math.random() * unclaimedKeys.length)];
      this.claimKey(currentPlayerId, randomKey.id);
      return randomKey;
    }

    return null;
  }

  // Round 3 Issue #2: End key wall → waiting state (host-gated)
  endKeyWall() {
    console.log(`[room ${this.pin}] KEY_WALL → KEY_WALL_DONE`);
    this.gameState = 'KEY_WALL_DONE';
  }

  // Round 3 Issue #2: Host announces results → comparison table
  advanceToComparison() {
    console.log(`[room ${this.pin}] KEY_WALL_DONE → RESULTS_COMPARISON (host announce)`);
    this.gameState = 'RESULTS_COMPARISON';
  }

  // Round 3 Issue #3: Host reveals gender
  advanceToReveal() {
    console.log(`[room ${this.pin}] RESULTS_COMPARISON → RESULTS_REVEAL (host reveal)`);
    this.gameState = 'RESULTS_REVEAL';
  }

  // Issue #4: Results phase
  getComparisonTable() {
    const { babyGender } = this.config;

    const rows = this.players
      .filter(p => p.inGame)
      .map(p => {
        const claimedKeys = this.keys.filter(k => k.claimedBy === p.id);
        const correctKeys = claimedKeys.filter(k => k.gender === babyGender).length;
        const guessedCorrectly = p.guess === babyGender;

        return {
          playerId: p.id,
          name: p.name,
          guess: p.guess,
          keysWon: claimedKeys.length,
          quizScore: p.quizScore,
          correctKeys,
          guessedCorrectly
        };
      })
      .sort((a, b) => {
        // Sort by correct keys (most wins), then by quiz score
        if (b.correctKeys !== a.correctKeys) {
          return b.correctKeys - a.correctKeys;
        }
        return b.quizScore - a.quizScore;
      });

    return {
      rows,
      actualGender: babyGender
    };
  }

  advanceToWinner() {
    console.log(`[room ${this.pin}] RESULTS_COMPARISON → RESULTS_WINNER`);
    this.gameState = 'RESULTS_WINNER';
  }

  calculateWinners() {
    const comparison = this.getComparisonTable();
    const topScore = comparison.rows[0]?.correctKeys || 0;

    // Find all players with top score (handle ties)
    const winners = comparison.rows.filter(r => r.correctKeys === topScore);

    return {
      winners: winners.map(w => ({
        playerId: w.playerId,
        name: w.name,
        correctKeys: w.correctKeys,
        quizScore: w.quizScore
      })),
      actualGender: comparison.actualGender
    };
  }

  // Get current state for rejoining players
  getCurrentPhaseState() {
    const baseState = {
      pin: this.pin,
      gameState: this.gameState,
      players: this.getPlayersState()
    };

    switch (this.gameState) {
      case 'LOBBY':
        return {
          ...baseState,
          config: this.getPublicConfig()
        };

      case 'ASKING':
        const activePlayerId = this.quizTurnQueue[this.currentQuizTurnIndex];
        return {
          ...baseState,
          currentQuestion: this.getCurrentQuestion(),
          currentQuestionIndex: this.currentQuestionIndex,
          quizPhase: this.quizPhase, // 'primary' or 'open'
          activePlayerId: activePlayerId,
          remainingTimeMs: Math.max(0, this.currentQuestionDeadlineMs - Date.now()),
          playerAnswers: Array.from(this.playerAnswers.keys())
        };

      case 'REVIEW':
        return {
          ...baseState,
          currentQuestionIndex: this.currentQuestionIndex,
          correctAnswer: this.getCurrentQuestion().correct
        };

      case 'KEY_WALL':
        const currentPlayerId = this.turnQueue[this.currentTurnPlayerIndex];
        return {
          ...baseState,
          keys: this.keys.map(k => ({
            id: k.id,
            claimed: k.claimed,
            claimedBy: k.claimedBy,
            gender: k.claimed ? k.gender : undefined
          })),
          currentTurnPlayerId: currentPlayerId,
          remainingTimeMs: Math.max(0, this.currentTurnDeadlineMs - Date.now()),
          scoreBoy: this.keys.filter(k => k.claimed && k.gender === 'boy').length,
          scoreGirl: this.keys.filter(k => k.claimed && k.gender === 'girl').length
        };

      case 'KEY_WALL_DONE':
        return {
          ...baseState,
          scoreBoy: this.keys.filter(k => k.claimed && k.gender === 'boy').length,
          scoreGirl: this.keys.filter(k => k.claimed && k.gender === 'girl').length
        };

      case 'RESULTS_COMPARISON':
        return {
          ...baseState,
          comparison: this.getComparisonTable()
        };

      case 'RESULTS_REVEAL':
        return {
          ...baseState,
          winners: this.calculateWinners(),
          comparison: this.getComparisonTable()
        };

      default:
        return baseState;
    }
  }

  getPlayersState() {
    return this.players
      .filter(p => p.inGame)
      .map(p => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        ready: p.ready,
        keysWon: p.keysWon,
        quizScore: p.quizScore,
        guess: p.guess
      }));
  }

  getPublicConfig() {
    return {
      numPlayers: this.config.numPlayers,
      numQuestions: this.config.numQuestions,
      timerSeconds: this.config.timerSeconds,
      boardSize: this.config.boardSize
      // babyGender is NOT exposed until reveal
    };
  }

  getState() {
    return this.getCurrentPhaseState();
  }
}

module.exports = GameRoom;
