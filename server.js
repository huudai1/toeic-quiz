const express = require("express");
const { WebSocketServer } = require("ws");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const path = require("path");
const fs = require("fs").promises;
const fsSync = require("fs");
const archiver = require("archiver");
const unzipper = require("unzipper");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public", {
  index: "index.html",
  setHeaders: (res, path) => {
    console.log(`Serving file: ${path}`);
  }
}));

const quizzesFile = path.join(__dirname, "quizzes.json");
const resultsFile = path.join(__dirname, "results.json");

let quizzes = [];
let currentQuiz = null;
let results = [];
let clients = new Set();

// Ensure directories exist
const ensureDirectories = async () => {
  const directories = [
    path.join(__dirname, "public/uploads/audio"),
    path.join(__dirname, "public/uploads/images"),
    path.join(__dirname, "temp")
  ];
  for (const dir of directories) {
    try {
      if (!fsSync.existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
      }
    } catch (err) {
      console.error(`Error creating directory ${dir}:`, err);
    }
  }
};

ensureDirectories();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.mimetype.startsWith("audio/")) {
      cb(null, "public/uploads/audio");
    } else if (file.mimetype.startsWith("image/")) {
      cb(null, "public/uploads/images");
    } else {
      cb(null, "temp");
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({ storage });

async function saveQuizzes() {
  try {
    await fs.writeFile(quizzesFile, JSON.stringify(quizzes, null, 2));
  } catch (err) {
    console.error("Error saving quizzes:", err);
  }
}

async function loadQuizzes() {
  try {
    if (fsSync.existsSync(quizzesFile)) {
      const data = await fs.readFile(quizzesFile, "utf8");
      quizzes = JSON.parse(data);
    } else {
      quizzes = [];
      await saveQuizzes();
    }
  } catch (err) {
    console.error("Error loading quizzes:", err);
    quizzes = [];
  }
}

async function saveResults() {
  try {
    await fs.writeFile(resultsFile, JSON.stringify(results, null, 2));
  } catch (err) {
    console.error("Error saving results:", err);
  }
}

async function loadResults() {
  try {
    if (fsSync.existsSync(resultsFile)) {
      const data = await fs.readFile(resultsFile, "utf8");
      results = JSON.parse(data);
    } else {
      results = [];
      await saveResults();
    }
  } catch (err) {
    console.error("Error loading results:", err);
    results = [];
  }
}

loadQuizzes();
loadResults();

app.get('/quizzes', async (req, res) => {
  const email = req.query.email;
  if (email) {
    res.json(quizzes.filter((quiz) => quiz.createdBy === email));
  } else {
    if (!currentQuiz) {
      res.json([]);
    } else {
      res.json([currentQuiz]);
    }
  }
});

app.post(
  '/save-quiz',
  upload.fields([
    { name: 'audio-part1', maxCount: 1 },
    { name: 'audio-part2', maxCount: 1 },
    { name: 'audio-part3', maxCount: 1 },
    { name: 'audio-part4', maxCount: 1 },
    { name: 'images-part1' },
    { name: 'images-part2' },
    { name: 'images-part3' },
    { name: 'images-part4' },
    { name: 'images-part5' },
    { name: 'images-part6' },
    { name: 'images-part7' },
  ]),
  async (req, res) => {
    try {
      const { quizName, answerKey, createdBy } = req.body;
      if (!quizName || !answerKey || !createdBy) {
        return res.status(400).json({ message: "Missing required fields" });
      }
      const audioPaths = {};
      for (let i = 1; i <= 4; i++) {
        if (req.files[`audio-part${i}`]) {
          const audioFile = req.files[`audio-part${i}`][0];
          audioPaths[`part${i}`] = `/uploads/audio/${audioFile.filename}`;
        }
      }

      const images = {};
      for (let i = 1; i <= 7; i++) {
        const partImages = req.files[`images-part${i}`] || [];
        images[`part${i}`] = partImages.map((file) => `/uploads/images/${file.filename}`);
      }

      const quiz = {
        quizId: uuidv4(),
        quizName,
        audio: audioPaths,
        images,
        answerKey: JSON.parse(answerKey),
        createdBy,
      };

      quizzes.push(quiz);
      await saveQuizzes();
      res.json({ message: 'Quiz saved successfully!' });
    } catch (err) {
      console.error('Error saving quiz:', err);
      res.status(500).json({ message: 'Error saving quiz' });
    }
  }
);

app.delete('/delete-quiz/:quizId', async (req, res) => {
  try {
    const quizId = req.params.quizId;
    const quizIndex = quizzes.findIndex((quiz) => quiz.quizId === quizId);
    if (quizIndex === -1) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    const quiz = quizzes[quizIndex];
    for (let part in quiz.audio) {
      const audioPath = path.join(__dirname, 'public', quiz.audio[part].substring(1));
      try {
        if (fsSync.existsSync(audioPath)) {
          await fs.unlink(audioPath);
        }
      } catch (err) {
        console.error(`Error deleting audio file ${audioPath}:`, err);
      }
    }

    for (let part in quiz.images) {
      for (let imagePath of quiz.images[part]) {
        const fullPath = path.join(__dirname, 'public', imagePath.substring(1));
        try {
          if (fsSync.existsSync(fullPath)) {
            await fs.unlink(fullPath);
          }
        } catch (err) {
          console.error(`Error deleting image file ${fullPath}:`, err);
        }
      }
    }

    quizzes.splice(quizIndex, 1);
    if (currentQuiz && currentQuiz.quizId === quizId) {
      currentQuiz = null;
      broadcast({ type: 'quizStatus', quizExists: false });
    }
    await saveQuizzes();
    res.json({ message: 'Quiz deleted successfully!' });
  } catch (err) {
    console.error('Error deleting quiz:', err);
    res.status(500).json({ message: 'Error deleting quiz' });
  }
});

app.get('/download-quiz-zip/:quizId', async (req, res) => {
  try {
    const quizId = req.params.quizId;
    const quiz = quizzes.find((q) => q.quizId === quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    const zip = archiver('zip', { zlib: { level: 9 } });
    res.attachment(`quiz_${quizId}.zip`);
    zip.pipe(res);

    // Add quizzes.json to key folder
    const quizJson = JSON.stringify(quiz, null, 2);
    zip.append(quizJson, { name: 'key/quizzes.json' });

    // Add audio files
    for (let i = 1; i <= 4; i++) {
      const audioPath = quiz.audio[`part${i}`];
      if (audioPath) {
        const fullPath = path.join(__dirname, 'public', audioPath.substring(1));
        if (fsSync.existsSync(fullPath)) {
          zip.file(fullPath, { name: `part${i}/audio/part${i}.mp3` });
        }
      }
    }

    // Add image files
    for (let i = 1; i <= 7; i++) {
      const images = quiz.images[`part${i}`] || [];
      for (let imagePath of images) {
        const fullPath = path.join(__dirname, 'public', imagePath.substring(1));
        if (fsSync.existsSync(fullPath)) {
          zip.file(fullPath, { name: `part${i}/images/${path.basename(imagePath)}` });
        }
      }
    }

    await zip.finalize();
  } catch (err) {
    console.error('Error creating ZIP:', err);
    res.status(500).json({ message: 'Error creating ZIP file' });
  }
});

app.post(
  '/upload-quizzes-zip',
  upload.single('quizzes'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: 'No ZIP file uploaded' });
      }

      const zipPath = req.file.path;
      const extractPath = path.join(__dirname, 'temp', uuidv4());
      await fs.mkdir(extractPath, { recursive: true });

      // Extract ZIP
      await new Promise((resolve, reject) => {
        fsSync.createReadStream(zipPath)
          .pipe(unzipper.Extract({ path: extractPath }))
          .on('close', resolve)
          .on('error', reject);
      });

      // Read quizzes.json
      const quizzesJsonPath = path.join(extractPath, 'key', 'quizzes.json');
      if (!fsSync.existsSync(quizzesJsonPath)) {
        await fs.rm(extractPath, { recursive: true, force: true });
        await fs.unlink(zipPath);
        return res.status(400).json({ message: 'Missing key/quizzes.json in ZIP' });
      }

      const quizData = JSON.parse(await fs.readFile(quizzesJsonPath, 'utf8'));
      const newQuizId = uuidv4();
      quizData.quizId = newQuizId;

      // Process audio files
      for (let i = 1; i <= 4; i++) {
        const audioSrcPath = path.join(extractPath, `part${i}`, 'audio', `part${i}.mp3`);
        if (fsSync.existsSync(audioSrcPath)) {
          const audioDestPath = path.join(__dirname, 'public/uploads/audio', `${newQuizId}_part${i}.mp3`);
          await fs.copyFile(audioSrcPath, audioDestPath);
          quizData.audio[`part${i}`] = `/uploads/audio/${path.basename(audioDestPath)}`;
        } else {
          delete quizData.audio[`part${i}`];
        }
      }

      // Process image files
      for (let i = 1; i <= 7; i++) {
        const imagesDir = path.join(extractPath, `part${i}`, 'images');
        quizData.images[`part${i}`] = [];
        if (fsSync.existsSync(imagesDir)) {
          const imageFiles = await fs.readdir(imagesDir);
          for (const imageFile of imageFiles) {
            const imageSrcPath = path.join(imagesDir, imageFile);
            const imageDestPath = path.join(__dirname, 'public/uploads/images', `${newQuizId}_part${i}_${imageFile}`);
            await fs.copyFile(imageSrcPath, imageDestPath);
            quizData.images[`part${i}`].push(`/uploads/images/${path.basename(imageDestPath)}`);
          }
        }
      }

      // Add quiz to quizzes array
      quizzes.push(quizData);
      await saveQuizzes();

      // Cleanup
      await fs.rm(extractPath, { recursive: true, force: true });
      await fs.unlink(zipPath);

      res.json({ message: 'Quiz uploaded successfully!' });
    } catch (err) {
      console.error('Error uploading ZIP:', err);
      res.status(500).json({ message: 'Error uploading ZIP file' });
    }
  }
);

