const DECODED_UNKNOWN=0;
const DECODED_FINISHED=1;
const DECODED_FORWARD=2;
const SYNC = 0xC8;
const CRSF_FRAMETYPE_RADIO_ID = 0x3A;
// CRSF durations are exchanged as 10*usec
const TIME1MSEC = 10000;
let CRC8TABLE = new Uint8Array(256);
let socket = null;
let port = null;
let reader = null;
let writer = null;
let transportMode = 'client';
let sessionActive = false;
let startPending = false;
let receiveBuffer = new Uint8Array(1024);
let receiveOffset = 0;
let write = write_close;
let wbuf = {
	'b': new Uint8Array(256),
	'offset': 26 // first 26 bytes reserved for CRSF_FRAMETYPE_RC_CHANNELS_PACKED
}

// start with 200ms (5 Hz) updates
let write_interval = 200 * TIME1MSEC;
let write_shift = 0;
let writes_burn = 0;
let writes_st = 0;

// ch5 @ 900us, the rest @ 1500us
const crsf_rcchannels = new Uint8Array([
	0xc8,
	0x18,
	0x16,
	0xe0,
	0x03,
	0x1f,
	0xf8,
	0xc0,
	0xc7,
	0x0a,
	0xf0,
	0x81,
	0x0f,
	0x7c,
	0xe0,
	0x03,
	0x1f,
	0xf8,
	0xc0,
	0x07,
	0x3e,
	0xf0,
	0x81,
	0x0f,
	0x7c,
	0x33
]);

const address = {
	0x00: "broadcast",
	0x10: "usb",
	0x12: "bluetooth",
	0x80: "tbs_core_pnp_pro",
	0x8A: "reserved1",
	0xC0: "current_sensor",
	0xC2: "gps",
	0xC4: "tbs_blackbox",
	0xC8: "flight_controller",
	0xCA: "reserved2",
	0xCC: "race_tag",
	0xEA: "radio_transmitter",
	0xEC: "crsf_receiver",
	0xEE: "crsf_transmitter",
	0xEF: "elrs_lua"
};

function crc8init () {
	var remainder;
	for (let dividend=0; dividend<256; dividend++) {
		// 8 bit width, therefore no need to shift
		remainder = dividend;
		for (let bit=0; bit<8; bit++) {
			if ((remainder & 128) != 0) {
				remainder = (remainder << 1) ^ 0xD5;
			} else {
				remainder = remainder << 1;
			}
		}
		CRC8TABLE[dividend] = remainder & 0xFF;
	}
}

function crc8 (msg) {
	var crc = new Uint8Array(1);
	for (let i=0; i<msg.length; i++) {
		crc[0] = CRC8TABLE[(msg[i] ^ crc[0])]
	}
	crc[0] = crc[0] ^ 0x00;
	return crc;
}

function decode_extended (buf) {
	var dst = address[buf.getUint8(0)];
	var src = address[buf.getUint8(1)];
	if (dst === undefined) {
		dst = "unknown";
	}
	if (src === undefined) {
		src = "unknown";
	}
	return [ dst, src ];
}

function decode_unknown (buf, type) {
	log(`unknown ${type}: ` + hexprintable(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)), 0);
	return DECODED_UNKNOWN;
}

function decode_link_statistics (buf) {
	const up_rssi1 = buf.getUint8(0);
	const up_rssi2 = buf.getUint8(1);
	const up_lq = buf.getUint8(2);
	const up_snr = buf.getInt8(3);
	const active_ant = buf.getUint8(4);
	const rf_mode = buf.getUint8(5);
	const up_tx_pwr = buf.getUint8(6);
	const dn_rssi = buf.getUint8(7);
	const dn_lq = buf.getUint8(8);
	const dn_snr = buf.getInt8(9);
	log(`LINK_STAT: up_lq=${up_lq} up_snr=${up_snr} rf_mode=${rf_mode} dn_lq=${dn_lq} dn_snr=${dn_snr}`, 0);
	return DECODED_FORWARD;
}

function decode_elrs_status (buf) {
	const [ dst, src ] = decode_extended(buf);
	const nbad = buf.getUint8(2);
	const ngood = buf.getUint16(3);
	const flags = buf.getUint8(5);
	var n;
	for (n=6; n<buf.byteLength; n++) {
		if (buf.getUint8(n) == 0) break;
	}
	const msg = bytes2str(new Uint8Array(buf.buffer, buf.byteOffset+6, buf.byteLength-6));
	log(`${src}->${dst} ELRS_STATUS: nbad=${nbad} ngood=${ngood} flags=${flags} msg=${msg}`, 1);
	return DECODED_FORWARD;
}

