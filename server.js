const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { createServer } = require('http');
const { Server } = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 3000;

// Tạo server HTTP và WebSocket
const server = createServer(app);
const wss = new Server({ server });

// Lưu trữ dữ liệu trong bộ nhớ
let quizzes = [];
let results = [];
const clients = new Map();

// Cấu hình Multer
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const fieldName = file.fieldname;
    let dir;
    if (fieldName.startsWith('audio-part')) {
      dir = path.join(__dirname, 'Uploads/audio');
    } else if (fieldName.startsWith('images-part')) {
      dir = path.join(__dirname, 'Uploads/images');
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
app.use('/uploads', express.static(path.join(__dirname, 'Uploads')));
// Phục vụ các file tĩnh từ thư mục gốc hoặc thư mục public
app.use(express.static(path.join(__dirname, 'public')));

// Route cho root URL để phục vụ index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

    // Lưu vào bộ nhớ
    const quizId = uuidv4();
    const quiz = {
      _id: quizId,
      quizName,
      answerKey: parsedAnswerKey,
      createdBy,
      audioFiles,
      imageFiles,
      createdAt: new Date(),
    };
    quizzes.push(quiz);
    console.log('Đã lưu đề thi:', quizId);

    res.status(200).json({ message: 'Lưu đề thi thành công!', quizId });
  } catch (error) {
    console.error('Lỗi khi lưu đề thi:', error);
    res.status(500).json({ message: `Lỗi server: ${error.message}` });
  }
});

// Endpoint lấy danh sách đề thi
app.get('/get-quizzes', async (req, res) => {
  try {
    const quizList = quizzes.map(quiz => ({
      _id: quiz._id,
      quizName: quiz.quizName,
    }));
    res.status(200).json(quizList);
  } catch (error) {
    console.error('Lỗi khi lấy danh sách đề thi:', error);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

// Endpoint lấy chi tiết đề thi
app.get('/get-quiz/:id', async (req, res) => {
  try {
    const quiz = quizzes.find(q => q._id === req.params.id);
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

    const quiz = quizzes.find(q => q._id === quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi!' });
    }

    let score = 0;
    for (let key in answers) {
      if (quiz.answerKey[key] === answers[key]) {
        score++;
      }
    }

    const result = {
      quizId,
      studentName,
      answers,
      score,
      time,
      submittedAt: new Date(),
    };
    results.push(result);

    res.status(200).json({ message: 'Nộp bài thành công!', score, time });
  } catch (error) {
    console.error('Lỗi khi nộp bài:', error);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

// Endpoint lấy trạng thái đề thi
app.get('/quiz-status/:id', async (req, res) => {
  try {
    const quizResults = results.filter(r => r.quizId === req.params.id);
    res.status(200).json({
      status: 'Đang diễn ra',
      participants: quizResults.length,
      submitted: quizResults.length,
      results: quizResults.map(r => ({
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
    const history = results.map(r => {
      const quiz = quizzes.find(q => q._id === r.quizId);
      return {
        quizName: quiz ? quiz.quizName : 'Unknown',
        studentName: r.studentName,
        score: r.score,
        time: r.time,
      };
    });
    res.status(200).json(history);
  } catch (error) {
    console.error('Lỗi khi lấy lịch sử thi:', error);
    res.status(500).json({ message: 'Lỗi server: ' + error.message });
  }
});

// WebSocket logic
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

function broadcastUpdate(quizId) {
  const quizResults = results.filter(r => r.quizId === quizId);
  const update = {
    type: 'update',
    quizId,
    participants: clients.size,
    submitted: quizResults.length,
    results: quizResults.map(r => ({
      studentName: r.studentName,
      score: r.score,
      time: r.time,
    })),
  };
  broadcast(update);
}

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Khởi động server
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});