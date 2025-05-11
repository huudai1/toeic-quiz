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
    }
    try {
      await fs.mkdir(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now