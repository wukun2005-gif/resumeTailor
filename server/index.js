import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import apiRouter from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Only allow localhost origins
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      cb(null, true);
    } else {
      cb(new Error('CORS not allowed'));
    }
  }
}));
app.use(express.json({ limit: '50mb' }));
app.use('/api', apiRouter);

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'dist')));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'dist', 'index.html')));
}

const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  console.log(`简历定制助手 Server: http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${PORT} 已被占用！`);
    console.error(`   请在终端执行以下命令终止旧进程：`);
    console.error(`   lsof -i :${PORT} | awk 'NR>1{print $2}' | xargs kill -9\n`);
    process.exit(1);
  }
  throw err;
});

// Graceful shutdown: release port on SIGINT/SIGTERM
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    // Force exit after 3s if connections don't close
    setTimeout(() => process.exit(0), 3000);
  });
}
