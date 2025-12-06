const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const socketIO = require('socket.io');
const qrcode = require('qrcode');
const http = require('http');
const fs = require('fs');
const { phoneNumberFormatter } = require('./helpers/formatter');
const fileUpload = require('express-fileupload');
const axios = require('axios');
const port = process.env.PORT || 8000;
const deviceName = process.env.DEVICE_NAME || 'Penguin';

const os = require("os");
const isWindows = os.platform() === "win32";

const { exec } = require("child_process");
const path = require('path');


const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(express.urlencoded({
  extended: true
}));

function killChromeProcess(sessionPath) {
  return new Promise(resolve => {
    const escapedPath = sessionPath.replace(/\\/g, "\\\\");

    let cmd;

    if (isWindows) {
      cmd = `wmic process where "CommandLine like '%${escapedPath}%' and name='chrome.exe'" delete`;
    } else {
      // Linux: cari jalur chrome/chromium dengan argumen folder session
      cmd = `pkill -f "${sessionPath}"`;
    }

    exec(cmd, (err) => {
      if (err) {
        console.log("Tidak ada chrome/chromium terkait untuk dibunuh:", err.message);
      } else {
        console.log("Chrome/Chromium process untuk session dihentikan.");
      }
      resolve();
    });
  });
}


async function removeSessionFolder(id, client = null) {
  const sessionPath = path.join(__dirname, ".wwebjs_auth", `session-${id}`);

  try {
    console.log("Menutup client:", id);

    // Tutup client WhatsApp
    if (client) {
      try { await client.destroy(); } catch {}
      try { await client.pupBrowser?.close(); } catch {}
    }

    // Bunuh process chromium/chrome yang masih lock
    console.log("Membunuh chrome/chromium process untuk session:", id);
    await killChromeProcess(sessionPath);

    // Delay sedikit agar OS melepas file lock
    await new Promise(res => setTimeout(res, 600));

    // Hapus folder
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log(`Folder session-${id} berhasil dihapus.`);
    } else {
      console.log(`Folder session-${id} tidak ditemukan.`);
    }

  } catch (err) {
    console.error(`Gagal menghapus folder session-${id}:`, err);
  }
}

function cleanupDeadSessions() {
  console.log("Menjalankan pengecekan session...");

  const savedSessions = getSessionsFile();

  savedSessions.forEach(sess => {
    const activeClient = sessions.find(s => s.id === sess.id)?.client;

    // Jika client tidak ada atau tidak ready → hapus session
    if (!activeClient || activeClient.ws === null || activeClient.pupBrowser === null) {
      console.log(`Session ${sess.id} tidak aktif. Menghapus...`);

      // Hapus node dari sessions.json
      const updated = savedSessions.filter(s => s.id !== sess.id);
      setSessionsFile(updated);

      // Hapus folder session
      removeSessionFolder(sess.id);

      // Emit ke frontend jika perlu
      io.emit("remove-session", sess.id);
    }
  });
}

// Jalankan tiap 30 detik
setInterval(cleanupDeadSessions, 30 * 1000);


/**
 * BASED ON MANY QUESTIONS
 * Actually ready mentioned on the tutorials
 * 
 * The two middlewares above only handle for data json & urlencode (x-www-form-urlencoded)
 * So, we need to add extra middleware to handle form-data
 * Here we can use express-fileupload
 */
app.use(fileUpload({
  debug: false
}));

app.get('/', (req, res) => {
  res.sendFile('index-multiple-account.html', {
    root: __dirname
  });
});

const sessions = [];
const SESSIONS_FILE = './whatsapp-sessions.json';

const createSessionsFileIfNotExists = function() {
  if (!fs.existsSync(SESSIONS_FILE)) {
    try {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify([]));
      console.log('Sessions file created successfully.');
    } catch(err) {
      console.log('Failed to create sessions file: ', err);
    }
  }
}

createSessionsFileIfNotExists();

const setSessionsFile = function(sessions) {
  fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions), function(err) {
    if (err) {
      console.log(err);
    }
  });
}

const getSessionsFile = function() {
  return JSON.parse(fs.readFileSync(SESSIONS_FILE));
}