app.post('/select-quiz', (req, res) => {
  const { quizId } = req.body;
  if (!quizId) {
    return res.status(400).json({ message: 'Quiz ID is required' });
  }
  const quiz = quizzes.find((q) => q.quizId === quizId);
  if (!quiz) {
    return res.status(404).json({ message: 'Quiz not found' });
  }
  currentQuiz = quiz;
  broadcast({ type: 'quizStatus', quizExists: true });
  res.json({ message: 'Quiz selected successfully!' });
});

app.get('/quiz-audio', (req, res) => {
  if (!currentQuiz || !currentQuiz.audio) {
    return res.status(404).json({ message: 'No audio available' });
  }
  const part = req.query.part || 'part1';
  res.json({ audio: currentQuiz.audio[part] });
});

app.get('/images', (req, res) => {
  if (!currentQuiz) {
    return res.status(404).json({ message: 'No quiz selected' });
  }
  const part = req.query.part || 1;
  res.json(currentQuiz.images[`part${part}`] || []);
});

app.post('/submit', async (req, res) => {
  if (!currentQuiz) {
    return res.status(404).json({ message: 'No quiz selected' });
  }

  const { username, answers } = req.body;
  if (!username || !answers) {
    return res.status(400).json({ message: 'Username and answers are required' });
  }
  let score = 0;
  const answerKey = currentQuiz.answerKey;

  for (let i = 1; i <= 200; i++) {
    const userAnswer = answers[`q${i}`];
    const correctAnswer = answerKey[`q${i}`];
    if (userAnswer && userAnswer === correctAnswer) {
      score++;
    }
  }

  const result = { username, score, timestamp: Date.now() };
  results.push(result);
  await saveResults();
  broadcast({ type: 'submittedCount', count: results.length });
  res.json({ score });
});

