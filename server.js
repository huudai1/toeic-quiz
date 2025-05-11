const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const WebSocket = require('ws');
const admZip = require('adm-zip');

const app = express();
const port = 3000;
const wsPort = 8080;

// Kết nối MongoDB
mongoose.connect('mongodb://localhost:27017/quizApp', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('MongoDB connection error:', err);
});

// Schema cho Quiz
const quizSchema = new mongoose.Schema({
  quizName: { type: String, required: true },
  answerKey: { type: Object, required: true },
  createdBy: { type: String, required: true },
  audioFiles: [{ part: Number, path: String }],
  imageFiles: [{ part: Number, path: String }],
  createdAt: { type: Date, default: Date.now },
  isAssigned: { type: Boolean, default: false },
  timeLimit: { type: Number, default: 7200 }, // Thời gian mặc định 120 phút
});
const Quiz = mongoose.model('Quiz', quizSchema);

// Schema cho Result
const resultSchema = new mongoose.Schema({
  quizId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', required: true },
  studentName: { type: String, required: true },
  answers: { type: Object, required: true },
  score: { type: Number, required: true },
  submittedAt: { type: Date, default: Date.now },
});
const Result = mongoose.model('Result', resultSchema);

// Cấu hình Multer
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const fieldName = file.fieldname;
    let dir;
    if (fieldName.startsWith('audio-part')) {
      dir = path.join(__dirname, 'uploads/audio');
    } else if (fieldName.startsWith('images-part')) {
      dir = path.join(__dirname, 'Uploads/images');
    } else {
      dir = path.join(__dirname, 'Uploads');
    }
    try {
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});
const upload = multer({ storage });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use('/Uploads', express.static(path.join(__dirname, 'Uploads')));

// WebSocket Server
const wss = new WebSocket.Server({ port: wsPort });
let clients = new Map();
let currentQuiz = null;
let participants = new Set();
let submittedResults = [];

wss.on('connection', ws => {
  ws.on('message', async message => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'login') {
        clients.set(data.username, ws);
        participants.add(data.username);
        broadcastParticipantCount();
      } else if (data.type === 'quizSelected') {
        const quiz = await Quiz.findById(data.quizId);
        if (quiz) {
          currentQuiz = { quizId: quiz._id, quizName: quiz.quizName };
          broadcast({ type: 'quizStatus', quizId: quiz._id, quizName: quiz.quizName });
        }
      } else if (data.type === 'quizAssigned') {
        const quiz = await Quiz.findById(data.quizId);
        if (quiz) {
          quiz.isAssigned = true;
          quiz.timeLimit = data.timeLimit || 7200;
          await quiz.save();
          broadcast({ type: 'quizStatus', quizId: quiz._id, quizName: quiz.quizName });
        }
      } else if (data.type === 'start') {
        broadcast({ type: 'start', timeLimit: data.timeLimit || 7200 });
        submittedResults = [];
        broadcastSubmittedCount();
      } else if (data.type === 'submitted') {
        participants.delete(data.username);
        broadcastParticipantCount();
        const result = submittedResults.find(r => r.username === data.username);
        if (result) {
          submittedResults = submittedResults.filter(r => r.username !== data.username);
          submittedResults.push(result);
        }
        broadcastSubmittedCount();
      } else if (data.type === 'end') {
        broadcast({ type: 'end' });
        participants.clear();
        broadcastParticipantCount();
      } else if (data.type === 'requestQuizStatus') {
        if (currentQuiz) {
          ws.send(JSON.stringify({ type: 'quizStatus', quizId: currentQuiz.quizId, quizName: currentQuiz.quizName }));
        }
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Lỗi xử lý yêu cầu WebSocket.' }));
    }
  });

  ws.on('close', () => {
    let username;
    for (let [key, value] of clients) {
      if (value === ws) {
        username = key;
        clients.delete(key);
        participants.delete(username);
        break;
      }
    }
    broadcastParticipantCount();
  });
});

function broadcast(message) {
  const messageStr = JSON.stringify(message);
  for (let client of clients.values()) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  }
}

function broadcastParticipantCount() {
  broadcast({ type: 'participantCount', count: participants.size });
}

function broadcastSubmittedCount() {
  broadcast({ type: 'submittedCount', count: submittedResults.length, results: submittedResults });
}

// Routes
app.get('/quizzes', async (req, res) => {
  try {
    const email = req.query.email;
    const query = email ? { createdBy: email } : { isAssigned: true };
    const quizzes = await Quiz.find(query).select('quizName isAssigned');
    res.json(quizzes.map(q => ({ quizId: q._id, quizName: q.quizName, isAssigned: q.isAssigned })));
  } catch (err) {
    console.error('Error fetching quizzes:', err);
    res.status(500).json({ message: 'Lỗi khi lấy danh sách đề thi.' });
  }
});

