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
const roomTimers = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

// Timer management for quiz rooms
function startRoomTimer(pin, room) {
  // Clear existing timer if any
  if (roomTimers.has(pin)) {
    clearInterval(roomTimers.get(pin));
  }

  const timer = setInterval(() => {
    if (!rooms.has(pin)) {
      clearInterval(timer);
      roomTimers.delete(pin);
      return;
    }

    room.timeLeft -= 1;

    // Emit timer update
    io.to(pin).emit('timer-update', {
      timeLeft: room.timeLeft,
      quizPhase: room.quizPhase
    });

    // Check if timer expired
    if (room.timeLeft <= 0) {
      const result = room.timerExpired();

      if (result.openedToAll) {
        // Opened to all players
        io.to(pin).emit('opened-to-all', {
          quizPhase: room.quizPhase,
          timeLeft: room.timeLeft
        });
      } else if (result.skipQuestion) {
        // No one answered, move to next question
        const nextResult = room.nextQuestion();

        if (nextResult.quizFinished) {
          clearInterval(timer);
          roomTimers.delete(pin);
          io.to(pin).emit('quiz-finished', {
            gameState: room.gameState,
            players: room.players
          });
        } else {
          io.to(pin).emit('next-question', {
            currentQuestion: room.getCurrentQuestion(),
            currentPlayerIndex: room.currentPlayerIndex,
            currentQuestionIndex: room.currentQuestionIndex,
            currentAnswerer: room.currentAnswerer,
            players: room.players,
            quizPhase: room.quizPhase,
            timeLeft: room.timeLeft
          });
        }
      }
    }
  }, 1000);

  roomTimers.set(pin, timer);
}

function stopRoomTimer(pin) {
  if (roomTimers.has(pin)) {
    clearInterval(roomTimers.get(pin));
    roomTimers.delete(pin);
  }
}

// Socket.io connection handler
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

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

      if (room.players.length >= room.config.numPlayers) {
        return callback({ success: false, error: 'Room is full' });
      }

      const player = room.addPlayer(socket.id, playerName);
      socket.join(pin);

      console.log(`Player ${playerName} joined room ${pin}`);

      // Notify all players in room
      io.to(pin).emit('player-joined', {
        player,
        players: room.players,
        room: room.getState()
      });

      callback({
        success: true,
        player,
        room: room.getState()
      });
    } catch (error) {
      console.error('Error joining room:', error);
      callback({ success: false, error: error.message });
    }
  });

  // Player ready toggle
  socket.on('player-ready', ({ pin, playerId }, callback) => {
    try {
      const room = rooms.get(pin);
      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      room.togglePlayerReady(playerId);

      io.to(pin).emit('player-ready-changed', {
        players: room.players,
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

      // Check if there are any players
      if (room.players.length === 0) {
        return callback({ success: false, error: 'No players in room' });
      }

      room.startQuiz();

      // Start timer for this room
      startRoomTimer(pin, room);

      io.to(pin).emit('quiz-started', {
        gameState: room.gameState,
        currentQuestion: room.getCurrentQuestion(),
        currentPlayerIndex: room.currentPlayerIndex,
        currentAnswerer: room.currentAnswerer,
        players: room.players,
        quizPhase: room.quizPhase,
        timeLeft: room.timeLeft
      });

      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Player buzzes in to answer
  socket.on('buzz-in', ({ pin, playerId }, callback) => {
    try {
      const room = rooms.get(pin);
      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      const result = room.buzzIn(playerId);

      if (result.success) {
        io.to(pin).emit('player-buzzed', {
          playerId,
          playerName: result.playerName,
          phase: room.quizPhase
        });
      }

      callback(result);
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Submit answer
  socket.on('submit-answer', ({ pin, playerId, answerIndex }, callback) => {
    try {
      const room = rooms.get(pin);
      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      const result = room.submitAnswer(playerId, answerIndex);

      // Stop timer temporarily
      stopRoomTimer(pin);

      io.to(pin).emit('answer-submitted', {
        playerId,
        answerIndex,
        isCorrect: result.isCorrect,
        correctAnswer: result.correctAnswer,
        players: room.players,
        phase: room.quizPhase
      });

      // Move to next question after 3 seconds
      setTimeout(() => {
        const nextResult = room.nextQuestion();

        if (nextResult.quizFinished) {
          io.to(pin).emit('quiz-finished', {
            gameState: room.gameState,
            players: room.players
          });
        } else {
          io.to(pin).emit('next-question', {
            currentQuestion: room.getCurrentQuestion(),
            currentPlayerIndex: room.currentPlayerIndex,
            currentQuestionIndex: room.currentQuestionIndex,
            currentAnswerer: room.currentAnswerer,
            players: room.players,
            quizPhase: room.quizPhase,
            timeLeft: room.timeLeft
          });

          // Restart timer for next question
          startRoomTimer(pin, room);
        }
      }, 3000);

      callback({ success: true, isCorrect: result.isCorrect });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Next question
  socket.on('next-question', ({ pin }, callback) => {
    try {
      const room = rooms.get(pin);
      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      const result = room.nextQuestion();

      if (result.quizFinished) {
        io.to(pin).emit('quiz-finished', {
          gameState: room.gameState,
          players: room.players
        });
      } else {
        io.to(pin).emit('next-question', {
          currentQuestion: room.getCurrentQuestion(),
          currentPlayerIndex: room.currentPlayerIndex,
          currentQuestionIndex: room.currentQuestionIndex,
          players: room.players
        });
      }

      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Open circle on board
  socket.on('open-circle', ({ pin, playerId, circleIndex }, callback) => {
    try {
      const room = rooms.get(pin);
      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      const result = room.openCircle(playerId, circleIndex);

      io.to(pin).emit('circle-opened', {
        circleIndex,
        gender: result.gender,
        playerId,
        openedCircles: room.openedCircles,
        players: room.players,
        counts: room.getCircleCounts()
      });

      callback({ success: true, gender: result.gender });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Next player turn
  socket.on('next-player-turn', ({ pin }, callback) => {
    try {
      const room = rooms.get(pin);
      if (!room) {
        return callback({ success: false, error: 'Room not found' });
      }

      const result = room.nextPlayerTurn();

      if (result.gameFinished) {
        const winner = room.calculateWinner();
        io.to(pin).emit('game-finished', {
          gameState: room.gameState,
          winner,
          players: room.players,
          babyGender: room.config.babyGender
        });
      } else {
        io.to(pin).emit('player-turn-changed', {
          currentPlayerIndex: room.currentPlayerIndex,
          players: room.players
        });
      }

      callback({ success: true });
    } catch (error) {
      callback({ success: false, error: error.message });
    }
  });

  // Disconnect handler
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);

    // Clean up rooms where this socket was admin or player
    for (const [pin, room] of rooms.entries()) {
      if (room.adminSocketId === socket.id) {
        // Admin disconnected - notify players and close room
        io.to(pin).emit('admin-disconnected');
        stopRoomTimer(pin);
        rooms.delete(pin);
        console.log(`Room ${pin} closed - admin disconnected`);
      } else {
        // Check if player disconnected
        const player = room.players.find(p => p.socketId === socket.id);
        if (player) {
          room.removePlayer(player.id);
          io.to(pin).emit('player-left', {
            playerId: player.id,
            playerName: player.name,
            players: room.players
          });
          console.log(`Player ${player.name} left room ${pin}`);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🚀 Gender Reveal Game Server running on port ${PORT}`);
  console.log(`📱 Ready for multiplayer connections!`);
});
