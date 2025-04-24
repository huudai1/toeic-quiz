const express = require("express");
const app = express();
const http = require("http").createServer(app);
const WebSocket = require("ws");
const fs = require("fs").promises;
const path = require("path");
const multer = require("multer");

const wss = new WebSocket.Server({ server: http });
const clients = new Set();
let quizStarted = false;
let submittedCount = 0;

// In-memory storage
let quizData = {
  audioUrl: "",
  images: {},
  answerKey: {},
};
let results = [];

// Multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const dir = file.mimetype.startsWith("audio/")
      ? "public/uploads/audio"
      : "public/uploads/images";
    await fs.mkdir(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});
const upload = multer({ storage });

// Middleware
app.use(express.static("public"));
app.use(express.json());

// Routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "views", "index.html"));
});

app.post("/save-quiz", upload.fields([
  { name: "audio", maxCount: 1 },
  { name: "images-part1" },
  { name: "images-part2" },
  { name: "images-part3" },
  { name: "images-part4" },
  { name: "images-part5" },
  { name: "images-part6" },
  { name: "images-part7" },
  { name: "answerKey" },
]), async (req, res) => {
  try {
    // Save audio
    if (req.files["audio"]) {
      const file = req.files["audio"][0];
      quizData.audioUrl = `/uploads/audio/${file.filename}`;
    }

    // Save images
    quizData.images = {};
    for (let i = 1; i <= 7; i++) {
      const key = `images-part${i}`;
      quizData.images[i] = [];
      if (req.files[key]) {
        for (let file of req.files[key]) {
          quizData.images[i].push(`/uploads/images/${file.filename}`);
        }
      }
    }

    // Save answer key
    quizData.answerKey = JSON.parse(req.body.answerKey || "{}");
    if (Object.keys(quizData.answerKey).length !== 200) {
      return res.status(400).json({ message: "Đáp án đúng phải có đúng 200 câu!" });
    }
    for (const [question, answer] of Object.entries(quizData.answerKey)) {
      if (!["A", "B", "C", "D"].includes(answer)) {
        return res.status(400).json({ message: `Đáp án ${question} không hợp lệ!` });
      }
    }

    res.json({ message: "Đã lưu đề thi!" });
  } catch (error) {
    console.error("Save quiz error:", error);
    res.status(500).json({ message: "Lỗi khi lưu đề thi!" });
  }
});

app.get("/images", (req, res) => {
  const part = req.query.part;
  res.json(quizData.images[part] || []);
});

app.post("/submit", (req, res) => {
  const { username, answers } = req.body;
  let score = 0;

  for (let i = 1; i <= 200; i++) {
    if (answers[`q${i}`] && answers[`q${i}`] === quizData.answerKey[`q${i}`]) {
      score++;
    }
  }

  const timestamp = new Date().toISOString();
  results.push({ username, score, timestamp });

  submittedCount++;
  broadcast({ type: "submittedCount", count: submittedCount });
  res.json({ score, total: 200 });
});

app.get("/results", (req, res) => {
  res.json(results);
});

app.get("/quiz-status", (req, res) => {
  res.json({ quizExists: quizData.audioUrl || Object.keys(quizData.images).length > 0 });
});

app.post("/reset", (req, res) => {
  quizStarted = false;
  submittedCount = 0;
  results = [];
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "end" }));
    }
  });
  res.json({ message: "Đã reset trạng thái, sẵn sàng cho lớp mới!" });
});

// WebSocket
wss.on("connection", (ws) => {
  clients.add(ws);
  broadcastParticipantCount();

  ws.on("message", (message) => {
    const data = JSON.parse(message);
    if (data.type === "start") {
      quizStarted = true;
      broadcast({ type: "start" });
    }
    if (data.type === "end") {
      quizStarted = false;
      broadcast({ type: "end" });
    }
    if (data.type === "submitted") {
      broadcast({ type: "submitted", username: data.username });
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    broadcastParticipantCount();
  });
});

function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function broadcastParticipantCount() {
  broadcast({ type: "participantCount", count: clients.size });
}

// Start Server
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});