function decode_parameter_write (buf) {
	const [ dst, src ] = decode_extended(buf);
	const idx = buf.getUint8(2);
	log(`${src}->${dst} PARAMETER_WRITE: ${idx}`, 1);
	return DECODED_FORWARD;
}

function decode_parameter_settings_entry (buf) {
	const [ dst, src ] = decode_extended(buf);
	var idx = buf.getUint8(2);
	var left = buf.getUint8(3);
	var end = new Uint8Array(buf.buffer, buf.byteOffset+4, buf.byteLength-4);
	log(`${src}->${dst} SETTINGS_ENTRY: ${idx} ${left}: ${hexprintable(end)}`, 1);
	return DECODED_FORWARD;
}

function decode_device_info (buf) {
	const [ dst, src ] = decode_extended(buf);
	const stringmax = buf.byteLength - 12;
	var name, serial, hwver, maj, min, rev, npar, pver;
	var n;
	for (n=2; n<stringmax; n++) {
		if (buf.getUint8(n) == 0) break;
	}
	if (n < stringmax) {
		name = bytes2str(new Uint8Array(buf.buffer, buf.byteOffset+2, n-2), 32);
		n++;
		serial = bytes2str(new Uint8Array(buf.buffer, buf.byteOffset+n, 4));
		n += 4;
		hwver = buf.getUint32(n);
		n += 4;
		n++; // ignore first byte of swver
		maj = buf.getUint8(n++);
		min = buf.getUint8(n++);
		rev = buf.getUint8(n++);
		npar = buf.getUint8(n++);
		pver = buf.getUint8(n++);
		log(`${src}->${dst} DEVICE_INFO: ${name} (${serial}) hwver=${hwver} swver=${maj}.${min}.${rev} npar=${npar} pver=${pver}`, 1);
		self.postMessage(['devinfo', name, maj, min, rev]);
	}
	return DECODED_FORWARD;
}

function decode_radio_id (buf) {
	var interval, shift;
	if (buf.getUint8(2) == 16) {
		interval = buf.getInt32(3);
		shift = buf.getInt32(7);
		self.postMessage(["sync", (10000000/interval).toFixed(1), shift]);
		if (interval != write_interval) {
			log(`worker adjusting loopinterval ${write_interval}=>${interval}`, 1);
			write_interval = interval;
		}
		write_shift = shift;
		// for debugging timing issues
		//console.log(`sync ${shift}`);
	} else {
		log('SYNC: unknown subtype!', 1);
	}
	return DECODED_FINISHED;
}

function decode_radio_id_start (buf) {
	self.postMessage(['start']);
	DECODE[CRSF_FRAMETYPE_RADIO_ID] = decode_radio_id;
	return decode_radio_id(buf);
}

// I love me a jump table
const DECODE = Array(
	decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_GPS
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_VARIO
	decode_unknown, // CRSF_FRAMETYPE_BATTERY_SENSOR
	decode_unknown, // CRSF_FRAMETYPE_BARO_ALTITUDE
	decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_HEARTBEAT
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_link_statistics, // CRSF_FRAMETYPE_LINK_STATISTICS
	decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_RC_CHANNELS_PACKED
	decode_unknown, // CRSF_FRAMETYPE_SUBSET_RC_CHANNELS_PACKED
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_LINK_RX_ID
	decode_unknown, // CRSF_FRAMETYPE_LINK_TX_ID
	decode_unknown, // CRSF_FRAMETYPE_ATTITUDE
	decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_FLIGHT_MODE
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_DEVICE_PING
	decode_device_info,
	decode_unknown,
	decode_parameter_settings_entry, // CRSF_FRAMETYPE_PARAMETER_SETTINGS_ENTRY
	decode_unknown, // CRSF_FRAMETYPE_PARAMETER_READ
	decode_parameter_write, // CRSF_FRAMETYPE_PARAMETER_WRITE
	decode_elrs_status, // CRSF_FRAMETYPE_ELRS_STATUS
	decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_COMMAND
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown,
	decode_radio_id_start, // CRSF_FRAMETYPE_RADIO_ID
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_KISS_REQ
	decode_unknown, // CRSF_FRAMETYPE_KISS_RESP
	decode_unknown, // CRSF_FRAMETYPE_MSP_REQ
	decode_unknown, // CRSF_FRAMETYPE_MSP_RESP
	decode_unknown, // CRSF_FRAMETYPE_MSP_WRITE
	decode_unknown, // CRSF_FRAMETYPE_DISPLAYPORT_CMD
	decode_unknown, decode_unknown,
	decode_unknown, // CRSF_FRAMETYPE_ARDUPILOT_RESP
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown, decode_unknown,
	decode_unknown, decode_unknown, decode_unknown
);
	
