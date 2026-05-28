const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const GameRoom = require('./gameRoom');

const app = express();
const server = http.createServer(app);

// Configure CORS for Socket.io
const allowedOrigins = [
  "http://localhost:3000",
  "http://10.0.0.6:3000",
  "https://gender-reveal-app-livid.vercel.app",
  process.env.CLIENT_URL
].filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json());

// Store active game rooms and their timers
const rooms = new Map();
const quizTimers = new Map();
const keyWallTimers = new Map();
const reviewTimers = new Map();
const comparisonTimers = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

// =============================================================================
// TIMER MANAGEMENT
// =============================================================================

// Issue #1: Quiz timer - polls and handles timeout
function startQuizTimer(pin, room) {
  if (quizTimers.has(pin)) {
    clearInterval(quizTimers.get(pin));
  }

  const timer = setInterval(() => {
    if (!rooms.has(pin) || room.gameState !== 'ASKING') {
      clearInterval(timer);
      quizTimers.delete(pin);
      return;
    }

    const remainingMs = room.currentQuestionDeadlineMs - Date.now();

    // Emit timer update every second
    io.to(pin).emit('quiz:timer', {
      remainingMs: Math.max(0, remainingMs)
    });

    // Check timeout
    if (remainingMs <= 0) {
      clearInterval(timer);
      quizTimers.delete(pin);
      handleQuestionEnd(pin, room, 'timeout');
    }
  }, 1000);

  quizTimers.set(pin, timer);
}

function stopQuizTimer(pin) {
  if (quizTimers.has(pin)) {
    clearInterval(quizTimers.get(pin));
    quizTimers.delete(pin);
  }
}

// Issue #1: Handle question end → REVIEW
function handleQuestionEnd(pin, room, reason) {
  const reviewData = room.endQuestion(reason);

  if (reviewData.alreadyAdvanced) {
    return; // Idempotent - already transitioned
  }

  // Broadcast review state
  io.to(pin).emit('quiz:review', {
    correctAnswer: reviewData.correctAnswer,
    results: reviewData.results,
    reviewDurationMs: reviewData.reviewDurationMs,
    players: room.getPlayersState()
  });

  // Auto-advance after review duration
  setTimeout(() => {
    const advanceResult = room.advanceFromReview();

    if (advanceResult.quizFinished) {
      // Move to KEY_WALL
      io.to(pin).emit('keywall:started', room.getCurrentPhaseState());
      startKeyWallTimer(pin, room);
    } else {
      // Next question
      io.to(pin).emit('quiz:question', room.getCurrentPhaseState());
      startQuizTimer(pin, room);
    }
  }, reviewData.reviewDurationMs);
}

// Issue #3: Key wall turn timer
function startKeyWallTimer(pin, room) {
  if (keyWallTimers.has(pin)) {
    clearInterval(keyWallTimers.get(pin));
  }

  const timer = setInterval(() => {
    if (!rooms.has(pin) || room.gameState !== 'KEY_WALL') {
      clearInterval(timer);
      keyWallTimers.delete(pin);
      return;
    }

    const remainingMs = room.currentTurnDeadlineMs - Date.now();

    // Emit timer update
    io.to(pin).emit('keywall:timer', {
      remainingMs: Math.max(0, remainingMs),
      currentTurnPlayerId: room.turnQueue[room.currentTurnPlayerIndex]
    });

    // Check timeout
    if (remainingMs <= 0) {
      // Auto-pick for this player
      const key = room.autoPickKey();

      if (key) {
        io.to(pin).emit('keywall:claimed', {
          keyId: key.id,
          gender: key.gender,
          playerId: room.turnQueue[room.currentTurnPlayerIndex],
          auto: true,
          ...room.getCurrentPhaseState()
        });
      }

      // Advance turn
      room.advanceTurn('timeout');

      // Check if wall ended
      if (room.gameState === 'RESULTS_COMPARISON') {
        stopKeyWallTimer(pin);
        handleKeyWallEnd(pin, room);
      }
    }
  }, 1000);

  keyWallTimers.set(pin, timer);
}

function stopKeyWallTimer(pin) {
  if (keyWallTimers.has(pin)) {
    clearInterval(keyWallTimers.get(pin));
    keyWallTimers.delete(pin);
  }
}