app.post('/save-quiz', upload.fields([
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
]), async (req, res) => {
  try {
    const { quizName, answerKey, createdBy } = req.body;
    if (!quizName || !answerKey || !createdBy) {
      return res.status(400).json({ message: 'Thiếu thông tin bắt buộc: quizName, answerKey hoặc createdBy.' });
    }

    const parsedAnswerKey = JSON.parse(answerKey);
    const expectedQuestions = 200; // Tổng số câu hỏi từ Part 1 đến Part 7
    if (Object.keys(parsedAnswerKey).length !== expectedQuestions) {
      return res.status(400).json({ message: `Đáp án phải có đúng ${expectedQuestions} câu hỏi.` });
    }

    const audioFiles = [];
    for (let i = 1; i <= 4; i++) {
      if (!req.files[`audio-part${i}`]) {
        return res.status(400).json({ message: `Thiếu file audio cho Part ${i}.` });
      }
      audioFiles.push({
        part: i,
        path: `/Uploads/audio/${req.files[`audio-part${i}`][0].filename}`,
      });
    }

    const imageFiles = [];
    for (let i = 1; i <= 7; i++) {
      if (!req.files[`images-part${i}`] || req.files[`images-part${i}`].length === 0) {
        return res.status(400).json({ message: `Thiếu file ảnh cho Part ${i}.` });
      }
      req.files[`images-part${i}`].forEach(file => {
        imageFiles.push({
          part: i,
          path: `/Uploads/images/${file.filename}`,
        });
      });
    }

    const quiz = new Quiz({
      quizName,
      answerKey: parsedAnswerKey,
      createdBy,
      audioFiles,
      imageFiles,
    });

    await quiz.save();
    res.json({ message: 'Đề thi đã được lưu thành công!' });
  } catch (err) {
    console.error('Error saving quiz:', err);
    res.status(500).json({ message: 'Lỗi khi lưu đề thi. Vui lòng kiểm tra dữ liệu và thử lại.' });
  }
});

app.delete('/delete-quiz/:quizId', async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi.' });
    }

    // Xóa các file audio và ảnh
    for (let file of [...quiz.audioFiles, ...quiz.imageFiles]) {
      try {
        await fs.unlink(path.join(__dirname, file.path));
      } catch (err) {
        console.warn(`Không thể xóa file ${file.path}:`, err);
      }
    }

    await Quiz.deleteOne({ _id: req.params.quizId });
    await Result.deleteMany({ quizId: req.params.quizId });
    if (currentQuiz && currentQuiz.quizId.toString() === req.params.quizId) {
      currentQuiz = null;
      broadcast({ type: 'quizStatus', quizId: null, quizName: null });
    }
    res.json({ message: 'Đã xóa đề thi thành công.' });
  } catch (err) {
    console.error('Error deleting quiz:', err);
    res.status(500).json({ message: 'Lỗi khi xóa đề thi.' });
  }
});

app.post('/select-quiz', async (req, res) => {
  try {
    const { quizId } = req.body;
    const quiz = await Quiz.findById(quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi.' });
    }
    currentQuiz = { quizId: quiz._id, quizName: quiz.quizName, timeLimit: quiz.timeLimit };
    res.json({ message: 'Đã chọn đề thi.', quizName: quiz.quizName, timeLimit: quiz.timeLimit });
  } catch (err) {
    console.error('Error selecting quiz:', err);
    res.status(500).json({ message: 'Lỗi khi chọn đề thi.' });
  }
});

app.post('/assign-quiz', async (req, res) => {
  try {
    const { quizId, timeLimit } = req.body;
    const quiz = await Quiz.findById(quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi.' });
    }
    quiz.isAssigned = true;
    quiz.timeLimit = timeLimit || 7200;
    await quiz.save();
    currentQuiz = { quizId: quiz._id, quizName: quiz.quizName, timeLimit: quiz.timeLimit };
    res.json({ message: 'Đã giao đề thi thành công.' });
  } catch (err) {
    console.error('Error assigning quiz:', err);
    res.status(500).json({ message: 'Lỗi khi giao đề thi.' });
  }
});

app.get('/quiz-status', async (req, res) => {
  try {
    if (currentQuiz) {
      const quiz = await Quiz.findById(currentQuiz.quizId);
      if (quiz) {
        res.json({ quizId: currentQuiz.quizId, quizName: quiz.quizName });
      } else {
        currentQuiz = null;
        res.json({ quizId: null, quizName: null });
      }
    } else {
      res.json({ quizId: null, quizName: null });
    }
  } catch (err) {
    console.error('Error fetching quiz status:', err);
    res.status(500).json({ message: 'Lỗi khi lấy trạng thái đề thi.' });
  }
});

