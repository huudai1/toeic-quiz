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

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

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

app.get("/quiz-status", async (req, res) => {
  try {
    if (!currentQuiz) {
      return res.status(200).json({ quizId: null, quizName: null });
    }
    res.status(200).json({ quizId: currentQuiz.quizId, quizName: currentQuiz.quizName });
  } catch (err) {
    console.error("Error fetching quiz status:", err);
    res.status(500).json({ message: "Error fetching quiz status" });
  }
});

app.get("/direct-results", async (req, res) => {
  try {
    if (!currentQuiz) {
      return res.status(200).json([]);
    }
    const quizResults = results.filter(r => r.quizId === currentQuiz.quizId);
    res.status(200).json(quizResults);
  } catch (err) {
    console.error("Error fetching direct results:", err);
    res.status(500).json({ message: "Error fetching direct results" });
  }
});

app.get("/quizzes", async (req, res) => {
  try {
    const email = req.query.email;
    if (email) {
      const userQuizzes = quizzes.filter(quiz => quiz.createdBy === email);
      res.json(userQuizzes);
    } else {
      const availableQuizzes = quizzes.filter(quiz => quiz.isAssigned);
      res.json(availableQuizzes);
    }
  } catch (err) {
    console.error("Error fetching quizzes:", err);
    res.status(500).json({ message: "Error fetching quizzes" });
  }
});

app.get("/quiz-audio", async (req, res) => {
  try {
    if (!currentQuiz) {
      return res.status(400).json({ message: "No quiz selected" });
    }
    const part = req.query.part;
    const audioPath = currentQuiz.audio[part];
    if (!audioPath) {
      return res.status(404).json({ message: `No audio for ${part}` });
    }
    res.json({ audio: audioPath });
  } catch (err) {
    console.error("Error fetching audio:", err);
    res.status(500).json({ message: "Error fetching audio" });
  }
});

app.get("/images", async (req, res) => {
  try {
    if (!currentQuiz) {
      return res.status(400).json({ message: "No quiz selected" });
    }
    const part = req.query.part;
    const images = currentQuiz.images[`part${part}`] || [];
    res.json(images);
  } catch (err) {
    console.error("Error fetching images:", err);
    res.status(500).json({ message: "Error fetching images" });
  }
});

app.post(
  "/save-quiz",
  upload.fields([
    { name: "audio-part1", maxCount: 1 },
    { name: "audio-part2", maxCount: 1 },
    { name: "audio-part3", maxCount: 1 },
    { name: "audio-part4", maxCount: 1 },
    { name: "images-part1", maxCount: 100 },
    { name: "images-part2", maxCount: 100 },
    { name: "images-part3", maxCount: 100 },
    { name: "images-part4", maxCount: 100 },
    { name: "images-part5", maxCount: 100 },
    { name: "images-part6", maxCount: 100 },
    { name: "images-part7", maxCount: 100 },
  ]),
  async (req, res) => {
    try {
      const { quizName, answerKey, createdBy } = req.body;
      if (!quizName || !answerKey || !createdBy) {
        return res.status(400).json({ message: "Thiếu các trường bắt buộc: quizName, answerKey, hoặc createdBy" });
      }

      let parsedAnswerKey;
      try {
        parsedAnswerKey = JSON.parse(answerKey);
        if (Object.keys(parsedAnswerKey).length !== 200) {
          return res.status(400).json({ message: "Answer key phải có đúng 200 câu trả lời" });
        }
      } catch (err) {
        return res.status(400).json({ message: "Answer key không hợp lệ" });
      }

      const audioPaths = {};
      for (let i = 1; i <= 4; i++) {
        if (!req.files[`audio-part${i}`]) {
          return res.status(400).json({ message: `Thiếu file audio cho Part ${i}` });
        }
        const audioFile = req.files[`audio-part${i}`][0];
        audioPaths[`part${i}`] = `/uploads/audio/${audioFile.filename}`;
      }

      const images = {};
      for (let i = 1; i <= 7; i++) {
        if (!req.files[`images-part${i}`] || req.files[`images-part${i}`].length === 0) {
          return res.status(400).json({ message: `Thiếu ảnh cho Part ${i}` });
        }
        images[`part${i}`] = req.files[`images-part${i}`].map((file) => `/uploads/images/${file.filename}`);
      }

      const quiz = {
        quizId: uuidv4(),
        quizName,
        audio: audioPaths,
        images,
        answerKey: parsedAnswerKey,
        createdBy,
        isAssigned: false,
      };

      quizzes.push(quiz);
      await saveQuizzes();

      res.status(200).json({ message: "Đã lưu đề thi thành công!" });
    } catch (err) {
      console.error("Error saving quiz:", err);
      res.status(500).json({ message: "Lỗi khi lưu đề thi: " + err.message });
    }
  }
);

