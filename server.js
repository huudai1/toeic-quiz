const express = require('express');
const { Server } = require('ws');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}-${file.originalname}`);
  },
});
const upload = multer({ storage });

mongoose.connect('mongodb://localhost:27017/quiz_app', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('MongoDB connection error:', err);
});

const quizSchema = new mongoose.Schema({
  quizId: String,
  quizName: String,
  createdBy: String,
  audio: [String],
  images: { type: Map, of: [String] },
  answerKey: { type: Map, of: String },
  isAssigned: { type: Boolean, default: false },
  timeLimit: { type: Number, default: 7200 },
});
const Quiz = mongoose.model('Quiz', quizSchema);

const resultSchema = new mongoose.Schema({
  quizId: String,
  username: String,
  answers: { type: Map, of: String },
  score: Number,
  submittedAt: Date,
});
const Result = mongoose.model('Result', resultSchema);

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const wss = new Server({ server });
let currentQuizId = null;
let currentQuizName = null;
let timeLimit = 7200;
const clients = new Map();

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients.set(clientId, { ws, username: null });

  ws.send(JSON.stringify({
    type: 'quizStatus',
    quizId: currentQuizId,
    quizName: currentQuizName,
  }));

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'login') {
        clients.set(clientId, { ws, username: data.username });
        updateParticipantCount();
      } else if (data.type === 'quizSelected') {
        currentQuizId = data.quizId;
        const quiz = await Quiz.findOne({ quizId: data.quizId });
        currentQuizName = quiz ? quiz.quizName : null;
        broadcast({
          type: 'quizStatus',
          quizId: currentQuizId,
          quizName: currentQuizName,
        });
      } else if (data.type === 'quizAssigned') {
        currentQuizId = data.quizId;
        timeLimit = data.timeLimit || 7200;
        const quiz = await Quiz.findOne({ quizId: data.quizId });
        if (quiz) {
          quiz.isAssigned = true;
          quiz.timeLimit = timeLimit;
          await quiz.save();
          currentQuizName = quiz.quizName;
          broadcast({
            type: 'quizStatus',
            quizId: currentQuizId,
            quizName: currentQuizName,
          });
        }
      } else if (data.type === 'start') {
        timeLimit = data.timeLimit || 7200;
        broadcast({ type: 'start', timeLimit });
        updateParticipantCount();
      } else if (data.type === 'end') {
        broadcast({ type: 'end' });
        await broadcastResults();
      } else if (data.type === 'submitted') {
        await broadcastResults();
      } else if (data.type === 'requestQuizStatus') {
        ws.send(JSON.stringify({
          type: 'quizStatus',
          quizId: currentQuizId,
          quizName: currentQuizName,
        }));
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    clients.delete(clientId);
    updateParticipantCount();
  });
});

function broadcast(message) {
  clients.forEach(client => {
    if (client.ws.readyState === client.ws.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  });
}

async function updateParticipantCount() {
  const count = Array.from(clients.values()).filter(client => client.username).length;
  broadcast({ type: 'participantCount', count });
}

async function broadcastResults() {
  try {
    const results = await Result.find({ quizId: currentQuizId }).sort({ submittedAt: -1 });
    const count = results.length;
    broadcast({
      type: 'submittedCount',
      count,
      results: results.map(r => ({
        username: r.username,
        score: r.score,
        submittedAt: r.submittedAt,
      })),
    });
  } catch (error) {
    console.error('Error broadcasting results:', error);
  }
}

app.get('/quizzes', async (req, res) => {
  try {
    const email = req.query.email;
    const query = email ? { createdBy: email } : { isAssigned: true };
    const quizzes = await Quiz.find(query, 'quizId quizName isAssigned');
    res.json(quizzes);
  } catch (error) {
    console.error('Error fetching quizzes:', error);
    res.status(500).json({ message: 'Error fetching quizzes' });
  }
});

app.post('/select-quiz', async (req, res) => {
  try {
    const { quizId } = req.body;
    if (!quizId) {
      return res.status(400).json({ message: 'Quiz ID is required' });
    }
    const quiz = await Quiz.findOne({ quizId });
    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found' });
    }
    currentQuizId = quizId;
    currentQuizName = quiz.quizName;
    timeLimit = quiz.timeLimit || 7200;
    broadcast({
      type: 'quizStatus',
      quizId: currentQuizId,
      quizName: currentQuizName,
    });
    res.json({ message: 'Quiz selected', quizName: quiz.quizName, timeLimit });
  } catch (error) {
    console.error('Error selecting quiz:', error);
    res.status(500).json({ message: 'Error selecting quiz' });
  }
});

app.post('/assign-quiz', async (req, res) => {
  try {
    const { quizId, timeLimit: newTimeLimit } = req.body;
    if (!quizId) {
      return res.status(400).json({ message: 'Quiz ID is required' });
    }
    const quiz = await Quiz.findOne({ quizId });
    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found' });
    }
    quiz.isAssigned = true;
    quiz.timeLimit = newTimeLimit || 7200;
    await quiz.save();
    currentQuizId = quizId;
    currentQuizName = quiz.quizName;
    timeLimit = quiz.timeLimit;
    broadcast({
      type: 'quizStatus',
      quizId: currentQuizId,
      quizName: currentQuizName,
    });
    res.json({ message: 'Quiz assigned successfully' });
  } catch (error) {
    console.error('Error assigning quiz:', error);
    res.status(500).json({ message: 'Error assigning quiz' });
  }
});

app.post('/save-quiz', upload.fields([
  { name: 'audio-part1', maxCount: 1 },
  { name: 'audio-part2', maxCount: 1 },
  { name: 'audio-part3', maxCount: 1 },
  { name: 'audio-part4', maxCount: 1 },
  { name: 'images-part1', maxCount: 100 },
  { name: 'images-part2', maxCount: 100 },
  { name: 'images-part3', maxCount: 100 },
  { name: 'images-part4', maxCount: 100 },
  { name: 'images-part5', maxCount: 100 },
  { name: 'images-part6', maxCount: 100 },
  { name: 'images-part7', maxCount: 100 },
]), async (req, res) => {
  try {
    const { quizName, answerKey, createdBy } = req.body;
    if (!quizName || !answerKey || !createdBy) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const audioFiles = ['audio-part1', 'audio-part2', 'audio-part3', 'audio-part4'].map(
      key => req.files[key] ? req.files[key][0].filename : null
    );

    const images = {};
    for (let i = 1; i <= 7; i++) {
      const partKey = `images-part${i}`;
      images[`part${i}`] = req.files[partKey] ? req.files[partKey].map(f => f.filename) : [];
    }

    const quiz = new Quiz({
      quizId: uuidv4(),
      quizName,
      createdBy,
      audio: audioFiles,
      images,
      answerKey: JSON.parse(answerKey),
      isAssigned: false,
    });

    await quiz.save();
    res.json({ message: 'Quiz saved successfully' });
  } catch (error) {
    console.error('Error saving quiz:', error);
    res.status(500).json({ message: 'Error saving quiz' });
  }
});

app.get('/quiz-audio', async (req, res) => {
  try {
    if (!currentQuizId) {
      return res.status(400).json({ message: 'No quiz selected' });
    }
    const part = req.query.part;
    if (!part || !['part1', 'part2', 'part3', 'part4'].includes(part)) {
      return res.status(400).json({ message: 'Invalid part' });
    }
    const quiz = await Quiz.findOne({ quizId: currentQuizId });
    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found' });
    }
    const partIndex = parseInt(part.replace('part', '')) - 1;
    const audioFile = quiz.audio[partIndex];
    if (!audioFile) {
      return res.status(404).json({ message: `No audio for ${part}` });
    }
    const audioPath = path.join(__dirname, 'uploads', audioFile);
    res.json({ audio: `/uploads/${audioFile}` });
  } catch (error) {
    console.error('Error fetching audio:', error);
    res.status(500).json({ message: 'Error fetching audio' });
  }
});

app.get('/images', async (req, res) => {
  try {
    if (!currentQuizId) {
      return res.status(400).json({ message: 'No quiz selected' });
    }
    const part = req.query.part;
    if (!part || isNaN(part) || part < 1 || part > 7) {
      return res.status(400).json({ message: 'Invalid part' });
    }
    const quiz = await Quiz.findOne({ quizId: currentQuizId });
    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found' });
    }
    const images = quiz.images.get(`part${part}`) || [];
    res.json(images.map(filename => `/uploads/${filename}`));
  } catch (error) {
    console.error('Error fetching images:', error);
    res.status(500).json({ message: 'Error fetching images' });
  }
});

app.post('/submit', async (req, res) => {
  try {
    const { username, answers } = req.body;
    if (!username || !answers || !currentQuizId) {
      return res.status(400).json({ message: 'Missing required fields or no quiz selected' });
    }

    const quiz = await Quiz.findOne({ quizId: currentQuizId });
    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    let score = 0;
    for (let key in answers) {
      if (quiz.answerKey.get(key) === answers[key]) {
        score++;
      }
    }

    const result = new Result({
      quizId: currentQuizId,
      username,
      answers,
      score,
      submittedAt: new Date(),
    });

    await result.save();
    broadcastResults();
    res.json({ score });
  } catch (error) {
    console.error('Error submitting quiz:', error);
    res.status(500).json({ message: 'Error submitting quiz' });
  }
});

app.get('/history', async (req, res) => {
  try {
    const results = await Result.find().sort({ submittedAt: -1 });
    res.json(results);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ message: 'Error fetching history' });
  }
});

app.post('/delete-results', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'No result IDs provided' });
    }
    await Result.deleteMany({ _id: { $in: ids } });
    res.json({ message: 'Results deleted successfully' });
  } catch (error) {
    console.error('Error deleting results:', error);
    res.status(500).json({ message: 'Error deleting results' });
  }
});

app.delete('/delete-quiz/:quizId', async (req, res) => {
  try {
    const { quizId } = req.params;
    const quiz = await Quiz.findOne({ quizId });
    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    for (let audioFile of quiz.audio) {
      if (audioFile) {
        await fs.unlink(path.join(__dirname, 'uploads', audioFile)).catch(err => console.warn('Error deleting audio file:', err));
      }
    }

    for (let partImages of quiz.images.values()) {
      for (let imageFile of partImages) {
        await fs.unlink(path.join(__dirname, 'uploads', imageFile)).catch(err => console.warn('Error deleting image file:', err));
      }
    }

    await Quiz.deleteOne({ quizId });
    await Result.deleteMany({ quizId });

    if (currentQuizId === quizId) {
      currentQuizId = null;
      currentQuizName = null;
      timeLimit = 7200;
      broadcast({
        type: 'quizStatus',
        quizId: null,
        quizName: null,
      });
    }

    res.json({ message: 'Quiz deleted successfully' });
  } catch (error) {
    console.error('Error deleting quiz:', error);
    res.status(500).json({ message: 'Error deleting quiz' });
  }
});

app.delete('/clear-database', async (req, res) => {
  try {
    const quizzes = await Quiz.find();
    for (let quiz of quizzes) {
      for (let audioFile of quiz.audio) {
        if (audioFile) {
          await fs.unlink(path.join(__dirname, 'uploads', audioFile)).catch(err => console.warn('Error deleting audio file:', err));
        }
      }
      for (let partImages of quiz.images.values()) {
        for (let imageFile of partImages) {
          await fs.unlink(path.join(__dirname, 'uploads', imageFile)).catch(err => console.warn('Error deleting image file:', err));
        }
      }
    }

    await Quiz.deleteMany({});
    await Result.deleteMany({});
    currentQuizId = null;
    currentQuizName = null;
    timeLimit = 7200;
    broadcast({
      type: 'quizStatus',
      quizId: null,
      quizName: null,
    });
    res.json({ message: 'Database cleared successfully' });
  } catch (error) {
    console.error('Error clearing database:', error);
    res.status(500).json({ message: 'Error clearing database' });
  }
});

app.get('/quiz-status', async (req, res) => {
  try {
    res.json({
      quizId: currentQuizId,
      quizName: currentQuizName,
      timeLimit,
    });
  } catch (error) {
    console.error('Error fetching quiz status:', error);
    res.status(500).json({ message: 'Error fetching quiz status' });
  }
});

app.get('/direct-results', async (req, res) => {
  try {
    const results = await Result.find({ quizId: currentQuizId }).sort({ submittedAt: -1 });
    res.json(results);
  } catch (error) {
    console.error('Error fetching direct results:', error);
    res.status(500).json({ message: 'Error fetching direct results' });
  }
});

app.post('/upload-quizzes', upload.single('quizzes'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    const data = await fs.readFile(path.join(__dirname, 'uploads', file.filename));
    const quizzes = JSON.parse(data);
    for (let quizData of quizzes) {
      const quiz = new Quiz({
        quizId: uuidv4(),
        quizName: quizData.quizName,
        createdBy: quizData.createdBy || 'unknown',
        audio: quizData.audio || [],
        images: quizData.images || {},
        answerKey: quizData.answerKey || {},
        isAssigned: false,
      });
      await quiz.save();
    }
    await fs.unlink(path.join(__dirname, 'Uploads', file.filename));
    res.json({ message: 'Quizzes uploaded successfully' });
  } catch (error) {
    console.error('Error uploading quizzes:', error);
    res.status(500).json({ message: 'Error uploading quizzes' });
  }
});

app.post('/upload-quizzes-zip', upload.single('quizzes'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    const zip = new AdmZip(path.join(__dirname, 'uploads', file.filename));
    const zipEntries = zip.getEntries();
    const quizzes = [];

    for (let entry of zipEntries) {
      if (entry.entryName.endsWith('.json')) {
        const quizData = JSON.parse(zip.readAsText(entry));
        const quiz = {
          quizId: uuidv4(),
          quizName: quizData.quizName,
          createdBy: quizData.createdBy || 'unknown',
          audio: [],
          images: {},
          answerKey: quizData.answerKey || {},
          isAssigned: false,
        };

        for (let i = 1; i <= 4; i++) {
          const audioEntry = zipEntries.find(e => e.entryName === `audio-part${i}.mp3`);
          if (audioEntry) {
            const audioFileName = `${uuidv4()}-part${i}.mp3`;
            await fs.writeFile(path.join(__dirname, 'uploads', audioFileName), audioEntry.getData());
            quiz.audio[i - 1] = audioFileName;
          }
        }

        for (let i = 1; i <= 7; i++) {
          quiz.images[`part${i}`] = [];
          const imageEntries = zipEntries.filter(e => e.entryName.startsWith(`images-part${i}/`) && /\.(jpg|jpeg|png|gif)$/i.test(e.entryName));
          for (let imgEntry of imageEntries) {
            const imageFileName = `${uuidv4()}-${path.basename(imgEntry.entryName)}`;
            await fs.writeFile(path.join(__dirname, 'Uploads', imageFileName), imgEntry.getData());
            quiz.images[`part${i}`].push(imageFileName);
          }
        }

        quizzes.push(quiz);
      }
    }

    for (let quiz of quizzes) {
      const newQuiz = new Quiz(quiz);
      await newQuiz.save();
    }

    await fs.unlink(path.join(__dirname, 'Uploads', file.filename));
    res.json({ message: 'Quizzes uploaded successfully from ZIP' });
  } catch (error) {
    console.error('Error uploading quizzes from ZIP:', error);
    res.status(500).json({ message: 'Error uploading quizzes from ZIP' });
  }
});

app.get('/download-quiz-zip/:quizId', async (req, res) => {
  try {
    const { quizId } = req.params;
    const quiz = await Quiz.findOne({ quizId });
    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found' });
    }

    const zip = new AdmZip();
    zip.addFile('quiz.json', Buffer.from(JSON.stringify({
      quizName: quiz.quizName,
      createdBy: quiz.createdBy,
      answerKey: quiz.answerKey,
    })));

    for (let i = 0; i < quiz.audio.length; i++) {
      if (quiz.audio[i]) {
        const audioPath = path.join(__dirname, 'uploads', quiz.audio[i]);
        try {
          const audioData = await fs.readFile(audioPath);
          zip.addFile(`audio-part${i + 1}.mp3`, audioData);
        } catch (err) {
          console.warn(`Error reading audio file ${quiz.audio[i]}:`, err);
        }
      }
    }

    for (let i = 1; i <= 7; i++) {
      const partImages = quiz.images.get(`part${i}`) || [];
      for (let imageFile of partImages) {
        const imagePath = path.join(__dirname, 'uploads', imageFile);
        try {
          const imageData = await fs.readFile(imagePath);
          zip.addFile(`images-part${i}/${imageFile}`, imageData);
        } catch (err) {
          console.warn(`Error reading image file ${imageFile}:`, err);
        }
      }
    }

    const zipBuffer = zip.toBuffer();
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename=quiz_${quizId}.zip`,
      'Content-Length': zipBuffer.length,
    });
    res.send(zipBuffer);
  } catch (error) {
    console.error('Error downloading quiz ZIP:', error);
    res.status(500).json({ message: 'Error downloading quiz ZIP' });
  }
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));