app.get('/quiz-audio', async (req, res) => {
  try {
    if (!currentQuiz) {
      return res.status(400).json({ message: 'Chưa chọn đề thi.' });
    }
    const quiz = await Quiz.findById(currentQuiz.quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi.' });
    }
    const part = req.query.part;
    const audio = quiz.audioFiles.find(f => f.part === parseInt(part.replace('part', '')));
    if (!audio) {
      return res.status(404).json({ message: `Không tìm thấy file audio cho ${part}.` });
    }
    res.json({ audio: audio.path });
  } catch (err) {
    console.error('Error fetching audio:', err);
    res.status(500).json({ message: 'Lỗi khi lấy file audio.' });
  }
});

app.get('/images', async (req, res) => {
  try {
    if (!currentQuiz) {
      return res.status(400).json({ message: 'Chưa chọn đề thi.' });
    }
    const quiz = await Quiz.findById(currentQuiz.quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi.' });
    }
    const part = parseInt(req.query.part);
    const images = quiz.imageFiles.filter(f => f.part === part).map(f => f.path);
    res.json(images);
  } catch (err) {
    console.error('Error fetching images:', err);
    res.status(500).json({ message: 'Lỗi khi lấy danh sách ảnh.' });
  }
});

app.post('/submit', async (req, res) => {
  try {
    if (!currentQuiz) {
      return res.status(400).json({ message: 'Chưa chọn đề thi.' });
    }
    const { username, answers } = req.body;
    if (!username || !answers) {
      return res.status(400).json({ message: 'Thiếu thông tin username hoặc answers.' });
    }
    const quiz = await Quiz.findById(currentQuiz.quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi.' });
    }

    let score = 0;
    for (let key in answers) {
      if (quiz.answerKey[key] && answers[key] === quiz.answerKey[key]) {
        score++;
      }
    }

    const result = new Result({
      quizId: currentQuiz.quizId,
      studentName: username,
      answers,
      score,
    });
    await result.save();

    submittedResults.push({ username, score, submittedAt: new Date() });
    broadcastSubmittedCount();

    res.json({ message: 'Nộp bài thành công.', score });
  } catch (err) {
    console.error('Error submitting quiz:', err);
    res.status(500).json({ message: 'Lỗi khi nộp bài.' });
  }
});

app.get('/direct-results', async (req, res) => {
  try {
    res.json(submittedResults);
  } catch (err) {
    console.error('Error fetching direct results:', err);
    res.status(500).json({ message: 'Lỗi khi lấy kết quả kiểm tra trực tiếp.' });
  }
});

app.get('/history', async (req, res) => {
  try {
    const results = await Result.find().sort({ submittedAt: -1 });
    res.json(results);
  } catch (err) {
    console.error('Error fetching history:', err);
    res.status(500).json({ message: 'Lỗi khi lấy lịch sử điểm.' });
  }
});

app.post('/delete-results', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'Danh sách ID không hợp lệ.' });
    }
    await Result.deleteMany({ _id: { $in: ids } });
    res.json({ message: 'Đã xóa các kết quả được chọn.' });
  } catch (err) {
    console.error('Error deleting results:', err);
    res.status(500).json({ message: 'Lỗi khi xóa kết quả.' });
  }
});

app.delete('/clear-database', async (req, res) => {
  try {
    // Xóa tất cả file trong thư mục Uploads
    const uploadDir = path.join(__dirname, 'Uploads');
    const deleteDir = async dir => {
      try {
        const files = await fs.readdir(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stat = await fs.stat(filePath);
          if (stat.isDirectory()) {
            await deleteDir(filePath);
          } else {
            await fs.unlink(filePath);
          }
        }
        await fs.rmdir(dir);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    };
    await deleteDir(uploadDir);

    // Xóa database
    await Quiz.deleteMany({});
    await Result.deleteMany({});
    currentQuiz = null;
    submittedResults = [];
    participants.clear();
    broadcast({ type: 'quizStatus', quizId: null, quizName: null });
    broadcastParticipantCount();
    broadcastSubmittedCount();
    res.json({ message: 'Đã xóa toàn bộ database và file liên quan.' });
  } catch (err) {
    console.error('Error clearing database:', err);
    res.status(500).json({ message: 'Lỗi khi xóa database.' });
  }
});

app.post('/upload-quizzes', upload.single('quizzes'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: 'Vui lòng tải lên file JSON.' });
    }
    const data = JSON.parse(await fs.readFile(file.path));
    for (const quizData of data) {
      const quiz = new Quiz({
        quizName: quizData.quizName,
        answerKey: quizData.answerKey,
        createdBy: quizData.createdBy || 'unknown',
        audioFiles: quizData.audioFiles || [],
        imageFiles: quizData.imageFiles || [],
      });
      await quiz.save();
    }
    await fs.unlink(file.path);
    res.json({ message: 'Đã tải lên danh sách đề thi thành công.' });
  } catch (err) {
    console.error('Error uploading quizzes:', err);
    res.status(500).json({ message: 'Lỗi khi tải lên danh sách đề thi.' });
  }
});