// Issue #4: Handle key wall end → RESULTS_COMPARISON
function handleKeyWallEnd(pin, room) {
  const comparison = room.getComparisonTable();

  io.to(pin).emit('results:comparison', {
    ...comparison,
    comparisonDurationMs: room.config.comparisonDurationSec * 1000
  });

  // Auto-advance to winner after comparison duration
  setTimeout(() => {
    room.advanceToWinner();
    const winners = room.calculateWinners();

    io.to(pin).emit('results:winner', winners);
  }, room.config.comparisonDurationSec * 1000);
}

// =============================================================================
// SOCKET.IO CONNECTION HANDLER
// =============================================================================

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // =========================================================================
  // ROOM CREATION & JOINING
  // =========================================================================

  // Create new game room (Admin only)
  socket.on('create-room', (gameConfig, callback) => {
    try {
      const room = new GameRoom(gameConfig);
      rooms.set(room.pin, room);

      socket.join(room.pin);
      room.adminSocketId = socket.id;

      console.log(`Room created: ${room.pin} by ${socket.id}`);

      callback({
        success: true,
        pin: room.pin,
        adminToken: room.adminToken,
        room: room.getState()
      });
    } catch (error) {
      console.error('Error creating room:', error);
      callback({ success: false, error: error.message });
    }
  });

  // Join existing room (Players)
  socket.on('join-room', ({ pin, playerName }, callback) => {
    try {
      const room = rooms.get(pin);

      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      if (room.gameState !== 'LOBBY') {
        return callback({ success: false, error: 'Game already started' });
      }

      if (room.players.filter(p => p.inGame).length >= room.config.numPlayers) {
        return callback({ success: false, error: 'Room is full' });
      }

      const playerData = room.addPlayer(socket.id, playerName);
      socket.join(pin);

      console.log(`Player ${playerName} joined room ${pin}`);

      // Notify all players in room
      io.to(pin).emit('player-joined', {
        player: playerData,
        players: room.getPlayersState(),
        room: room.getState()
      });

      callback({
        success: true,
        playerToken: playerData.playerToken, // Send token for reconnection
        player: playerData,
        room: room.getState()
      });
    } catch (error) {
      console.error('Error joining room:', error);
      callback({ success: false, error: error.message });
    }
  });

  // Issue #2: Rejoin with playerToken
  socket.on('room:rejoin', ({ pin, playerToken }, callback) => {
    try {
      const room = rooms.get(pin);

      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      const player = room.reconnectPlayer(playerToken, socket.id);

      if (!player) {
        return callback({ success: false, error: 'Player not found or already left' });
      }

      socket.join(pin);

      console.log(`Player ${player.name} rejoined room ${pin}`);

      // Notify all players
      io.to(pin).emit('player-reconnected', {
        playerId: player.id,
        playerName: player.name,
        players: room.getPlayersState()
      });

      // Send current phase state to rejoining player
      callback({
        success: true,
        player: { ...player, socketId: undefined },
        currentState: room.getCurrentPhaseState()
      });
    } catch (error) {
      console.error('Error rejoining room:', error);
      callback({ success: false, error: error.message });
    }
  });

  // Admin rejoin with adminToken
  socket.on('admin:rejoin', ({ pin, adminToken }, callback) => {
    try {
      const room = rooms.get(pin);

      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      if (room.adminToken !== adminToken) {
        return callback({ success: false, error: 'Invalid admin token' });
      }

      // Update admin socket ID
      room.adminSocketId = socket.id;
      socket.join(pin);

      console.log(`Admin rejoined room ${pin}`);

      callback({
        success: true,
        room: room.getState()
      });
    } catch (error) {
      console.error('Error admin rejoining room:', error);
      callback({ success: false, error: error.message });
    }
  });

  // Issue #2: Explicit leave game
  socket.on('room:leave', ({ pin, playerToken }, callback) => {
    try {
      const room = rooms.get(pin);

      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      const player = room.leaveGame(playerToken);

      if (player) {
        io.to(pin).emit('player-left', {
          playerId: player.id,
          playerName: player.name,
          players: room.getPlayersState()
        });

        console.log(`Player ${player.name} explicitly left room ${pin}`);
      }

      callback({ success: true });
    } catch (error) {
      console.error('Error leaving room:', error);
      callback({ success: false, error: error.message });
    }
  });

  // =========================================================================
  // LOBBY PHASE
  // =========================================================================

  // Player ready toggle
  socket.on('player-ready', ({ pin, playerId }, callback) => {
    try {
      const room = rooms.get(pin);
      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      room.togglePlayerReady(playerId);

      io.to(pin).emit('player-ready-changed', {
        players: room.getPlayersState(),
        allReady: room.areAllPlayersReady()
      });

      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Start quiz (Admin only)
  socket.on('start-quiz', ({ pin }, callback) => {
    try {
      const room = rooms.get(pin);
      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      if (socket.id !== room.adminSocketId) {
        return callback({ success: false, error: 'Only admin can start game' });
      }

      const inGamePlayers = room.players.filter(p => p.inGame);
      if (inGamePlayers.length === 0) {
        return callback({ success: false, error: 'No players in room' });
      }

      // Require at least 2 players for multiplayer game
      if (inGamePlayers.length < 2) {
        return callback({ success: false, error: 'Need at least 2 players to start' });
      }

      room.startQuiz();

      io.to(pin).emit('quiz:started', room.getCurrentPhaseState());

      // Start quiz timer
      startQuizTimer(pin, room);

      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // =========================================================================
  // QUIZ PHASE (Issue #1)
  // =========================================================================

  // Submit answer
  socket.on('quiz:answer', ({ pin, playerId, answerIndex }, callback) => {
    try {
      const room = rooms.get(pin);
      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      if (room.gameState !== 'ASKING') {
        return callback({ success: false, error: 'Not in asking phase' });
      }

      const result = room.submitAnswer(playerId, answerIndex);

      // Broadcast that player answered (don't reveal correct/wrong yet)
      io.to(pin).emit('quiz:answered', {
        playerId,
        players: room.getPlayersState()
      });

      // Check if should end question
      if (result.shouldEndQuestion) {
        stopQuizTimer(pin);
        handleQuestionEnd(pin, room, result.reason);
      }

      callback({ success: true });
    } catch (error) {
      console.error('Error submitting answer:', error);
      callback({ success: false, error: error.message });
    }
  });

  // =========================================================================
  // KEY WALL PHASE (Issue #3)
  // =========================================================================

  // Claim key
  socket.on('keywall:claim', ({ pin, playerId, keyId }, callback) => {
    try {
      const room = rooms.get(pin);
      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      if (room.gameState !== 'KEY_WALL') {
        return callback({ success: false, error: 'Not in key wall phase' });
      }

      const result = room.claimKey(playerId, keyId);

      // Broadcast claim
      io.to(pin).emit('keywall:claimed', {
        keyId,
        gender: result.gender,
        playerId,
        auto: false,
        ...room.getCurrentPhaseState()
      });

      // Advance turn
      room.advanceTurn('claimed');

      // Check if wall ended
      if (room.gameState === 'RESULTS_COMPARISON') {
        stopKeyWallTimer(pin);
        handleKeyWallEnd(pin, room);
      } else {
        // Emit new turn
        io.to(pin).emit('keywall:turn', {
          currentTurnPlayerId: room.turnQueue[room.currentTurnPlayerIndex],
          remainingMs: room.currentTurnDeadlineMs - Date.now()
        });
      }

      callback({ success: true, gender: result.gender });
    } catch (error) {
      console.error('Error claiming key:', error);
      callback({ success: false, error: error.message });
    }
  });

  // =========================================================================
  // RESULTS PHASE (Issue #4)
  // =========================================================================

  // Host can manually advance from comparison to winner (optional)
  socket.on('results:show-winner', ({ pin }, callback) => {
    try {
      const room = rooms.get(pin);
      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      if (socket.id !== room.adminSocketId) {
        return callback({ success: false, error: 'Only admin can advance' });
      }

      if (room.gameState !== 'RESULTS_COMPARISON') {
        return callback({ success: false, error: 'Not in comparison phase' });
      }

      room.advanceToWinner();
      const winners = room.calculateWinners();

      io.to(pin).emit('results:winner', winners);

      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // =========================================================================
  // DISCONNECT HANDLER (Issue #2)
  // =========================================================================

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);

    // Clean up rooms where this socket was admin or player
    for (const [pin, room] of rooms.entries()) {
      if (room.adminSocketId === socket.id) {
        // Admin disconnected - notify players and close room
        io.to(pin).emit('admin-disconnected');
        stopQuizTimer(pin);
        stopKeyWallTimer(pin);
        rooms.delete(pin);
        console.log(`Room ${pin} closed - admin disconnected`);
      } else {
        // Issue #2: Mark player as disconnected, DON'T remove them
        const player = room.disconnectPlayer(socket.id);
        if (player) {
          io.to(pin).emit('player-disconnected', {
            playerId: player.id,
            playerName: player.name,
            players: room.getPlayersState()
          });
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🚀 Gender Reveal Game Server running on port ${PORT}`);
  console.log(`📱 Ready for multiplayer connections!`);
  console.log(`🔒 Reconnection & anti-stall systems active`);
});
