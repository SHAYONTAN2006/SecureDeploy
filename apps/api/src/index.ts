import { app } from './app.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5000;

const server = app.listen(PORT, () => {
  console.log(
    `[SecureDeploy API] Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`
  );
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('[SecureDeploy API] SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('[SecureDeploy API] Process terminated.');
  });
});

process.on('SIGINT', () => {
  console.log('[SecureDeploy API] SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('[SecureDeploy API] Process terminated.');
  });
});
