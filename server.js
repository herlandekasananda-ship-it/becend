// server.js (Backend khusus Socket.io + Lowdb - Versi Final Anti-Crash Render)
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { JSONFilePreset } from 'lowdb/node';
import path from 'path';
import fs from 'fs';
import cors from 'cors';

const app = express();
app.use(cors());

// Rute ping ringan untuk menjaga server tetap aktif (bisa ditembak UptimeRobot)
app.get('/ping', (req, res) => {
  res.send('Server Customer Service Aktif!');
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ["https://world-convert.vercel.app", "http://localhost:3000"],
    methods: ["GET", "POST"]
  }
});

// 🚀 1. STRATEGI STORAGE FILE UNTUK RENDER PERSISTENT DISK
const IS_RENDER = process.env.RENDER === 'true';
const STORAGE_DIR = IS_RENDER ? '/data' : process.cwd();
const dbPath = path.join(STORAGE_DIR, 'db.json');

const defaultData = { chats: [] };

// 🎯 SOLUSI BAD GATEWAY & EACCES: 
// Membuat file db.json kosongan secara instan via fs.writeFileSync jika belum ada di persistent disk.
// Kita tidak menggunakan fs.mkdirSync karena folder '/data' sudah otomatis dikelola oleh Render Disk.
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, JSON.stringify(defaultData, null, 2), 'utf-8');
}

// Inisialisasi Lowdb setelah file dipastikan aman berada di sistem
const db = await JSONFilePreset(dbPath, defaultData);

// Variabel global untuk menyimpan Socket ID milik admin yang sedang online
let agentSocketId = null;

// 🚀 2. LOGIKA KONEKSI SOCKET.IO
io.on('connection', async (socket) => {
  // Ambil data autentikasi dari client (baik user maupun admin)
  const { username, locale, role } = socket.handshake.auth;

  // ----------------------------------------------------------------------
  // A. JIKA YANG TERHUBUNG ADALAH ADMIN / AGENT
  // ----------------------------------------------------------------------
  if (role === 'agent') {
    agentSocketId = socket.id;
    console.log(`👨‍💼 Admin/Agent Support telah masuk online. ID: ${socket.id}`);
    
    // Kirim seluruh data sesi aktif dari Lowdb ke admin yang baru login
    await db.read();
    socket.emit('update_sessions', db.data.chats);

    // Kirim list sesi saat admin meminta pembaruan manual
    socket.on('get_all_sessions', async () => {
      await db.read();
      socket.emit('update_sessions', db.data.chats);
    });

    // Mendengarkan saat admin membalas chat ke salah satu user
    socket.on('send_agent_message', async (data) => {
      await db.read();
      const session = db.data.chats.find(c => c.socketId === data.targetSocketId);
      
      if (session) {
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const newMsg = {
          id: Math.random().toString(),
          sender: 'agent',
          text: data.text,
          timestamp: timestamp
        };

        // Catat balasan admin ke dalam db.json milik user target
        session.messages.push(newMsg);
        await db.write();

        // Kirimkan balon chat balasan admin langsung ke layar user target secara real-time
        io.to(data.targetSocketId).emit('receive_message', newMsg);
        console.log(`📡 Agen membalas ke [${session.username}]: ${data.text}`);
      }
    });
  }

  // ----------------------------------------------------------------------
  // B. JIKA YANG TERHUBUNG ADALAH USER BIASA / PELANGGAN
  // ----------------------------------------------------------------------
  if (username && role !== 'agent') {
    await db.read(); // Baca data terbaru dari file disk

    // Cari apakah user ini sudah pernah membuat sesi chat sebelumnya
    let session = db.data.chats.find(c => c.username === username);

    if (!session) {
      // Jika user baru pertama kali masuk, buat struktur sesi baru
      session = {
        socketId: socket.id,
        username: username,
        locale: locale || 'en',
        joinedAt: new Date().toISOString(),
        messages: []
      };
      db.data.chats.push(session);
    } else {
      // Jika user lama balik lagi, perbarui ID socket-nya agar tetap sinkron
      session.socketId = socket.id;
    }

    await db.write(); // Tulis kembali data terbaru secara aman ke db.json
    console.log(`💬 User [${username}] berhasil masuk ruang chat. ID: ${socket.id}`);

    // Beritahu admin (jika sedang online) bahwa ada antrean user baru/reconnected
    if (agentSocketId) {
      io.to(agentSocketId).emit('update_sessions', db.data.chats);
    }
  }

  // ----------------------------------------------------------------------
  // C. MENDENGARKAN PESAN MASUK DARI PENGGUNA (USER)
  // ----------------------------------------------------------------------
  socket.on('send_message', async (data) => {
    await db.read();
    
    // Cari sesi obrolan yang memiliki socket id pengirim
    const session = db.data.chats.find(c => c.socketId === socket.id);

    if (session) {
      const msgPayload = {
        id: Math.random().toString(),
        sender: 'user',
        text: data.text,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };

      // Tambahkan balon pesan baru ke dalam array pesan milik user tersebut
      session.messages.push(msgPayload);
      await db.write(); // Tulis riwayat pesan ke dalam db.json secara real-time
      console.log(`📩 Pesan baru dari [${session.username}]: ${data.text}`);

      // Teruskan pesan baru user ini ke layar admin secara real-time jika admin aktif
      if (agentSocketId) {
        io.to(agentSocketId).emit('receive_message', {
          socketId: socket.id,
          message: msgPayload
        });
        // Sekaligus update list teks preview terakhir di sidebar antrean admin
        io.to(agentSocketId).emit('update_sessions', db.data.chats);
      }
    }
  });

  // Penanganan ketika pengguna menutup tab atau memutuskan koneksi
  socket.on('disconnect', () => {
    if (socket.id === agentSocketId) {
      agentSocketId = null;
      console.log('❌ Admin/Agent Support telah keluar (offline).');
    } else {
      console.log(`❌ User dengan Socket ID ${socket.id} telah keluar.`);
    }
  });
});

// Jalankan server backend di port 4000 (atau port dinamis dari Render)
const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`⚡ Server Socket.io + Lowdb berjalan lancar di port ${PORT}`);
});