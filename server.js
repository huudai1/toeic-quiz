const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const WebSocket = require('ws');
const archiver = require('archiver');
const unzipper = require('unzipper');

const app = express();
const port = process.env.PORT || 3000; // Sử dụng PORT từ Render hoặc mặc định 3000
const wsPort = 8080;

// Đường dẫn lưu trữ dữ liệu
const DATA_DIR = process.env.DATA_DIR || '/tmp/data'; // Sử dụng /tmp trên Render
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/tmp/Uploads'; // Thư mục tạm cho file upload
const QUIZZES_FILE = path.join(DATA_DIR, 'quizzes.json');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');

// Khởi tạo thư mục và file
async function initFiles() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(path.join(UPLOADS_DIR, 'audio'), { recursive: true });
    await fs.mkdir(path.join(UPLOADS_DIR, 'images'), { recursive: true });

    try {
      await fs.access(QUIZZES_FILE);
    } catch {
      await fs.writeFile(QUIZZES_FILE, JSON.stringify([]));
      console.log('Created quizzes.json');
    }
    try {
      await fs.access(STATUS_FILE);
    } catch {
      await fs.writeFile(STATUS_FILE, JSON.stringify({}));
      console.log('Created status.json');
    }
    try {
      await fs.access(RESULTS_FILE);
    } catch {
      await fs.writeFile(RESULTS_FILE, JSON.stringify([]));
      console.log('Created results.json');
    }
  } catch (error) {
    console.error('Error initializing files:', error);
  }
}
initFiles();

