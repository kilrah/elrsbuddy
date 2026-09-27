const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { SerialPort } = require('serialport');
const { WebSocketServer, WebSocket } = require('ws');

const root = path.join(__dirname, 'dist');
const contentTypes = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.lua': 'text/plain; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.css': 'text/css; charset=utf-8'
};
let activePort = null;
let activeSocket = null;

function send (socket, message) {
	if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function closePort (socket) {
	if (activeSocket !== socket || activePort === null) return;
	const port = activePort;
	activePort = null;
	if (!port.isOpen) {
		send(socket, ['stopped']);
		if (socket.readyState === WebSocket.OPEN) socket.close();
		return;
	}
	port.close((error) => {
		if (error) send(socket, ['error', error.message]);
		send(socket, ['stopped']);
		if (socket.readyState === WebSocket.OPEN) socket.close();
	});
}

const server = http.createServer(async (request, response) => {
	const url = new URL(request.url, 'http://localhost');
	if (request.method === 'GET' && url.pathname === '/api/ports') {
		try {
			const ports = await SerialPort.list();
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(JSON.stringify(ports));
		} catch (error) {
			response.writeHead(500, { 'content-type': 'application/json' });
			response.end(JSON.stringify({ error: error.message }));
		}
		return;
	}
	if (request.method !== 'GET') {
		response.writeHead(405).end();
		return;
	}

	const requestedPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
	const filePath = path.resolve(root, `.${requestedPath}`);
	if (!filePath.startsWith(`${root}${path.sep}`)) {
		response.writeHead(403).end();
		return;
	}
	fs.readFile(filePath, (error, content) => {
		if (error) {
			response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
			return;
		}
		response.writeHead(200, { 'content-type': contentTypes[path.extname(filePath)] || 'application/octet-stream' });
		response.end(content);
	});
});

const sockets = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
	if (request.url !== '/serial') {
		socket.destroy();
		return;
	}
	sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit('connection', websocket));
});

sockets.on('connection', (socket) => {
	if (activeSocket !== null) {
		send(socket, ['error', 'Serial port is already in use']);
		socket.close();
		return;
	}
	activeSocket = socket;
	socket.on('message', async (message, isBinary) => {
		if (isBinary) {
			if (activePort === null) return;
			const port = activePort;
			port.write(message, (error) => {
				if (error) {
					send(socket, ['error', error.message]);
					return closePort(socket);
				}
			});
			return;
		}

		let command;
		try {
			command = JSON.parse(message.toString());
		} catch {
			send(socket, ['error', 'Invalid serial command']);
			return;
		}
		if (command[0] === 'disconnect') {
			return closePort(socket);
		}
		if (command[0] !== 'connect' || activePort !== null) return;
		const [, portPath, baudRate] = command;
		try {
			const availablePorts = await SerialPort.list();
			if (!availablePorts.some((port) => port.path === portPath)) {
				throw new Error('Selected serial port is no longer available');
			}
			const port = new SerialPort({ path: portPath, baudRate: Number(baudRate), autoOpen: false });
			activePort = port;
			port.on('data', (data) => {
				if (socket.readyState === WebSocket.OPEN) socket.send(data);
			});
			port.on('error', (error) => {
				send(socket, ['error', error.message]);
				closePort(socket);
			});
			port.open((error) => {
				if (error) {
					if (activePort === port) activePort = null;
					send(socket, ['error', error.message]);
					send(socket, ['stopped']);
					socket.close();
					return;
				}
				if (activeSocket !== socket || activePort !== port) {
					port.close();
					return;
				}
				send(socket, ['opened']);
			});
		} catch (error) {
			send(socket, ['error', error.message]);
			send(socket, ['stopped']);
			socket.close();
		}
	});
	socket.on('close', () => {
		if (activeSocket !== socket) return;
		activeSocket = null;
		if (activePort !== null) {
			const port = activePort;
			activePort = null;
			if (port.isOpen) port.close();
		}
	});
});

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8080);
server.listen(port, host, () => console.log(`ELRS Buddy available at http://${host}:${port}`));