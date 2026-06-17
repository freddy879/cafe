const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'DELETE'] }
});

app.use(cors());
app.use(express.json());

// ── MongoDB ──
const MONGO_URI = 'mongodb+srv://miguelfreddy78_db_user:rlH0wYeNjec78rRF@cluster0.oqhozkg.mongodb.net/lovechat?retryWrites=true&w=majority';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB conectado'))
  .catch(e => console.error('❌ MongoDB error:', e));

// ── Schemas ──
const MessageSchema = new mongoose.Schema({
  sender: String,
  text: String,
  type: { type: String, default: 'text' }, // text | image | video | sticker | miss
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
const Streak   = mongoose.model('Streak', StreakSchema);
const Miss     = mongoose.model('Miss', MissSchema);

// ── Uploads ──
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename:    (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));

// ── Streak logic ──
async function updateStreak(user) {
  let streak = await Streak.findOne();
  if (!streak) streak = new Streak();
  const now = new Date();
  const today = now.toDateString();

  if (user === 'freddy') streak.freddyLastSeen = now;
  if (user === 'aby')    streak.abyLastSeen = now;

  const fSeen = streak.freddyLastSeen ? new Date(streak.freddyLastSeen).toDateString() : null;
  const aSeen = streak.abyLastSeen    ? new Date(streak.abyLastSeen).toDateString()    : null;

  if (fSeen === today && aSeen === today) {
    const lastActive  = streak.lastActive ? new Date(streak.lastActive).toDateString() : null;
    const yesterday   = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toDateString();
    if (lastActive !== today) {
      streak.count    = lastActive === yesterdayStr ? streak.count + 1 : 1;
      streak.lastActive = now;
    }
  }
  await streak.save();
  return streak;
}

// ── REST Routes ──
app.get('/api/messages', async (req, res) => {
  const msgs = await Message.find().sort({ timestamp: 1 }).limit(200);
  res.json(msgs);
});

app.get('/api/streak', async (req, res) => {
  let streak = await Streak.findOne();
  if (!streak) streak = new Streak();
  res.json(streak);
});

app.get('/api/miss/last', async (req, res) => {
  const miss = await Miss.findOne().sort({ timestamp: -1 });
  res.json(miss || {});
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const { sender, type } = req.body;
  const fileUrl = `/uploads/${req.file.filename}`;
  const msg = new Message({
    sender,
    type,
    fileUrl,
    fileName: req.file.originalname,
    text: type === 'image' ? '📷 Foto' : '🎥 Video'
  });
  await msg.save();
  io.emit('message', msg);
  res.json(msg);
});

// FIX: endpoint para borrar mensaje
app.delete('/api/messages/:id', async (req, res) => {
  try {
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'No encontrado' });

    // Borrar archivo físico si existe
    if (msg.fileUrl) {
      const filePath = path.join(__dirname, msg.fileUrl);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await Message.findByIdAndDelete(req.params.id);
    // Notificar a todos en tiempo real
    io.emit('message-deleted', { id: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    console.error('Error borrando mensaje:', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ── Connected users & GPS ──
const connectedUsers = {};
// Guarda la última ubicación conocida de cada usuario en memoria
const userLocations = {};

// ── Socket.io ──
io.on('connection', (socket) => {
  console.log('🔌 Conectado:', socket.id);

  socket.on('join', async ({ user }) => {
    connectedUsers[socket.id] = user;
    socket.broadcast.emit('user-online', { user, online: true });
    const streak = await updateStreak(user);
    io.emit('streak-update', streak);
    io.emit('online-users', Object.values(connectedUsers));

    // Si el otro ya tenía ubicación guardada, enviársela a quien acaba de entrar
    const otherUser = user === 'freddy' ? 'aby' : 'freddy';
    if (userLocations[otherUser]) {
      socket.emit('partner-location', userLocations[otherUser]);
    }
  });

  // FIX: send-message ahora guarda el tipo correctamente (sticker, text, etc.)
  socket.on('send-message', async ({ sender, text, type = 'text' }) => {
    const msg = new Message({ sender, text, type });
    await msg.save();
    io.emit('message', msg);
  });

  // FIX: share-location — reenvía la ubicación al otro usuario
  socket.on('share-location', ({ from, lat, lng }) => {
    // Guardar en memoria para que quien se conecte después también la reciba
    userLocations[from] = { lat, lng };
    // Emitir a todos los demás (solo le llegará a la pareja)
    socket.broadcast.emit('partner-location', { lat, lng });
  });

  socket.on('miss-you', async ({ from }) => {
    const miss = new Miss({ from });
    await miss.save();
    io.emit('miss-you-alert', { from, timestamp: miss.timestamp });
  });

  socket.on('typing',      ({ user }) => socket.broadcast.emit('typing', { user }));
  socket.on('stop-typing', ()         => socket.broadcast.emit('stop-typing'));

  // FIX: delete-message via socket (borra en BD y notifica a todos)
  socket.on('delete-message', async ({ id, user }) => {
    try {
      const msg = await Message.findById(id);
      if (!msg) return;
      if (msg.sender !== user) return; // solo puede borrar el que lo envió

      if (msg.fileUrl) {
        const filePath = path.join(__dirname, msg.fileUrl);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }

      await Message.findByIdAndDelete(id);
      io.emit('message-deleted', { id });
    } catch (err) {
      console.error('Error borrando via socket:', err);
    }
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
server.listen(PORT, () => console.log(`💕 LoveChat corriendo en el puerto ${PORT}`));