// Cấu hình Multer
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const fieldName = file.fieldname;
    let dir;
    if (fieldName.startsWith('audio-part')) {
      dir = path.join(UPLOADS_DIR, 'audio');
    } else if (fieldName.startsWith('images-part')) {
      dir = path.join(UPLOADS_DIR, 'images');
    } else {
      dir = UPLOADS_DIR;
    }
    try {
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      console.error(`Error creating directory ${dir}:`, err);
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalName)}`);
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
    if (file.fieldname === 'quizzes' && !['application/json', 'application/zip'].includes(file.mimetype)) {
      return cb(new Error('File phải là .json hoặc .zip!'));
    }
    cb(null, true);
  },
});

// Middleware
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));

// WebSocket Server
const wss = new WebSocket.Server({ port: wsPort });
wss.on('connection', ws => {
  ws.on('message', async message => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'login') {
        const status = JSON.parse(await fs.readFile(STATUS_FILE));
        if (!status.participants) status.participants = [];
        if (!status.participants.includes(data.username)) {
          status.participants.push(data.username);
          await fs.writeFile(STATUS_FILE, JSON.stringify(status));
        }
        broadcastParticipantCount(status.participants.length);
      } else if (data.type === 'requestQuizStatus') {
        const status = JSON.parse(await fs.readFile(STATUS_FILE));
        ws.send(JSON.stringify({
          type: 'quizStatus',
          quizId: status.quizId,
          quizName: status.quizName,
          isAssigned: status.isAssigned || false,
        }));
      } else if (data.type === 'quizSelected') {
        broadcast({
          type: 'quizStatus',
          quizId: data.quizId,
          quizName: (await getQuizById(data.quizId)).quizName,
        });
      } else if (data.type === 'quizAssigned') {
        broadcast({
          type: 'quizStatus',
          quizId: data.quizId,
          quizName: (await getQuizById(data.quizId)).quizName,
          isAssigned: true,
        });
      } else if (data.type === 'start') {
        broadcast({ type: 'start', timeLimit: data.timeLimit });
      } else if (data.type === 'end') {
        broadcast({ type: 'end' });
      } else if (data.type === 'submitted') {
        const status = JSON.parse(await fs.readFile(STATUS_FILE));
        const results = JSON.parse(await fs.readFile(RESULTS_FILE));
        const result = results.find(r => r.studentName === data.username && r.quizId === status.quizId);
        if (!status.submitted) status.submitted = [];
        if (result) {
          status.submitted.push({
            username: data.username,
            score: result.score,
            submittedAt: result.submittedAt,
          });
          await fs.writeFile(STATUS_FILE, JSON.stringify(status));
          broadcast({
            type: 'submitted',
            count: status.submitted.length,
            results: status.submitted,
          });
        }
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });
});

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

async function broadcastParticipantCount(count) {
  broadcast({ type: 'participantCount', count });
}

async function broadcastSubmittedCount(count, results) {
  broadcast({ type: 'submittedCount', count, results });
}

// Hàm tiện ích
async function getQuizById(quizId) {
  const quizzes = JSON.parse(await fs.readFile(QUIZZES_FILE));
  return quizzes.find(q => q._id === quizId);
}

async function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

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
    console.log('Nhận yêu cầu lưu đề thi:', req.body);
    const { quizName, answerKey, createdBy } = req.body;
    const files = req.files;

    // Kiểm tra dữ liệu đầu vào
    if (!quizName) {
      console.error('Thiếu tên đề thi');
      return res.status(400).json({ message: 'Vui lòng nhập tên đề thi!' });
    }
    if (!answerKey) {
      console.error('Thiếu đáp án');
      return res.status(400).json({ message: 'Vui lòng cung cấp đáp án!' });
    }
    if (!createdBy) {
      console.error('Thiếu thông tin người tạo');
      return res.status(400).json({ message: 'Vui lòng cung cấp thông tin người tạo!' });
    }

    // Kiểm tra file audio
    const audioFields = ['audio-part1', 'audio-part2', 'audio-part3', 'audio-part4'];
    for (let field of audioFields) {
      if (!files[field] || files[field].length === 0) {
        console.error(`Thiếu file audio cho ${field}`);
        return res.status(400).json({ message: `Vui lòng tải file nghe cho ${field.replace('audio-', '')}!` });
      }
    }

    // Kiểm tra file ảnh
    const imageFields = ['images-part1', 'images-part2', 'images-part3', 'images-part4', 'images-part5', 'images-part6', 'images-part7'];
    for (let field of imageFields) {
      if (!files[field] || files[field].length === 0) {
        console.error(`Thiếu file ảnh cho ${field}`);
        return res.status(400).json({ message: `Vui lòng tải ít nhất một ảnh cho ${field.replace('images-', '')}!` });
      }
    }

    // Kiểm tra định dạng đáp án
    let parsedAnswerKey;
    try {
      parsedAnswerKey = JSON.parse(answerKey);
    } catch (error) {
      console.error('Đáp án không đúng định dạng JSON:', error);
      return res.status(400).json({ message: 'Đáp án phải là định dạng JSON hợp lệ!' });
    }

    const expectedQuestions = 200;
    const questionKeys = Object.keys(parsedAnswerKey);
    if (questionKeys.length !== expectedQuestions) {
      console.error(`Số lượng đáp án không đúng: ${questionKeys.length}, cần: ${expectedQuestions}`);
      return res.status(400).json({ message: `Đáp án phải có đúng ${expectedQuestions} câu hỏi!` });
    }

    for (let i = 1; i <= expectedQuestions; i++) {
      if (!parsedAnswerKey[`q${i}`]) {
        console.error(`Thiếu đáp án cho câu q${i}`);
        return res.status(400).json({ message: `Thiếu đáp án cho câu q${i}!` });
      }
      if (!['A', 'B', 'C', 'D'].includes(parsedAnswerKey[`q${i}`])) {
        console.error(`Đáp án không hợp lệ cho câu q${i}: ${parsedAnswerKey[`q${i}`]}`);
        return res.status(400).json({ message: `Đáp án cho câu q${i} phải là A, B, C hoặc D!` });
      }
    }

    // Chuẩn bị dữ liệu để lưu
    const audioFiles = audioFields.map((field, index) => ({
      part: index + 1,
      path: files[field][0].path,
    }));

    const imageFiles = [];
    imageFields.forEach((field, index) => {
      files[field].forEach(file => {
        imageFiles.push({
          part: index + 1,
          path: file.path,
        });
      });
    });

    // Lưu đề thi vào file JSON
    let quizzes = [];
    try {
      quizzes = JSON.parse(await fs.readFile(QUIZZES_FILE));
    } catch (error) {
      console.error('Error reading quizzes.json:', error);
      quizzes = [];
    }
    const newQuiz = {
      _id: await generateId(),
      quizName,
      answerKey: parsedAnswerKey,
      createdBy,
      audioFiles,
      imageFiles,
      createdAt: new Date().toISOString(),
    };
    quizzes.push(newQuiz);
    try {
      await fs.writeFile(QUIZZES_FILE, JSON.stringify(quizzes, null, 2));
      console.log(`Đã lưu đề thi: ${quizName}`);
      res.status(200).json({ message: 'Lưu đề thi thành công!' });
    } catch (error) {
      console.error('Error writing to quizzes.json:', error);
      return res.status(500).json({ message: `Lỗi khi lưu file quizzes.json: ${error.message}` });
    }
  } catch (error) {
    console.error('Lỗi khi lưu đề thi:', error);
    res.status(500).json({ message: `Lỗi server khi lưu đề thi: ${error.message}` });
  }
});

// Endpoint tải danh sách đề thi
app.get('/quizzes', async (req, res) => {
  try {
    const email = req.query.email;
    let quizzes = [];
    try {
      quizzes = JSON.parse(await fs.readFile(QUIZZES_FILE));
    } catch (error) {
      console.error('Error reading quizzes.json:', error);
    }
    const status = JSON.parse(await fs.readFile(STATUS_FILE));
    const filteredQuizzes = email ? quizzes.filter(q => q.createdBy === email) : quizzes;
    res.json(filteredQuizzes.map(quiz => ({
      quizId: quiz._id,
      quizName: quiz.quizName,
      createdBy: quiz.createdBy,
      isAssigned: status.quizId === quiz._id && status.isAssigned || false,
    })));
  } catch (error) {
    console.error('Lỗi khi tải danh sách đề thi:', error);
    res.status(500).json({ message: 'Lỗi server khi tải danh sách đề thi' });
  }
});

// Endpoint tải file audio
app.get('/quiz-audio', async (req, res) => {
  try {
    const { part } = req.query;
    const status = JSON.parse(await fs.readFile(STATUS_FILE));
    if (!status.quizId) {
      return res.status(404).json({ message: 'Chưa có đề thi nào được chọn' });
    }
    const quizzes = JSON.parse(await fs.readFile(QUIZZES_FILE));
    const quiz = quizzes.find(q => q._id === status.quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi' });
    }
    const audio = quiz.audioFiles.find(a => a.part === parseInt(part.replace('part', '')));
    if (!audio) {
      return res.status(404).json({ message: `Không tìm thấy file audio cho ${part}` });
    }
    res.json({ audio: `/uploads/audio/${path.basename(audio.path)}` });
  } catch (error) {
    console.error('Lỗi khi tải audio:', error);
    res.status(500).json({ message: 'Lỗi server khi tải file audio' });
  }
});

// Endpoint tải danh sách ảnh
app.get('/images', async (req, res) => {
  try {
    const { part } = req.query;
    const status = JSON.parse(await fs.readFile(STATUS_FILE));
    if (!status.quizId) {
      return res.status(404).json({ message: 'Chưa có đề thi nào được chọn' });
    }
    const quizzes = JSON.parse(await fs.readFile(QUIZZES_FILE));
    const quiz = quizzes.find(q => q._id === status.quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi' });
    }
    const images = quiz.imageFiles
      .filter(img => img.part === parseInt(part))
      .map(img => `/uploads/images/${path.basename(img.path)}`);
    res.json(images);
  } catch (error) {
    console.error('Lỗi khi tải ảnh:', error);
    res.status(500).json({ message: 'Lỗi server khi tải ảnh' });
  }
});

// Endpoint chọn đề thi
app.post('/select-quiz', async (req, res) => {
  try {
    const { quizId } = req.body;
    if (!quizId) {
      return res.status(400).json({ message: 'Vui lòng cung cấp quizId' });
    }
    const quizzes = JSON.parse(await fs.readFile(QUIZZES_FILE));
    const quiz = quizzes.find(q => q._id === quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi' });
    }
    const status = {
      quizId,
      quizName: quiz.quizName,
      isAssigned: false,
      participants: [],
      submitted: [],
    };
    await fs.writeFile(STATUS_FILE, JSON.stringify(status));
    broadcast({
      type: 'quizStatus',
      quizId,
      quizName: quiz.quizName,
    });
    res.json({ message: 'Đã chọn đề thi', quizName: quiz.quizName });
  } catch (error) {
    console.error('Lỗi khi chọn đề thi:', error);
    res.status(500).json({ message: 'Lỗi server khi chọn đề thi' });
  }
});

// Endpoint giao bài
app.post('/assign-quiz', async (req, res) => {
  try {
    const { quizId, timeLimit } = req.body;
    if (!quizId || !timeLimit) {
      return res.status(400).json({ message: 'Vui lòng cung cấp quizId và timeLimit' });
    }
    const quizzes = JSON.parse(await fs.readFile(QUIZZES_FILE));
    const quiz = quizzes.find(q => q._id === quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi' });
    }
    const status = {
      quizId,
      quizName: quiz.quizName,
      isAssigned: true,
      timeLimit,
      participants: [],
      submitted: [],
    };
    await fs.writeFile(STATUS_FILE, JSON.stringify(status));
    broadcast({
      type: 'quizStatus',
      quizId,
      quizName: quiz.quizName,
      isAssigned: true,
    });
    res.json({ message: 'Đã giao đề thi' });
  } catch (error) {
    console.error('Lỗi khi giao đề thi:', error);
    res.status(500).json({ message: 'Lỗi server khi giao đề thi' });
  }
});

// Endpoint nộp bài
app.post('/submit', async (req, res) => {
  try {
    const { username, answers } = req.body;
    if (!username || !answers) {
      return res.status(400).json({ message: 'Vui lòng cung cấp username và answers' });
    }
    const status = JSON.parse(await fs.readFile(STATUS_FILE));
    if (!status.quizId) {
      return res.status(404).json({ message: 'Chưa có đề thi nào được chọn' });
    }
    const quizzes = JSON.parse(await fs.readFile(QUIZZES_FILE));
    const quiz = quizzes.find(q => q._id === status.quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi' });
    }

    let score = 0;
    Object.keys(quiz.answerKey).forEach(key => {
      if (answers[key] && answers[key] === quiz.answerKey[key]) {
        score++;
      }
    });

    const results = JSON.parse(await fs.readFile(RESULTS_FILE));
    const result = {
      _id: await generateId(),
      quizId: quiz._id,
      studentName: username,
      answers,
      score,
      time: status.timeLimit,
      submittedAt: new Date().toISOString(),
    };
    results.push(result);
    await fs.writeFile(RESULTS_FILE, JSON.stringify(results));

    status.submitted.push({
      username,
      score,
      submittedAt: new Date().toISOString(),
    });
    await fs.writeFile(STATUS_FILE, JSON.stringify(status));

    broadcastSubmittedCount(status.submitted.length, status.submitted);
    res.json({ score });
  } catch (error) {
    console.error('Lỗi khi nộp bài:', error);
    res.status(500).json({ message: 'Lỗi server khi nộp bài' });
  }
});

// Endpoint tải lịch sử
app.get('/history', async (req, res) => {
  try {
    const results = JSON.parse(await fs.readFile(RESULTS_FILE));
    res.json(results.map(r => ({
      _id: r._id,
      username: r.studentName,
      score: r.score,
      submittedAt: r.submittedAt,
    })));
  } catch (error) {
    console.error('Lỗi khi tải lịch sử:', error);
    res.status(500).json({ message: 'Lỗi server khi tải lịch sử' });
  }
});

// Endpoint xóa kết quả
app.post('/delete-results', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'Vui lòng cung cấp danh sách ID hợp lệ' });
    }
    let results = JSON.parse(await fs.readFile(RESULTS_FILE));
    results = results.filter(r => !ids.includes(r._id));
    await fs.writeFile(RESULTS_FILE, JSON.stringify(results));
    res.json({ message: 'Đã xóa các kết quả được chọn' });
  } catch (error) {
    console.error('Lỗi khi xóa kết quả:', error);
    res.status(500).json({ message: 'Lỗi server khi xóa kết quả' });
  }
});

// Endpoint xóa đề thi
app.delete('/delete-quiz/:quizId', async (req, res) => {
  try {
    const { quizId } = req.params;
    let quizzes = JSON.parse(await fs.readFile(QUIZZES_FILE));
    const quiz = quizzes.find(q => q._id === quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi' });
    }
    for (let audio of quiz.audioFiles) {
      try {
        await fs.unlink(audio.path);
      } catch (err) {
        console.warn(`Không thể xóa file audio ${audio.path}: ${err.message}`);
      }
    }
    for (let image of quiz.imageFiles) {
      try {
        await fs.unlink(image.path);
      } catch (err) {
        console.warn(`Không thể xóa file ảnh ${image.path}: ${err.message}`);
      }
    }
    quizzes = quizzes.filter(q => q._id !== quizId);
    await fs.writeFile(QUIZZES_FILE, JSON.stringify(quizzes));

    const status = JSON.parse(await fs.readFile(STATUS_FILE));
    if (status.quizId === quizId) {
      await fs.writeFile(STATUS_FILE, JSON.stringify({}));
      broadcast({ type: 'quizStatus', quizId: null, quizName: null });
    }

    res.json({ message: 'Đã xóa đề thi' });
  } catch (error) {
    console.error('Lỗi khi xóa đề thi:', error);
    res.status(500).json({ message: 'Lỗi server khi xóa đề thi' });
  }
});

// Endpoint xóa toàn bộ dữ liệu
app.delete('/clear-database', async (req, res) => {
  try {
    const quizzes = JSON.parse(await fs.readFile(QUIZZES_FILE));
    for (let quiz of quizzes) {
      for (let audio of quiz.audioFiles) {
        try {
          await fs.unlink(audio.path);
        } catch (err) {
          console.warn(`Không thể xóa file audio ${audio.path}: ${err.message}`);
        }
      }
      for (let image of quiz.imageFiles) {
        try {
          await fs.unlink(image.path);
        } catch (err) {
          console.warn(`Không thể xóa file ảnh ${image.path}: ${err.message}`);
        }
      }
    }
    await fs.writeFile(QUIZZES_FILE, JSON.stringify([]));
    await fs.writeFile(STATUS_FILE, JSON.stringify({}));
    await fs.writeFile(RESULTS_FILE, JSON.stringify([]));
    broadcast({ type: 'quizStatus', quizId: null, quizName: null });
    res.json({ message: 'Đã xóa toàn bộ dữ liệu' });
  } catch (error) {
    console.error('Lỗi khi xóa dữ liệu:', error);
    res.status(500).json({ message: 'Lỗi server khi xóa dữ liệu' });
  }
});

// Endpoint tải kết quả kiểm tra trực tiếp
app.get('/direct-results', async (req, res) => {
  try {
    const status = JSON.parse(await fs.readFile(STATUS_FILE));
    if (!status.quizId) {
      return res.status(404).json({ message: 'Chưa có đề thi nào được chọn' });
    }
    const results = JSON.parse(await fs.readFile(RESULTS_FILE));
    const directResults = results.filter(r => r.quizId === status.quizId);
    res.json(directResults.map(r => ({
      username: r.studentName,
      score: r.score,
      submittedAt: r.submittedAt,
    })));
  } catch (error) {
    console.error('Lỗi khi tải kết quả trực tiếp:', error);
    res.status(500).json({ message: 'Lỗi server khi tải kết quả trực tiếp' });
  }
});

// Endpoint tải file ZIP của đề thi
app.get('/download-quiz-zip/:quizId', async (req, res) => {
  try {
    const { quizId } = req.params;
    const quizzes = JSON.parse(await fs.readFile(QUIZZES_FILE));
    const quiz = quizzes.find(q => q._id === quizId);
    if (!quiz) {
      return res.status(404).json({ message: 'Không tìm thấy đề thi' });
    }

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename=quiz_${quizId}.zip`,
    });

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    for (let audio of quiz.audioFiles) {
      archive.file(audio.path, { name: `audio/part${audio.part}${path.extname(audio.path)}` });
    }
    for (let image of quiz.imageFiles) {
      archive.file(image.path, { name: `images/part${image.part}/${path.basename(image.path)}` });
    }
    archive.append(JSON.stringify(quiz.answerKey), { name: 'answerKey.json' });
    archive.append(JSON.stringify({
      quizName: quiz.quizName,
      createdBy: quiz.createdBy,
      createdAt: quiz.createdAt,
    }), { name: 'quizInfo.json' });

    archive.on('error', err => {
      console.error('Archive error:', err);
      res.status(500).json({ message: 'Lỗi khi tạo file ZIP' });
    });

    archive.finalize();
  } catch (error) {
    console.error('Lỗi khi tải file ZIP:', error);
    res.status(500).json({ message: 'Lỗi server khi tải file ZIP' });
  }
});

