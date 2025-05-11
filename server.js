const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const WebSocket = require('ws');

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
});
const Quiz = mongoose.model('Quiz', quizSchema);

// Schema cho Result
const resultSchema = new mongoose.Schema({
  quizId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quiz', required: true },
  studentName: { type: String, required: true },
  answers: { type: Object, required: true },
  score: { type: Number, required: true },
  time: { type: Number, required: true },
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
      dir = path.join(__dirname, 'uploads/images');
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
const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
  fileFilter: (req, file, cb) => {
    if (file.fieldname.startsWith('audio-part') && !file.mimetype.startsWith('audio/')) {
      return cb(new Error('File audio phải là định dạng audio!'));
    }
    if (file.fieldname.startsWith('images-part') && !file.mimetype.startsWith('image/')) {
      return cb(new Error('File ảnh phải là định dạng ảnh!'));
    }
    cb(null, true);
  },
});

// Middleware
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Endpoint lưu đề thi
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
    console.log('Nhận yêu cầu lưu đề thi...');
    const { quizName, answerKey, createdBy } = req.body;
    const files = req.files;

    // Kiểm tra dữ liệu
    if (!quizName || !answerKey || !createdBy) {
      console.error('Thiếu dữ liệu:', { quizName, answerKey, createdBy });
      return res.status(400).json({ message: 'Thiếu tên đề thi, đáp án hoặc thông tin người tạo!' });
    }

    // Parse answerKey
    let parsedAnswerKey;
    try {
      parsedAnswerKey = JSON.parse(answerKey);
    } catch (err) {
      console.error('Lỗi parse answerKey:', err);
      return res.status(400).json({ message: 'Đáp án không đúng định dạng JSON!' });
    }

    // Kiểm tra số lượng đáp án
    const expectedAnswerCounts = [6, 25, 39, 30, 30, 16, 54];
    let questionIndex = 1;
    for (let part = 1; part <= 7; part++) {
      const count = expectedAnswerCounts[part - 1];
      for (let i = 0; i < count; i++) {
        const key = `q${questionIndex}`;
        if (!parsedAnswerKey[key] || !['A', 'B', 'C', 'D'].includes(parsedAnswerKey[key])) {
          console.error(`Đáp án không hợp lệ tại ${key}:`, parsedAnswerKey[key]);
          return res.status(400).json({ message: `Đáp án tại câu ${key} không hợp lệ!` });
        }
        questionIndex++;
      }
    }

    // Kiểm tra file audio
    const audioFiles = [];
    for (let part = 1; part <= 4; part++) {
      if (!files[`audio-part${part}`] || files[`audio-part${part}`].length !== 1) {
        console.error(`Thiếu file audio Part ${part}`);
        return res.status(400).json({ message: `Thiếu file nghe cho Part ${part}!` });
      }
      audioFiles.push({
        part,
        path: `/uploads/audio/${path.basename(files[`audio-part${part}`][0].path)}`,
      });
      console.log(`File audio Part ${part}: ${files[`audio-part${part}`][0].path}`);
    }

    // Kiểm tra file ảnh
    const imageFiles = [];
    for (let part = 1; part <= 7; part++) {
      if (!files[`images-part${part}`] || files[`images-part${part}`].length === 0) {
        console.error(`Thiếu file ảnh Part ${part}`);
        return res.status(400).json({ message: `Thiếu file ảnh cho Part ${part}!` });
      }
      files[`images-part${part}`].forEach(file => {
        imageFiles.push({
          part,
          path: `/uploads/images/${path.basename(file.path)}`,
        });
        console.log(`File ảnh Part ${part}: ${file.path}`);
      });
    }

    // Lưu vào MongoDB
    const quiz = new Quiz({
      quizName,
      answerKey: parsedAnswerKey,
      createdBy,
      audioFiles,
      imageFiles,
    });
    const savedQuiz = await quiz.save();
    console.log('Đã lưu đề thi:', savedQuiz._id);

    res.status(200).json({ message: 'Lưu đề thi thành công!', quizId: savedQuiz._id });
  } catch (error) {
    console.error('Lỗi khi lưu đề thi:', error);
    res.status(500).json({ message: `Lỗi server: ${error.message}` });
  }
});

