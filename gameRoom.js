class GameRoom {
  constructor(config) {
    this.pin = this.generatePin();
    this.config = config; // { babyGender, numPlayers, numQuestions, timerSeconds, boardSize, questions }
    this.adminSocketId = null;
    this.players = [];
    this.gameState = 'LOBBY';

    // Quiz state
    this.currentQuestionIndex = 0;
    this.currentPlayerIndex = 0;
    this.quizPhase = 'waiting'; // 'waiting', 'answering', 'open_for_all', 'result'
    this.currentAnswerer = null;
    this.timeLeft = config.timerSeconds || 40;

    // Board state
    this.boardLayout = this.generateBoardLayout();
    this.openedCircles = [];

    this.createdAt = Date.now();
  }

  generatePin() {
    // Generate 6-digit PIN
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  generateBoardLayout() {
    const { boardSize, babyGender } = this.config;

    // 60-70% should be the baby's actual gender
    const dominantCount = Math.floor(boardSize * (0.6 + Math.random() * 0.1));
    const minorCount = boardSize - dominantCount;

    const layout = [
      ...Array(dominantCount).fill(babyGender),
      ...Array(minorCount).fill(babyGender === 'boy' ? 'girl' : 'boy')
    ];

    // Shuffle
    for (let i = layout.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [layout[i], layout[j]] = [layout[j], layout[i]];
    }

    return layout;
  }

  addPlayer(socketId, name) {
    const player = {
      id: Date.now() + Math.random(),
      socketId,
      name,
      ready: false,
      keys: 0,
      score: 0,
      circlesOpened: []
    };

    this.players.push(player);
    return player;
  }

  removePlayer(playerId) {
    this.players = this.players.filter(p => p.id !== playerId);
  }

  togglePlayerReady(playerId) {
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      player.ready = !player.ready;
    }
  }

  areAllPlayersReady() {
    return this.players.length > 0 &&
           this.players.length === this.config.numPlayers &&
           this.players.every(p => p.ready);
  }

  startQuiz() {
    this.gameState = 'QUIZ_QUESTION';
    this.currentQuestionIndex = 0;
    this.currentPlayerIndex = 0;
    this.quizPhase = 'waiting';
    this.timeLeft = this.config.timerSeconds;
  }

  getCurrentQuestion() {
    return this.config.questions[this.currentQuestionIndex];
  }

  buzzIn(playerId) {
    // Check if it's this player's turn or if question is open for all
    const currentPlayer = this.players[this.currentPlayerIndex];

    if (this.quizPhase === 'waiting' && currentPlayer.id === playerId) {
      // It's their turn
      this.quizPhase = 'answering';
      this.currentAnswerer = playerId;
      return {
        success: true,
        playerName: currentPlayer.name
      };
    }

    if (this.quizPhase === 'open_for_all') {
      // First to buzz in gets to answer
      const player = this.players.find(p => p.id === playerId);
      if (player) {
        this.quizPhase = 'answering';
        this.currentAnswerer = playerId;
        return {
          success: true,
          playerName: player.name
        };
      }
    }

    return {
      success: false,
      error: 'Not your turn or question not open'
    };
  }

  submitAnswer(playerId, answerIndex) {
    const question = this.getCurrentQuestion();
    const isCorrect = answerIndex === question.correct;

    if (isCorrect) {
      // Award key to player
      const player = this.players.find(p => p.id === playerId);
      if (player) {
        player.keys += 1;
        player.score += 1;
      }
      this.quizPhase = 'result';
    } else {
      // Wrong answer - open for all
      this.quizPhase = 'open_for_all';
      this.currentAnswerer = null;
    }

    return {
      isCorrect,
      correctAnswer: question.correct
    };
  }

  nextQuestion() {
    this.currentQuestionIndex += 1;

    if (this.currentQuestionIndex >= this.config.questions.length) {
      // Quiz finished
      this.gameState = 'BOARD_INTRO';
      this.currentPlayerIndex = 0;
      return { quizFinished: true };
    }

    // Next question
    this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
    this.quizPhase = 'waiting';
    this.currentAnswerer = null;
    this.timeLeft = this.config.timerSeconds;

    return { quizFinished: false };
  }

  openCircle(playerId, circleIndex) {
    if (this.openedCircles.includes(circleIndex)) {
      throw new Error('Circle already opened');
    }

    const player = this.players.find(p => p.id === playerId);
    if (!player) {
      throw new Error('Player not found');
    }

    if (player.keys <= 0) {
      throw new Error('No keys available');
    }

    const gender = this.boardLayout[circleIndex];

    player.keys -= 1;
    player.circlesOpened.push({ index: circleIndex, gender });
    this.openedCircles.push(circleIndex);
    this.gameState = 'BOARD_OPENED';

    return { gender };
  }

  getCircleCounts() {
    let boyCount = 0;
    let girlCount = 0;

    this.openedCircles.forEach(index => {
      if (this.boardLayout[index] === 'boy') {
        boyCount++;
      } else {
        girlCount++;
      }
    });

    return { boyCount, girlCount };
  }

  nextPlayerTurn() {
    const currentPlayer = this.players[this.currentPlayerIndex];

    // Check if current player has more keys
    if (currentPlayer.keys > 0) {
      this.gameState = 'BOARD_PLAYER_TURN';
      return { gameFinished: false };
    }

    // Find next player with keys
    let nextIndex = (this.currentPlayerIndex + 1) % this.players.length;
    let cycles = 0;

    while (cycles < this.players.length) {
      if (this.players[nextIndex].keys > 0) {
        this.currentPlayerIndex = nextIndex;
        this.gameState = 'BOARD_PLAYER_TURN';
        return { gameFinished: false };
      }
      nextIndex = (nextIndex + 1) % this.players.length;
      cycles++;
    }

    // No more keys - game finished
    this.gameState = 'REVEAL_SUSPENSE';
    return { gameFinished: true };
  }

  calculateWinner() {
    const { babyGender } = this.config;

    const playersWithScores = this.players.map(player => {
      const correctCircles = player.circlesOpened.filter(
        circle => circle.gender === babyGender
      ).length;
      return { ...player, correctCircles };
    });

    const winner = playersWithScores.reduce((max, player) =>
      player.correctCircles > max.correctCircles ? player : max
    );

    return { winner, playersWithScores };
  }

  getState() {
    return {
      pin: this.pin,
      gameState: this.gameState,
      config: {
        numPlayers: this.config.numPlayers,
        numQuestions: this.config.numQuestions,
        timerSeconds: this.config.timerSeconds,
        boardSize: this.config.boardSize
        // babyGender is NOT exposed to clients
      },
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        ready: p.ready,
        keys: p.keys,
        score: p.score
        // socketId is NOT exposed
        // circlesOpened is NOT exposed until reveal
      })),
      currentQuestionIndex: this.currentQuestionIndex,
      currentPlayerIndex: this.currentPlayerIndex,
      quizPhase: this.quizPhase,
      openedCircles: this.openedCircles,
      circleCounts: this.getCircleCounts()
    };
  }
}

module.exports = GameRoom;