// Endpoint tải lên file JSON
app.post('/upload-quizzes', upload.single('quizzes'), async (req, res) => {
  try {
    const data = JSON.parse(await fs.readFile(req.file.path));
    const quizzes = JSON.parse(await fs.readFile(QUIZZES_FILE));
    for (let quiz of data) {
      quiz._id = await generateId();
      quiz.createdAt = new Date().toISOString();
      quizzes.push(quiz);
    }
    await fs.writeFile(QUIZZES_FILE, JSON.stringify(quizzes));
    await fs.unlink(req.file.path);
    res.json({ message: 'Tải lên đề thi thành công' });
  } catch (error) {
    console.error('Lỗi khi tải lên file JSON:', error);
    res.status(500).json({ message: 'Lỗi server khi tải lên file JSON' });
  }
});

// Endpoint tải lên file ZIP
app.post('/upload-quizzes-zip', upload.single('quizzes'), async (req, res) => {
  try {
    const zipDir = await unzipper.Open.file(req.file.path);
    let quizInfo, answerKey;
    const audioFiles = [];
    const imageFiles = [];

    for (let file of zipDir.files) {
      if (file.path === 'quizInfo.json') {
        quizInfo = JSON.parse(await file.buffer());
      } else if (file.path === 'answerKey.json') {
        answerKey = JSON.parse(await file.buffer());
      } else if (file.path.startsWith('audio/')) {
        const part = parseInt(file.path.match(/part(\d+)/)?.[1]);
        if (part) {
          const fileName = `audio-part${part}-${Date.now()}${path.extname(file.path)}`;
          const filePath = path.join(UPLOADS_DIR, 'audio', fileName);
          await fs.writeFile(filePath, await file.buffer());
          audioFiles.push({ part, path: filePath });
        }
      } else if (file.path.startsWith('images/')) {
        const part = parseInt(file.path.match(/part(\d+)/)?.[1]);
        if (part) {
          const fileName = `images-part${part}-${Date.now()}${path.extname(file.path)}`;
          const filePath = path.join(UPLOADS_DIR, 'images', fileName);
          await fs.writeFile(filePath, await file.buffer());
          imageFiles.push({ part, path: filePath });
        }
      }
    }

    if (!quizInfo || !answerKey) {
      return res.status(400).json({ message: 'File ZIP thiếu quizInfo.json hoặc answerKey.json' });
    }
    if (audioFiles.length < 4) {
      return res.status(400).json({ message: 'File ZIP thiếu file audio cho các phần' });
    }
    if (!imageFiles.some(img => img.part === 1) ||
        !imageFiles.some(img => img.part === 2) ||
        !imageFiles.some(img => img.part === 3) ||
        !imageFiles.some(img => img.part === 4) ||
        !imageFiles.some(img => img.part === 5) ||
        !imageFiles.some(img => img.part === 6) ||
        !imageFiles.some(img => img.part === 7)) {
      return res.status(400).json({ message: 'File ZIP thiếu file ảnh cho một hoặc nhiều phần' });
    }

    const expectedQuestions = 200;
    const questionKeys = Object.keys(answerKey);
    if (questionKeys.length !== expectedQuestions) {
      return res.status(400).json({ message: `Đáp án phải có đúng ${expectedQuestions} câu hỏi!` });
    }
    for (let i = 1; i <= expectedQuestions; i++) {
      if (!answerKey[`q${i}`] || !['A', 'B', 'C', 'D'].includes(answerKey[`q${i}`])) {
        return res.status(400).json({ message: `Đáp án cho câu q${i} phải là A, B, C hoặc D!` });
      }
    }

    const quizzes = JSON.parse(await fs.readFile(QUIZZES_FILE));
    const newQuiz = {
      _id: await generateId(),
      quizName: quizInfo.quizName,
      answerKey,
      createdBy: quizInfo.createdBy,
      audioFiles,
      imageFiles,
      createdAt: new Date().toISOString(),
    };
    quizzes.push(newQuiz);
    await fs.writeFile(QUIZZES_FILE, JSON.stringify(quizzes));
    await fs.unlink(req.file.path);
    res.json({ message: 'Tải lên đề thi từ file ZIP thành công' });
  } catch (error) {
    console.error('Lỗi khi tải lên file ZIP:', error);
    res.status(500).json({ message: 'Lỗi server khi tải lên file ZIP' });
  }
});

// Endpoint đăng xuất
app.post('/logout', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) {
      return res.status(400).json({ message: 'Vui lòng cung cấp username' });
    }
    const status = JSON.parse(await fs.readFile(STATUS_FILE));
    if (status.participants) {
      status.participants = status.participants.filter(p => p !== username);
      await fs.writeFile(STATUS_FILE, JSON.stringify(status));
      broadcastParticipantCount(status.participants.length);
    }
    res.json({ message: 'Đăng xuất thành công' });
  } catch (error) {
    console.error('Lỗi khi đăng xuất:', error);
    res.status(500).json({ message: 'Lỗi server khi đăng xuất' });
  }
});

// Endpoint trạng thái đề thi
app.get('/quiz-status', async (req, res) => {
  try {
    const status = JSON.parse(await fs.readFile(STATUS_FILE));
    res.json({
      quizId: status.quizId,
      quizName: status.quizName,
      isAssigned: status.isAssigned || false,
    });
  } catch (error) {
    console.error('Lỗi khi lấy trạng thái đề thi:', error);
    res.status(500).json({ message: 'Lỗi server khi lấy trạng thái đề thi' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});