app.post("/upload-quizzes", upload.single("quizzes"), async (req, res) => {
  try {
    const filePath = req.file.path;
    const data = await fs.readFile(filePath, "utf8");
    const uploadedQuizzes = JSON.parse(data);

    for (const quiz of uploadedQuizzes) {
      if (!quiz.quizId || !quiz.quizName || !quiz.audio || !quiz.images || !quiz.answerKey || !quiz.createdBy) {
        return res.status(400).json({ message: "Invalid quiz format" });
      }
      quizzes.push({ ...quiz, quizId: uuidv4() });
    }

    await saveQuizzes();
    await fs.unlink(filePath);
    res.json({ message: "Quizzes uploaded successfully" });
  } catch (err) {
    console.error("Error uploading quizzes:", err);
    res.status(500).json({ message: "Error uploading quizzes: " + err.message });
  }
});

app.post("/upload-quizzes-zip", upload.single("quizzes"), async (req, res) => {
  try {
    const zipPath = req.file.path;
    const extractPath = path.join(__dirname, "temp", uuidv4());
    await fs.mkdir(extractPath, { recursive: true });

    await new Promise((resolve, reject) => {
      fsSync.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: extractPath }))
        .on("close", resolve)
        .on("error", reject);
    });

    const quizJsonPath = path.join(extractPath, "quiz.json");
    const quizData = JSON.parse(await fs.readFile(quizJsonPath, "utf8"));

    const audioPaths = {};
    for (let i = 1; i <= 4; i++) {
      const audioFile = path.join(extractPath, `audio-part${i}${path.extname(quizData.audio[`part${i}`])}`);
      if (fsSync.existsSync(audioFile)) {
        const newPath = path.join(__dirname, "public/uploads/audio", `${uuidv4()}${path.extname(audioFile)}`);
        await fs.rename(audioFile, newPath);
        audioPaths[`part${i}`] = `/uploads/audio/${path.basename(newPath)}`;
      } else {
        return res.status(400).json({ message: `Missing audio file for part ${i}` });
      }
    }

    const images = {};
    for (let i = 1; i <= 7; i++) {
      images[`part${i}`] = [];
      for (const img of quizData.images[`part${i}`]) {
        const imgPath = path.join(extractPath, path.basename(img));
        if (fsSync.existsSync(imgPath)) {
          const newPath = path.join(__dirname, "public/uploads/images", `${uuidv4()}${path.extname(img)}`);
          await fs.rename(imgPath, newPath);
          images[`part${i}`].push(`/uploads/images/${path.basename(newPath)}`);
        } else {
          return res.status(400).json({ message: `Missing image for part ${i}` });
        }
      }
    }

    const quiz = {
      quizId: uuidv4(),
      quizName: quizData.quizName,
      audio: audioPaths,
      images,
      answerKey: quizData.answerKey,
      createdBy: quizData.createdBy,
      isAssigned: false,
    };

    quizzes.push(quiz);
    await saveQuizzes();
    await fs.unlink(zipPath);
    await fs.rm(extractPath, { recursive: true, force: true });

    res.json({ message: "Quiz ZIP uploaded successfully" });
  } catch (err) {
    console.error("Error uploading quiz ZIP:", err);
    res.status(500).json({ message: "Error uploading quiz ZIP: " + err.message });
  }
});

