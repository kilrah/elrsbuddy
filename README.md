# ELRS Buddy
Configure ExpressLRS modules from a browser. The Node.js server owns the serial port attached to its machine and provides it to the browser app over a local WebSocket connection. The app simulates an EdgeTX Lua environment, speaks Crossfire, and executes elrsV3.lua in the browser.

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
This builds the app and starts the local server at http://localhost:8080. Connect the ExpressLRS device to the machine running the server, then select its serial port in the app. The server listens on 127.0.0.1 by default. For Docker or a browser on another machine, run `HOST=0.0.0.0 npm start`; only do this on a trusted network because the serial endpoint has no authentication.

### Build deployable artifacts
```bash
npm run build
```
After this completes, the deployable version will be placed in the `dist` folder.
