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

// Store active game rooms
const rooms = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

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

      io.to(pin).emit('quiz-started', {
        gameState: room.gameState,
        currentQuestion: room.getCurrentQuestion(),
        currentPlayerIndex: room.currentPlayerIndex,
        players: room.players
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

      io.to(pin).emit('answer-submitted', {
        playerId,
        answerIndex,
        isCorrect: result.isCorrect,
        correctAnswer: result.correctAnswer,
        players: room.players,
        phase: room.quizPhase
      });

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