app.get("/download-quiz-zip/:quizId", async (req, res) => {
  try {
    const quiz = quizzes.find(q => q.quizId === req.params.quizId);
    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found" });
    }

    const archive = archiver("zip");
    res.attachment(`quiz_${quiz.quizId}.zip`);
    archive.pipe(res);

    const quizJson = {
      quizName: quiz.quizName,
      audio: quiz.audio,
      images: quiz.images,
      answerKey: quiz.answerKey,
      createdBy: quiz.createdBy,
    };
    archive.append(JSON.stringify(quizJson, null, 2), { name: "quiz.json" });

    for (let i = 1; i <= 4; i++) {
      const audioPath = path.join(__dirname, "public", quiz.audio[`part${i}`].slice(1));
      if (fsSync.existsSync(audioPath)) {
        archive.file(audioPath, { name: `audio-part${i}${path.extname(audioPath)}` });
      }
    }

    for (let i = 1; i <= 7; i++) {
      for (const img of quiz.images[`part${i}`]) {
        const imgPath = path.join(__dirname, "public", img.slice(1));
        if (fsSync.existsSync(imgPath)) {
          archive.file(imgPath, { name: path.basename(img) });
        }
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error("Error downloading quiz ZIP:", err);
    res.status(500).json({ message: "Error downloading quiz ZIP: " + err.message });
  }
});

app.delete("/clear-database", async (req, res) => {
  try {
    quizzes = [];
    results = [];
    currentQuiz = null;
    await saveQuizzes();
    await saveResults();
    broadcast({ type: "quizStatus", quizId: null, quizName: null });
    res.json({ message: "Database cleared successfully" });
  } catch (err) {
    console.error("Error clearing database:", err);
    res.status(500).json({ message: "Error clearing database" });
  }
});

app.delete("/delete-quiz/:quizId", async (req, res) => {
  try {
    const quizId = req.params.quizId;
    const quiz = quizzes.find(q => q.quizId === quizId);
    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found" });
    }

    for (let i = 1; i <= 4; i++) {
      const audioPath = path.join(__dirname, "public", quiz.audio[`part${i}`].slice(1));
      if (fsSync.existsSync(audioPath)) {
        await fs.unlink(audioPath);
      }
    }

    for (let i = 1; i <= 7; i++) {
      for (const img of quiz.images[`part${i}`]) {
        const imgPath = path.join(__dirname, "public", img.slice(1));
        if (fsSync.existsSync(imgPath)) {
          await fs.unlink(imgPath);
        }
      }
    }

    quizzes = quizzes.filter(q => q.quizId !== quizId);
    if (currentQuiz && currentQuiz.quizId === quizId) {
      currentQuiz = null;
      broadcast({ type: "quizStatus", quizId: null, quizName: null });
    }
    await saveQuizzes();
    res.json({ message: "Quiz deleted successfully" });
  } catch (err) {
    console.error("Error deleting quiz:", err);
    res.status(500).json({ message: "Error deleting quiz" });
  }
});

app.post("/select-quiz", async (req, res) => {
  try {
    const { quizId } = req.body;
    if (!quizId) {
      return res.status(400).json({ message: "Quiz ID is required" });
    }
    const quiz = quizzes.find(q => q.quizId === quizId);
    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found" });
    }
    currentQuiz = quiz;
    broadcast({ type: "quizStatus", quizId: quiz.quizId, quizName: quiz.quizName });
    res.json({ message: "Quiz selected successfully", quizName: quiz.quizName });
  } catch (err) {
    console.error("Error selecting quiz:", err);
    res.status(500).json({ message: "Error selecting quiz" });
  }
});

app.post("/assign-quiz", async (req, res) => {
  try {
    const { quizId, timeLimit } = req.body;
    if (!quizId || !timeLimit) {
      return res.status(400).json({ message: "Quiz ID and time limit are required" });
    }
    const quiz = quizzes.find(q => q.quizId === quizId);
    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found" });
    }
    quiz.isAssigned = true;
    quiz.timeLimit = timeLimit;
    currentQuiz = quiz;
    await saveQuizzes();
    broadcast({ type: "quizStatus", quizId: quiz.quizId, quizName: quiz.quizName });
    res.json({ message: "Quiz assigned successfully" });
  } catch (err) {
    console.error("Error assigning quiz:", err);
    res.status(500).json({ message: "Error assigning quiz" });
  }
});

