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

// Endpoint để lấy trạng thái đề thi
app.get('/quiz-status', async (req, res) => {
  try {
    if (!currentQuiz) {
      return res.status(200).json({ quizId: null, quizName: null });
    }
    res.status(200).json({ quizId: currentQuiz.quizId, quizName: currentQuiz.quizName });
  } catch (err) {
    console.error('Error fetching quiz status:', err);
    res.status(500).json({ message: 'Error fetching quiz status' });
  }
});

// Endpoint để lấy kết quả kiểm tra trực tiếp
app.get('/direct-results', async (req, res) => {
  try {
    if (!currentQuiz) {
      return res.status(200).json([]);
    }
    const quizResults = results.filter(r => r.quizId === currentQuiz