app.post('/upload-quizzes-zip', upload.single('quizzes'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: 'Vui lòng tải lên file ZIP.' });
    }
    const zip = new admZip(file.path);
    const zipEntries = zip.getEntries();
    let quizData = null;
    const audioFiles = [];
    const imageFiles = [];

    for (const entry of zipEntries) {
      if (entry.entryName.endsWith('.json')) {
        quizData = JSON.parse(zip.readAsText(entry));
      } else if (entry.entryName.startsWith('audio/')) {
        const part = parseInt(entry.entryName.match(/part(\d)/)?.[1]);
        if (part) {
          const fileName = `audio-part${part}-${Date.now()}${path.extname(entry.entryName)}`;
          const filePath = path.join(__dirname, 'Uploads/audio', fileName);
          zip.extractEntryTo(entry, path.join(__dirname, 'Uploads/audio'), false, true);
          audioFiles.push({ part, path: `/Uploads/audio/${fileName}` });
        }
      } else if (entry.entryName.startsWith('images/')) {
        const part = parseInt(entry.entryName.match(/part(\d)/)?.[1]);
        if (part) {
          const fileName = `images-part${part}-${Date.now()}${path.extname(entry.entryName)}`;
          const filePath = path.join(__dirname, 'Uploads/images', fileName);
          zip.extractEntryTo(entry, path.join(__dirname, 'Uploads/images'), false, true);
          imageFiles.push({ part, path: `/Uploads/images/${fileName}` });
        }
      }
    }

    if (!quizData) {
      return res.status(400).json({ message: 'Không tìm thấy file JSON trong ZIP.' });
    }

    const quiz = new Quiz({
      quizName: quizData.quizName,
      answerKey: quizData.answerKey,
      createdBy: quizData.createdBy || 'unknown',
      audioFiles,
      imageFiles,
    });
    await quiz.save();
    await fs.unlink(file.path);
    res.json({ message: 'Đã tải lên đề thi từ file ZIP thành công.' });
  } catch (err) {
    console.error('Error uploading quizzes from ZIP:', err);
    res.status(500).json({ message: 'Lỗi khi tải lên file ZIP.' });
  }
});

app.get('/download-quiz-zip/:quizId', async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi.' });
    }

    const zip = new admZip();
    zip.addFile('quiz.json', Buffer.from(JSON.stringify({
      quizName: quiz.quizName,
      answerKey: quiz.answerKey,
      createdBy: quiz.createdBy,
    })));

    for (const audio of quiz.audioFiles) {
      const filePath = path.join(__dirname, audio.path);
      try {
        const data = await fs.readFile(filePath);
        zip.addFile(`audio/part${audio.part}${path.extname(audio.path)}`, data);
      } catch (err) {
        console.warn(`Không thể thêm file audio ${audio.path}:`, err);
      }
    }

    for (const image of quiz.imageFiles) {
      const filePath = path.join(__dirname, image.path);
      try {
        const data = await fs.readFile(filePath);
        zip.addFile(`images/part${image.part}/${path.basename(image.path)}`, data);
      } catch (err) {
        console.warn(`Không thể thêm file ảnh ${image.path}:`, err);
      }
    }

    const zipBuffer = zip.toBuffer();
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename=quiz_${req.params.quizId}.zip`,
      'Content-Length': zipBuffer.length,
    });
    res.send(zipBuffer);
  } catch (err) {
    console.error('Error downloading quiz ZIP:', err);
    res.status(500).json({ message: 'Lỗi khi tải xuống file ZIP.' });
  }
});

app.post('/logout', async (req, res) => {
  try {
    const { username } = req.body;
    if (username && clients.has(username)) {
      participants.delete(username);
      clients.delete(username);
      broadcastParticipantCount();
    }
    res.json({ message: 'Đăng xuất thành công.' });
  } catch (err) {
    console.error('Error during logout:', err);
    res.status(500).json({ message: 'Lỗi khi đăng xuất.' });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});