function log (msg, level = 1) {
	self.postMessage(["log", msg, level]);
}

function hex (buf) {
	let out = [];
	for (let i=0; i<buf.length; i++) {
		out.push(("0" + buf[i].toString(16).toUpperCase()).substr(-2));
	}
	return out.join(" ");
}

function bytes2str (buf, lowest=33) {
	// set lowest=32 to include space characters
	var out = '';
	for (let i=0; i<buf.length; i++) {
		if (buf[i] < lowest || buf[i] > 126) {
			out += ".";
		} else {
			out += String.fromCharCode(buf[i]);
		}
	}
	return out;
}

function hexprintable (buf) {
	let out = hex(buf) + ' [' + bytes2str(buf) + ']';
	return out;
}

function validate_packet (buf) {
	return (crc8(buf.subarray(2,-1)).at(0) == buf.at(-1));
}

function buf_shift (buf, shift, offset) {
	let tbuf = new Uint8Array(buf, 0, offset);
	if (shift < offset) {
		// copy over noise
		tbuf.copyWithin(0, shift, offset);
	}
	return offset-shift;
}

function write_close () {
	if (transportMode === 'client') {
		client_close();
		return;
	}
	if (socket && socket.readyState === WebSocket.OPEN) {
		socket.send(JSON.stringify(['disconnect']));
	} else if (socket) {
		socket.close();
	} else {
		notify_stopped();
	}
}

function client_close () {
	if (!port) {
		notify_stopped();
		return;
	}
	const closingPort = port;
	const closeReader = reader ? reader.cancel().catch(() => {}).then(() => {
		reader.releaseLock();
		reader = null;
	}) : Promise.resolve();
	const closeWriter = writer ? writer.close().catch(() => {}).then(() => {
		writer.releaseLock();
		writer = null;
	}) : Promise.resolve();
	Promise.all([closeReader, closeWriter]).then(() => closingPort.close()).then(() => {
		port = null;
		notify_stopped();
	}).catch((error) => {
		log(`error closing client serial port: ${error.message}`, 1);
		port = null;
		notify_stopped();
	});
}

function client_read_run () {
	const activeReader = reader;
	if (!activeReader) return;
	activeReader.read().then(({value, done}) => {
		if (reader !== activeReader) return;
		if (done) {
			activeReader.releaseLock();
			reader = null;
			write = write_close;
			client_close();
			return;
		}
		read_run(value);
		return client_read_run();
	}).catch((error) => {
		if (reader !== activeReader) return;
		if (sessionActive) log(`client serial read error: ${error.message}`, 1);
		write = write_close;
		client_close();
	});
}

function notify_stopped () {
	if (!sessionActive && !startPending) return;
	sessionActive = false;
	startPending = false;
	write = write_close;
	receiveOffset = 0;
	self.postMessage(["stopped"]);
}

function read_run (chunk) {
	if (receiveOffset + chunk.length > receiveBuffer.length) {
		log('serial receive buffer overflow');
		receiveOffset = 0;
	}
	receiveBuffer.set(chunk, receiveOffset);
	receiveOffset += chunk.length;
	while (receiveOffset > 3) {
		let packetOffset = -1;
		let packetLength = 0;
		let incompleteOffset = -1;
		for (let offset = 0; offset + 4 <= receiveOffset; offset++) {
			const length = receiveBuffer[offset + 1] + 2;
			if (length > 64 || length < 4) continue;
			if (offset + length > receiveOffset) {
				incompleteOffset = offset;
				break;
			}
			if (validate_packet(receiveBuffer.subarray(offset, offset + length))) {
				packetOffset = offset;
				packetLength = length;
				break;
			}
		}
		if (packetOffset < 0) {
			const discard = incompleteOffset >= 0 ? incompleteOffset : receiveOffset - 3;
			if (discard > 0) {
				log("noise: " + hexprintable(receiveBuffer.subarray(0, discard)));
				receiveBuffer.copyWithin(0, discard, receiveOffset);
				receiveOffset -= discard;
			}
			break;
		}
		if (packetOffset > 0) {
			log("noise: " + hexprintable(receiveBuffer.subarray(0, packetOffset)));
		}
		const packet = receiveBuffer.subarray(packetOffset, packetOffset + packetLength);
		const type = packet[2];
		const payload = new DataView(packet.buffer, packet.byteOffset + 3, packetLength - 4);
		if (DECODE[type](payload, type) == DECODED_FORWARD) {
			self.postMessage(["crsfrecv", type, [...packet.subarray(3, -1)]]);
		}
		const consumed = packetOffset + packetLength;
		receiveBuffer.copyWithin(0, consumed, receiveOffset);
		receiveOffset -= consumed;
	}
}

