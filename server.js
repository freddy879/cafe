const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// MongoDB connection
const MONGO_URI = 'mongodb+srv://miguelfreddy78_db_user:rlH0wYeNjec78rRF@cluster0.oqhozkg.mongodb.net/lovechat?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI).then(() => console.log('✅ MongoDB conectado')).catch(e => console.error('❌ MongoDB error:', e));

// Schemas
const MessageSchema = new mongoose.Schema({
  sender: String,
  text: String,
  type: { type: String, default: 'text' }, // text, image, video, miss
  fileUrl: String,
  fileName: String,
  timestamp: { type: Date, default: Date.now }
});

const StreakSchema = new mongoose.Schema({
  count: { type: Number, default: 0 },
  lastActive: { type: Date, default: Date.now },
  freddyLastSeen: Date,
  abyLastSeen: Date
});

const MissSchema = new mongoose.Schema({
  from: String,
  timestamp: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', MessageSchema);
const Streak = mongoose.model('Streak', StreakSchema);
const Miss = mongoose.model('Miss', MissSchema);

// Uploads folder
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json());
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(__dirname));

// Connected users
const connectedUsers = {};

// Streak logic
async function updateStreak(user) {
  let streak = await Streak.findOne();
  if (!streak) streak = new Streak();
  const now = new Date();
  const today = now.toDateString();
  
  if (user === 'freddy') streak.freddyLastSeen = now;
  if (user === 'aby') streak.abyLastSeen = now;

  const fSeen = streak.freddyLastSeen ? new Date(streak.freddyLastSeen).toDateString() : null;
  const aSeen = streak.abyLastSeen ? new Date(streak.abyLastSeen).toDateString() : null;

  if (fSeen === today && aSeen === today) {
    const lastActive = streak.lastActive ? new Date(streak.lastActive).toDateString() : null;
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toDateString();
    if (lastActive !== today) {
      if (lastActive === yesterdayStr) streak.count += 1;
      else if (lastActive !== today) streak.count = 1;
      streak.lastActive = now;
    }
  }
  await streak.save();
  return streak;
}

// Routes
app.get('/api/messages', async (req, res) => {
  const msgs = await Message.find().sort({ timestamp: 1 }).limit(100);
  res.json(msgs);
});

app.get('/api/streak', async (req, res) => {
  let streak = await Streak.findOne();
  if (!streak) streak = new Streak();
  res.json(streak);
});

app.get('/api/miss/last', async (req, res) => {
  const miss = await Miss.findOne().sort({ timestamp: -1 });
  res.json(miss);
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const { sender, type } = req.body;
  const fileUrl = `/uploads/${req.file.filename}`;
  const msg = new Message({ sender, type, fileUrl, fileName: req.file.originalname, text: type === 'image' ? '📷 Foto' : '🎥 Video' });
  await msg.save();
  io.emit('message', msg);
  res.json(msg);
});

// Socket.io
io.on('connection', (socket) => {
  console.log('🔌 Conectado:', socket.id);

  socket.on('join', async ({ user }) => {
    connectedUsers[socket.id] = user;
    socket.broadcast.emit('user-online', { user, online: true });
    const streak = await updateStreak(user);
    io.emit('streak-update', streak);
    io.emit('online-users', Object.values(connectedUsers));
  });

  socket.on('send-message', async ({ sender, text }) => {
    const msg = new Message({ sender, text, type: 'text' });
    await msg.save();
    io.emit('message', msg);
  });

  socket.on('miss-you', async ({ from }) => {
    const miss = new Miss({ from });
    await miss.save();
    io.emit('miss-you-alert', { from, timestamp: miss.timestamp });
  });

  socket.on('typing', ({ user }) => {
    socket.broadcast.emit('typing', { user });
  });

  socket.on('stop-typing', () => {
    socket.broadcast.emit('stop-typing');
  });

  socket.on('disconnect', () => {
    const user = connectedUsers[socket.id];
    delete connectedUsers[socket.id];
    if (user) {
      socket.broadcast.emit('user-online', { user, online: false });
      io.emit('online-users', Object.values(connectedUsers));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`💕 LoveChat corriendo en http://localhost:${PORT}`));
