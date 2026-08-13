import { createServer } from 'net';
import { spawn } from 'child_process';

const PREFERRED_PORT = 5173;
const MAX_PORT = 5199;

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      server.close();
      resolve(false);
    });
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, 'localhost');
  });
}

async function findAvailablePort() {
  for (let port = PREFERRED_PORT; port <= MAX_PORT; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
    console.log(`Port ${port} is in use, trying next...`);
  }
  throw new Error(`No available ports between ${PREFERRED_PORT} and ${MAX_PORT}`);
}

async function main() {
  const port = await findAvailablePort();
  console.log(`Starting dev server on port ${port}`);
  
  // Set PORT environment variable for vite
  process.env.PORT = port.toString();
  
  // Start the vite dev server for renderer
  const child = spawn('npx', ['vite', '--port', port], {
    stdio: 'inherit',
    env: { ...process.env, PORT: port.toString() }
  });
  
  child.on('error', (err) => {
    console.error('Failed to start dev server:', err);
    process.exit(1);
  });
  
  child.on('close', (code) => {
    process.exit(code || 0);
  });
}

main();
