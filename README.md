# ELRS Buddy
Configure ExpressLRS modules from a browser. The app simulates an EdgeTX Lua environment, speaks Crossfire, and executes elrs.lua in the browser. Serial ports are accessed in the browser by default; an optional server mode lets the Node.js host own the serial port and bridge it over WebSocket e.g to use a Raspberry Pi or other SBC as config tool.

This forks https://github.com/Fourflies/elrsbuddy, then
- Adds the changes by https://github.com/wittigol-ai/elrsbuddy to improve logging and compatibility with current scripts
- Bundles in the current elrs.lua at the time of writing
- Adds support for server-side serial ports as an option when starting the server
- Adds buttons for navigating the lua script on a keyboardless device e.g. phone

Work mostly done by Copilot.

## Build instructions
Install node/npm on the server you'll run this on

### First install dependencies
Clone this repo, then run
```bash
npm install
```
from the cloned folder.

### Build/Start the app
```bash
npm start
```
This builds the app and starts it at http://localhost:8080. By default, pair a serial device attached to the browser's machine. Web Serial requires HTTPS or localhost and a supported browser.

To use a port attached to the server machine instead, start with `npm start -- --serial=server`. The server listens on 127.0.0.1 by default. For Docker or a browser on another machine, run `HOST=0.0.0.0 npm start -- --serial=server`; only do this on a trusted network because the server serial endpoint has no authentication.

Once built the app can also be started with `node server.js` respectively `node server.js --serial=server` to skip the building step, useful e.g. to run it as a service on an SBC.