app.get('/results', (req, res) => {
  res.json(results);
});

app.post('/reset', async (req, res) => {
  results = [];
  await saveResults();
  broadcast({ type: 'submittedCount', count: 0 });
  res.json({ message: 'Quiz reset successfully!' });
});

app.get('/download-quizzes', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename=quizzes.json');
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(quizzes, null, 2));
});

app.post(
  '/upload-quizzes',
  upload.fields([{ name: 'quizzes', maxCount: 1 }]),
  async (req, res) => {
    try {
      if (!req.files.quizzes) {
        return res.status(400).json({ message: 'No quizzes.json file uploaded' });
      }
      const file = req.files.quizzes[0];
      const data = await fs.readFile(file.path, 'utf8');
      const uploadedQuizzes = JSON.parse(data);
      quizzes = uploadedQuizzes;
      await saveQuizzes();
      await fs.unlink(file.path);
      res.json({ message: 'Quizzes uploaded successfully!' });
    } catch (err) {
      console.error('Error uploading quizzes:', err);
      res.status(500).json({ message: 'Error uploading quizzes' });
    }
  }
);

app.post(
  '/upload-files',
  upload.fields([
    { name: 'audio', maxCount: 100 },
    { name: 'images', maxCount: 100 },
  ]),
  async (req, res) => {
    try {
      const audioFiles = req.files.audio || [];
      const imageFiles = req.files.images || [];
      const audioPaths = audioFiles.map((file) => `/uploads/audio/${file.filename}`);
      const imagePaths = imageFiles.map((file) => `/uploads/images/${file.filename}`);
      res.json({ audio: audioPaths, images: imagePaths });
    } catch (err) {
      console.error('Error uploading files:', err);
      res.status(500).json({ message: 'Error uploading files' });
    }
  }
);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) {
      console.error('Error serving index.html:', err);
      res.status(500).send('Internal Server Error');
    }
  });
});

function broadcast(message) {
  clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(message));
    }
  });
}

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  clients.add(ws);
  broadcast({ type: 'participantCount', count: clients.size });
  broadcast({ type: 'submittedCount', count: results.length });
  if (currentQuiz) {
    ws.send(JSON.stringify({ type: 'quizStatus', quizExists: true }));
  }

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'start') {
        broadcast({ type: 'start', timeLimit: msg.timeLimit });
      } else if (msg.type === 'end') {
        broadcast({ type: 'end' });
      } else if (msg.type === 'submitted') {
        broadcast({ type: 'submitted', username: msg.username });
      }
    } catch (err) {
      console.error('Error processing WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    broadcast({ type: 'participantCount', count: clients.size });
  });
});