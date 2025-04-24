const express = require('express');
const ws = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const app = express();

// Serve static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.json());

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'audio') {
      cb(null, 'uploads/audio/');
    } else {
      cb(null, 'uploads/images/');
    }
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// Ensure upload directories exist
const ensureDir = async (dir) => {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    console.error(`Error creating directory ${dir}:`, err);
  }
};
ensureDir('uploads/audio');
ensureDir('uploads/images');

// File to store quizzes
const QUIZZES_FILE = 'quizzes.json';

// Load quizzes from file
let quizzes = [];
const loadQuizzes = async () => {
  try {
    const data = await fs.readFile(QUIZZES_FILE, 'utf8');
    quizzes = JSON.parse(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      quizzes = [];
      await saveQuizzes();
    } else {
      console.error('Error loading quizzes:', err);
    }
  }
};
const saveQuizzes = async () => {
  await fs.writeFile(QUIZZES_FILE, JSON.stringify(quizzes, null, 2));
};

// Initialize quizzes
loadQuizzes();

// Quiz state
let currentQuizId = null;
let submissions = [];
let clients = new Set();

// WebSocket server
const wss = new ws.Server({ noServer: true });
wss.on('connection', (socket) => {
  clients.add(socket);
  socket.send(JSON.stringify({ type: 'participantCount', count: clients.size }));
  socket.send(JSON.stringify({ type: 'submittedCount', count: submissions.length }));

  socket.on('message', (message) => {
    const msg = JSON.parse(message);
    if (msg.type === 'start') {
      wss.clients.forEach(client => client.send(JSON.stringify({ type: 'start' })));
    }
    if (msg.type === 'end') {
      wss.clients.forEach(client => client.send(JSON.stringify({ type: 'end' })));
    }
    if (msg.type === 'submitted') {
      submissions.push({ username: msg.username, timestamp: Date.now() });
      wss.clients.forEach(client => {
        client.send(JSON.stringify({ type: 'submitted', username: msg.username }));
        client.send(JSON.stringify({ type: 'submittedCount', count: submissions.length }));
      });
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
    wss.clients.forEach(client => client.send(JSON.stringify({ type: 'participantCount', count: clients.size })));
  });
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

app.get('/quiz-status', (req, res) => {
  res.json({ quizExists: currentQuizId !== null });
});

app.get('/quizzes', async (req, res) => {
  await loadQuizzes();
  res.json(quizzes.map(quiz => ({ quizId: quiz.quizId })));
});

app.post('/select-quiz', (req, res) => {
  const { quizId } = req.body;
  const quiz = quizzes.find(q => q.quizId === quizId);
  if (!quiz) {
    return res.status(404).json({ message: 'Quiz not found' });
  }
  currentQuizId = quizId;
  res.json({ message: 'Quiz selected' });
});

app.post('/save-quiz', upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'images-part1' },
  { name: 'images-part2' },
  { name: 'images-part3' },
  { name: 'images-part4' },
  { name: 'images-part5' },
  { name: 'images-part6' },
  { name: 'images-part7' },
]), async (req, res) => {
  const quizId = Date.now().toString();
  const quiz = { quizId, audio: '', images: {}, answerKey: {} };

  if (req.files['audio']) {
    quiz.audio = `/uploads/audio/${req.files['audio'][0].filename}`;
  }

  for (let i = 1; i <= 7; i++) {
    const partKey = `images-part${i}`;
    if (req.files[partKey]) {
      quiz.images[`part${i}`] = req.files[partKey].map(file => `/uploads/images/${file.filename}`);
    }
  }

  if (req.body.answerKey) {
    quiz.answerKey = JSON.parse(req.body.answerKey);
  }

  quizzes.push(quiz);
  await saveQuizzes();

  res.json({ message: 'Quiz saved successfully' });
});

app.get('/images', (req, res) => {
  const part = req.query.part;
  const quiz = quizzes.find(q => q.quizId === currentQuizId);
  if (!quiz || !quiz.images[`part${part}`]) {
    return res.json([]);
  }
  res.json(quiz.images[`part${part}`]);
});

app.post('/submit', (req, res) => {
  const { username, answers } = req.body;
  const quiz = quizzes.find(q => q.quizId === currentQuizId);
  if (!quiz) {
    return res.status(404).json({ message: 'Quiz not found' });
  }

  let score = 0;
  for (const [question, correctAnswer] of Object.entries(quiz.answerKey)) {
    if (answers[question] === correctAnswer) score++;
  }

  submissions.push({ username, score, timestamp: Date.now() });
  res.json({ score });
});

app.get('/results', (req, res) => {
  res.json(submissions);
});

app.post('/reset', (req, res) => {
  submissions = [];
  wss.clients.forEach(client => client.send(JSON.stringify({ type: 'submittedCount', count: submissions.length })));
  res.json({ message: 'Quiz reset successfully' });
});

// Start server
const server = app.listen(3000, () => console.log('Server running on port 3000'));

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});