app.post("/submit", async (req, res) => {
  try {
    const { username, answers } = req.body;
    if (!username || !answers || !currentQuiz) {
      return res.status(400).json({ message: "Missing required fields or no quiz selected" });
    }

    let score = 0;
    for (let i = 1; i <= 200; i++) {
      const q = `q${i}`;
      if (answers[q] === currentQuiz.answerKey[q]) {
        score++;
      }
    }

    const result = {
      id: uuidv4(),
      quizId: currentQuiz.quizId,
      username,
      score,
      answers,
      submittedAt: new Date().toISOString(),
    };

    results.push(result);
    await saveResults();

    broadcast({
      type: "submittedCount",
      count: results.filter(r => r.quizId === currentQuiz.quizId).length,
      results: results.filter(r => r.quizId === currentQuiz.quizId),
    });

    res.json({ score });
  } catch (err) {
    console.error("Error submitting quiz:", err);
    res.status(500).json({ message: "Error submitting quiz" });
  }
});

app.get("/history", async (req, res) => {
  try {
    res.json(results);
  } catch (err) {
    console.error("Error fetching history:", err);
    res.status(500).json({ message: "Error fetching history" });
  }
});

app.post("/delete-results", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({ message: "Invalid IDs" });
    }
    results = results.filter(r => !ids.includes(r.id));
    await saveResults();
    res.json({ message: "Results deleted successfully" });
  } catch (err) {
    console.error("Error deleting results:", err);
    res.status(500).json({ message: "Error deleting results" });
  }
});

app.post("/logout", async (req, res) => {
  try {
    const { username } = req.body;
    if (username) {
      clients.forEach(client => {
        if (client.username === username) {
          clients.delete(client);
        }
      });
      broadcast({ type: "participantCount", count: clients.size });
    }
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    console.error("Error during logout:", err);
    res.status(500).json({ message: "Error during logout" });
  }
});

function broadcast(message) {
  clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(message));
    }
  });
}

const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  clients.add(ws);
  broadcast({ type: "participantCount", count: clients.size });

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === "login" && data.username) {
        ws.username = data.username;
      } else if (data.type === "requestQuizStatus") {
        ws.send(JSON.stringify({
          type: "quizStatus",
          quizId: currentQuiz ? currentQuiz.quizId : null,
          quizName: currentQuiz ? currentQuiz.quizName : null,
        }));
        ws.send(JSON.stringify({
          type: "participantCount",
          count: clients.size,
        }));
        if (currentQuiz) {
          ws.send(JSON.stringify({
            type: "submittedCount",
            count: results.filter(r => r.quizId === currentQuiz.quizId).length,
            results: results.filter(r => r.quizId === currentQuiz.quizId),
          }));
        }
      } else if (data.type === "quizSelected") {
        const quiz = quizzes.find(q => q.quizId === data.quizId);
        if (quiz) {
          currentQuiz = quiz;
          broadcast({ type: "quizStatus", quizId: quiz.quizId, quizName: quiz.quizName });
        }
      } else if (data.type === "quizAssigned") {
        const quiz = quizzes.find(q => q.quizId === data.quizId);
        if (quiz) {
          quiz.isAssigned = true;
          quiz.timeLimit = data.timeLimit;
          currentQuiz = quiz;
          saveQuizzes();
          broadcast({ type: "quizStatus", quizId: quiz.quizId, quizName: quiz.quizName });
        }
      } else if (data.type === "start") {
        broadcast({ type: "start", timeLimit: data.timeLimit });
      } else if (data.type === "end") {
        broadcast({ type: "end" });
      } else if (data.type === "submitted") {
        broadcast({
          type: "submittedCount",
          count: results.filter(r => r.quizId === currentQuiz.quizId).length,
          results: results.filter(r => r.quizId === currentQuiz.quizId),
        });
      }
    } catch (err) {
      console.error("Error handling WebSocket message:", err);
      ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    broadcast({ type: "participantCount", count: clients.size });
  });
});