function write_burn (lastwrite) {
	let burndelay = ((write_interval + write_shift) / TIME1MSEC) - (performance.now() - lastwrite) + 0.5;
	// for debugging timing issues
	// console.log(`write_burn ${lastwrite} ${write_shift} ${burndelay}`);
	while ((performance.now() - lastwrite) < burndelay);
	write();
}

function write_run () {
	if (writes_burn+writes_st > 300) {
		log(`writes_burn=${writes_burn} writes_st=${writes_st}`, 0);
		writes_burn = writes_st = 0;
	}
	if (transportMode === 'client' ? !writer : !socket || socket.readyState !== WebSocket.OPEN) return;
	const bytes = wbuf.b.slice(0, wbuf.offset);
	wbuf.offset = 26;
	if (transportMode === 'client') {
		writer.write(bytes).then(write_complete).catch((error) => {
			log(`client serial write error: ${error.message}`, 1);
			write = write_close;
			client_close();
		});
	} else {
		socket.send(bytes);
		write_complete();
	}
}

function write_complete () {
	if (write !== write_run) return;
	const lastwrite = performance.now();
	const writedelay = (write_interval + write_shift) / TIME1MSEC;
	wbuf.offset = 26;
	write_shift = 0;
	if (writedelay >= 3.7) {
		writes_st++;
		setTimeout(write, Math.floor(writedelay), lastwrite);
		return;
	}
	writes_burn++;
	self.postMessage(["writeburn", lastwrite]);
}

uimessage = {
	'start': function (data) {
		transportMode = data[1];
		if (socket) socket.close();
		startPending = true;
		receiveOffset = 0;
		wbuf.b.set(crsf_rcchannels);
		DECODE[CRSF_FRAMETYPE_RADIO_ID] = decode_radio_id_start;
		if (transportMode === 'client') {
			navigator.serial.getPorts().then((ports) => {
				if (!ports.length) throw new Error('No paired client serial ports found');
				port = ports[0];
				return port.open({baudRate: Number(data[3])});
			}).then(() => {
				writer = port.writable.getWriter();
				reader = port.readable.getReader();
				write = write_run;
				sessionActive = true;
				startPending = false;
				log(`opened client port at ${Number(data[3])} bps`, 1);
				write();
				client_read_run();
				self.postMessage(["started"]);
				self.postMessage(["sync", (10000000/write_interval).toFixed(1)]);
			}).catch((error) => {
				log(`error connecting to client port: ${error.name} ${error.message}`, 1);
				if (port && port.readable === null && port.writable === null) port = null;
				notify_stopped();
			});
			return;
		}
		const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
		socket = new WebSocket(`${protocol}//${location.host}/serial`);
		socket.binaryType = 'arraybuffer';
		socket.onopen = () => socket.send(JSON.stringify(['connect', data[2], Number(data[3])]));
		socket.onmessage = (event) => {
			if (typeof event.data !== 'string') {
				read_run(new Uint8Array(event.data));
				return;
			}
			const message = JSON.parse(event.data);
			if (message[0] === 'opened') {
				startPending = false;
				sessionActive = true;
				write = write_run;
				log(`opened server port at ${Number(data[3])} bps`);
				write();
				self.postMessage(["started"]);
				self.postMessage(["sync", (10000000/write_interval).toFixed(1)]);
			} else if (message[0] === 'stopped') {
				notify_stopped();
			} else if (message[0] === 'error') {
				log(`serial server error: ${message[1]}`);
			}
		};
		socket.onerror = () => log('serial server connection failed');
		socket.onclose = () => {
			socket = null;
			notify_stopped();
		};
	},
	'stop': function (data) {
		try {
			write = write_close;
			write_close();
		} catch (e) {
			console.log(`worker error: onmessage ${e.name} ${e.message}`);
		}
	},
	'writeburn': function (data) {
		write_burn(data[1]);
	},
	'crsfsend': function (data) {
		const len = data[2].length + 2;
		const start = wbuf.offset;
		const cst = wbuf.offset + 2;
		wbuf.b.set([SYNC, len, data[1]], wbuf.offset);
		wbuf.offset += 3;
		wbuf.b.set(data[2], wbuf.offset);
		wbuf.offset += data[2].length;
		wbuf.b.set(crc8(wbuf.b.subarray(cst, wbuf.offset)), wbuf.offset++);
		log(`worker sending: ${hexprintable(wbuf.b.subarray(start,wbuf.offset))}`, 0);
	},
	'crctable': function (data) {
		console.log(`${CRC8TABLE}`);
	},
	'crc8': function (data) {
		console.log(`${crc8(ev.data[1])}`);
	}
}
onmessage = function (ev) { return uimessage[ev.data[0]](ev.data); }
crc8init();