// Endpoint lấy danh sách đề thi
app.get('/get-quizzes', async (req, res) => {
  try {
    const quizzes = await Quiz.find({}, 'quizName _id');
    res.status(200).json(quizzes);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách đề thi:', error);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

// Endpoint lấy chi tiết đề thi
app.get('/get-quiz/:id', async (req, res) => {
  try {
    const quiz = await Quiz.findById(req.params.id);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi!' });
    }
    res.status(200).json({
      quizName: quiz.quizName,
      audioFiles: quiz.audioFiles,
      imageFiles: quiz.imageFiles,
    });
  } catch (error) {
    console.error('Lỗi khi lấy đề thi:', error);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

// Endpoint nộp bài
app.post('/submit-quiz', async (req, res) => {
  try {
    const { quizId, studentName, answers, time } = req.body;
    if (!quizId || !studentName || !answers || time == null) {
      return res.status(400).json({ message: 'Thiếu dữ liệu bài nộp!' });
    }

    const quiz = await Quiz.findById(quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi!' });
    }

    let score = 0;
    for (let key in answers) {
      if (quiz.answerKey[key] === answers[key]) {
        score++;
      }
    }

    const result = new Result({
      quizId,
      studentName,
      answers,
      score,
      time,
    });
    await result.save();

    res.status(200).json({ message: 'Nộp bài thành công!', score, time });
  } catch (error) {
    console.error('Lỗi khi nộp bài:', error);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

// Endpoint lấy trạng thái đề thi
app.get('/quiz-status/:id', async (req, res) => {
  try {
    const results = await Result.find({ quizId: req.params.id });
    res.status(200).json({
      status: 'Đang diễn ra', // Có thể tùy chỉnh
      participants: results.length,
      submitted: results.length,
      results: results.map(r => ({
        studentName: r.studentName,
        score: r.score,
        time: r.time,
      })),
    });
  } catch (error) {
    console.error('Lỗi khi lấy trạng thái đề thi:', error);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

// Endpoint lấy lịch sử thi
app.get('/history', async (req, res) => {
  try {
    const results = await Result.find().populate('quizId', 'quizName');
    res.status(200).json(results.map(r => ({
      quizName: r.quizId.quizName,
      studentName: r.studentName,
      score: r.score,
      time: r.time,
    })));
  } catch (error) {
    console.error('Lỗi khi lấy lịch sử thi:', error);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

// WebSocket server
const wss = new WebSocket.Server({ port: wsPort });
const clients = new Map();

wss.on('connection', ws => {
  console.log('Client connected to WebSocket');
  ws.on('message', message => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'join') {
        clients.set(ws, { quizId: data.quizId, studentName: data.studentName });
        broadcastUpdate(data.quizId);
      } else if (data.type === 'start') {
        broadcast({ type: 'start', quizId: data.quizId });
      } else if (data.type === 'end') {
        broadcast({ type: 'end', quizId: data.quizId });
      } else if (data.type === 'submit') {
        broadcastUpdate(data.quizId);
      }
    } catch (error) {
      console.error('Lỗi xử lý WebSocket message:', error);
    }
  });
  ws.on('close', () => {
    const client = clients.get(ws);
    if (client) {
      broadcastUpdate(client.quizId);
      clients.delete(ws);
    }
  });
});

async function broadcastUpdate(quizId) {
  try {
    const results = await Result.find({ quizId });
    const update = {
      type: 'update',
      quizId,
      participants: clients.size,
      submitted: results.length,
      results: results.map(r => ({
        studentName: r.studentName,
        score: r.score,
        time: r.time,
      })),
    };
    broadcast(update);
  } catch (error) {
    console.error('Lỗi khi broadcast update:', error);
  }
}

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Khởi động server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  console.log(`WebSocket server running at ws://localhost:${wsPort}`);
});