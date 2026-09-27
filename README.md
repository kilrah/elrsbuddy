# ELRS Buddy
Configure ExpressLRS modules from a browser. The app simulates an EdgeTX Lua environment, speaks Crossfire, and executes elrs.lua in the browser. Serial ports are accessed in the browser by default; an optional server mode lets the Node.js host own the serial port and bridge it over WebSocket.

## Free instance
Enjoy a free instance of this app at https://fourflies.mooo.com/elrsbuddy/

## Build instructions
If you do not have a Node.js environment already, you can start one quickly with Docker.  Download this 
repository and place it at ~/elrsbuddy before running this Docker command.
```bash
docker run -v ~/elrsbuddy:/eb -w /eb --name eb -ti --rm -p 8080:8080 node /bin/bash
```

### First install dependencies
```bash
npm install
```

### Start the app
```bash
npm start
```
This builds the app and starts it at http://localhost:8080. By default, pair a serial device attached to the browser's machine. Web Serial requires HTTPS or localhost and a supported browser.

To use a port attached to the server machine instead, start with `npm start -- --serial=server`. The server listens on 127.0.0.1 by default. For Docker or a browser on another machine, run `HOST=0.0.0.0 npm start -- --serial=server`; only do this on a trusted network because the server serial endpoint has no authentication.

### Build deployable artifacts
```bash
npm run build
```
After this completes, the deployable version will be placed in the `dist` folder.