const createSession = function(id, description) {
  console.log('Creating session: ' + id);
  const client = new Client({
	deviceName: deviceName,
	// browserName: 'Browser Custom',
    restartOnAuthFail: true,
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process', // <- this one doesn't works in Windows
        '--disable-gpu'
      ],
    },
    authStrategy: new LocalAuth({
      clientId: id
    })
  });

  client.initialize();

  client.on('qr', (qr) => {
    console.log('QR RECEIVED', qr);
    qrcode.toDataURL(qr, (err, url) => {
      io.emit('qr', { id: id, src: url });
      io.emit('message', { id: id, text: 'QR Code received, scan please!' });
    });
  });

  client.on('ready', () => {
    io.emit('ready', { id: id });
    io.emit('message', { id: id, text: 'Whatsapp is ready!' });

    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex(sess => sess.id == id);
    savedSessions[sessionIndex].ready = true;
    setSessionsFile(savedSessions);
  });

  client.on('authenticated', () => {
    io.emit('authenticated', { id: id });
    io.emit('message', { id: id, text: 'Whatsapp is authenticated!' });
  });

  client.on('auth_failure', function() {
    io.emit('message', { id: id, text: 'Auth failure, restarting...' });
  });

  client.on("disconnected", async (reason) => {
    console.log(`Session ${id} disconnected:`, reason);

	// Hapus dari sessions.json
	const saved = getSessionsFile().filter(sess => sess.id !== id);
	setSessionsFile(saved);

	// Hapus dari memory
	const memIndex = sessions.findIndex(s => s.id === id);
	if (memIndex >= 0) sessions.splice(memIndex, 1);

	// Hapus folder
	await removeSessionFolder(id, client);

	io.emit("remove-session", id);
  });

  // Tambahkan client ke sessions
  sessions.push({
    id: id,
    description: description,
    client: client
  });

  // Menambahkan session ke file
  const savedSessions = getSessionsFile();
  const sessionIndex = savedSessions.findIndex(sess => sess.id == id);

  if (sessionIndex == -1) {
    savedSessions.push({
      id: id,
      description: description,
      ready: false,
    });
    setSessionsFile(savedSessions);
  }
}

const init = function(socket) {
  const savedSessions = getSessionsFile();

  if (savedSessions.length > 0) {
    if (socket) {
      /**
       * At the first time of running (e.g. restarting the server), our client is not ready yet!
       * It will need several time to authenticating.
       * 
       * So to make people not confused for the 'ready' status
       * We need to make it as FALSE for this condition
       */
      savedSessions.forEach((e, i, arr) => {
        arr[i].ready = false;
      });

      socket.emit('init', savedSessions);
    } else {
      savedSessions.forEach(sess => {
        createSession(sess.id, sess.description);
      });
    }
  }
}

init();

// Socket IO
io.on('connection', function(socket) {
  init(socket);

  socket.on('create-session', function(data) {
    console.log('Create session: ' + data.id);
    createSession(data.id, data.description);
  });
});

// Send message
app.post('/send-message', async (req, res) => {
  console.log(req);

  const sender = req.body.sender;
  const number = phoneNumberFormatter(req.body.number);
  const message = req.body.message;

  const client = sessions.find(sess => sess.id == sender)?.client;

  // Make sure the sender is exists & ready
  if (!client) {
    return res.status(422).json({
      status: false,
      message: `The sender: ${sender} is not found!`
    })
  }

  /**
   * Check if the number is already registered
   * Copied from app.js
   * 
   * Please check app.js for more validations example
   * You can add the same here!
   */
  const isRegisteredNumber = await client.isRegisteredUser(number);

  if (!isRegisteredNumber) {
    return res.status(422).json({
      status: false,
      message: 'The number is not registered'
    });
  }

  client.sendMessage(number, message).then(response => {
    res.status(200).json({
      status: true,
      response: response
    });
  }).catch(err => {
    res.status(500).json({
      status: false,
      response: err
    });
  });
});

server.listen(port, function() {
  console.log('App running on *: ' + port);
});
