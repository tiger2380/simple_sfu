'use strict';


const webrtc = require("wrtc");
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const express = require('express');
const app = express();

app.use(express.static('public'));
// based on examples at https://www.npmjs.com/package/ws
const WebSocketServer = WebSocket.Server;

const serverOptions = {
    listenPort: process.env.PORT || 5000,
    useHttps: process.env.USE_HTTPS === 'true' || false,
    httpsCertFile: process.env.HTTPS_CERT_FILE || '/path/to/cert/',
    httpsKeyFile: process.env.HTTPS_KEY_FILE || '/path/to/key/',
    maxClients: process.env.MAX_CLIENTS || 12, // Maximum number of clients in a room
    pingInterval: process.env.PING_INTERVAL || 30000, // Ping interval in ms
    pongTimeout: process.env.PONG_TIMEOUT || 5000, // Pong timeout in ms
    corsOrigins: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : ['*'],
    iceServers: [
        { urls: 'stun:stun.stunprotocol.org:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
        // Add TURN servers here if needed for NAT traversal
        // { 
        //     urls: 'turn:turn.example.com:3478',
        //     username: 'username',
        //     credential: 'password'
        // }
    ]
};

let sslOptions = {};
if (serverOptions.useHttps) {
    sslOptions.key = fs.readFileSync(serverOptions.httpsKeyFile).toString();
    sslOptions.cert = fs.readFileSync(serverOptions.httpsCertFile).toString();
}

let webServer = null;
if(serverOptions.useHttps) {
    webServer = https.createServer(sslOptions, app);
    webServer.listen(serverOptions.listenPort);
} else {
    webServer = http.createServer(app);
    webServer.listen(serverOptions.listenPort);
}
// Store client connections and their states
const peers = new Map();
const consumers = new Map();
const rooms = new Map();
const stats = {
    totalConnections: 0,
    peakConnections: 0,
    activeRooms: 0
};

// Enable security headers
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

// Configure CORS
app.use(cors({
    origin: serverOptions.corsOrigins,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

// Serve static files
app.use(express.static('public', {
    maxAge: '1h',
    etag: true,
    lastModified: true
}));

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Express error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
});

/**
 * Handles new media tracks from peers
 * @param {RTCTrackEvent} e - The track event
 * @param {string} peer - Peer ID
 * @param {WebSocket} ws - WebSocket connection
 */
function handleTrackEvent(e, peer, ws) {
    try {
        if (!e.streams || !e.streams[0]) {
            console.warn(`No streams in track event for peer ${peer}`);
            return;
        }

        const peerInfo = peers.get(peer);
        if (!peerInfo) {
            console.warn(`Peer ${peer} not found while handling track`);
            return;
        }

        const track = e.track;
        peerInfo.stream = e.streams[0];
        peerInfo.tracks = peerInfo.tracks || new Map();

        // Check if we already have this track
        if (peerInfo.tracks.has(track.id)) {
            console.log(`Track ${track.id} already exists for peer ${peer}`);
            return;
        }

        // Store track information
        peerInfo.tracks.set(track.id, {
            id: track.id,
            kind: track.kind,
            timestamp: Date.now(),
            track: track
        });

        // Notify all peers about the new producer, except the sender
        const payload = {
            type: 'newProducer',
            id: peer,
            username: peerInfo.username,
            trackInfo: {
                id: track.id,
                kind: track.kind
            }
        };

        wss.broadcast(JSON.stringify(payload), peer); // Exclude the sender
    } catch (error) {
        console.error('Error in handleTrackEvent:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Failed to process media track',
            code: 'TRACK_ERROR'
        }));
    }
}

/**
 * Creates a new WebRTC peer connection with the specified configuration
 * @param {string} peerId - The ID of the peer
 * @returns {RTCPeerConnection} The created peer connection
 */
function createPeer(peerId) {
    try {
        const peer = new webrtc.RTCPeerConnection({
            iceServers: serverOptions.iceServers,
            iceCandidatePoolSize: 10,
            bundlePolicy: 'max-bundle',
            rtcpMuxPolicy: 'require',
            sdpSemantics: 'unified-plan'
        });

        // Monitor connection state
        peer.onconnectionstatechange = () => {
            console.log(`Peer ${peerId} connection state: ${peer.connectionState}`);
            if (peer.connectionState === 'failed') {
                console.warn(`Peer ${peerId} connection failed, cleaning up...`);
                cleanupPeer(peerId);
            }
        };

        // Monitor ICE connection state
        peer.oniceconnectionstatechange = () => {
            console.log(`Peer ${peerId} ICE state: ${peer.iceConnectionState}`);
        };

        // Log ICE gathering state changes
        peer.onicegatheringstatechange = () => {
            console.log(`Peer ${peerId} ICE gathering state: ${peer.iceGatheringState}`);
        };

        return peer;
    } catch (error) {
        console.error('Error creating peer:', error);
        throw new Error('Failed to create peer connection');
    }
}

/**
 * Cleans up resources associated with a peer
 * @param {string} peerId - The ID of the peer to clean up
 */
function cleanupPeer(peerId) {
    try {
        const peerInfo = peers.get(peerId);
        if (!peerInfo) return;

        // Close and cleanup WebRTC connection
        if (peerInfo.peer) {
            peerInfo.peer.close();
        }

        // Stop all tracks
        if (peerInfo.stream) {
            peerInfo.stream.getTracks().forEach(track => track.stop());
        }

        // Cleanup associated consumers
        consumers.forEach((consumer, id) => {
            if (consumer.peerId === peerId) {
                if (consumer.peer) {
                    consumer.peer.close();
                }
                // Stop all tracks in the consumer
                if (consumer.tracks) {
                    consumer.tracks.forEach(trackId => {
                        const track = consumer.peer.getTransceivers().find(t => t.receiver.track.id === trackId);
                        if (track) {
                            track.receiver.track.stop();
                        }
                    });
                }
                consumers.delete(id);
            }
        });

        // Remove from peers map
        peers.delete(peerId);

        // Update stats
        stats.totalConnections--;

        // Notify other peers
        wss.broadcast(JSON.stringify({
            type: 'user_left',
            id: peerId
        }));
    } catch (error) {
        console.error(`Error cleaning up peer ${peerId}:`, error);
    }
}


/**
 * Create WebSocket server with ping/pong monitoring
 */
const wss = new WebSocketServer({ 
    server: webServer,
    clientTracking: true,
    perMessageDeflate: {
        zlibDeflateOptions: {
            chunkSize: 1024,
            memLevel: 7,
            level: 3
        },
        zlibInflateOptions: {
            chunkSize: 10 * 1024
        },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        serverMaxWindowBits: 10,
        concurrencyLimit: 10,
        threshold: 1024
    }
});

// Keep track of connection statistics
setInterval(() => {
    const currentConnections = peers.size;
    stats.peakConnections = Math.max(stats.peakConnections, currentConnections);
    stats.activeRooms = rooms.size;
    console.log('Server Stats:', stats);
}, 60000);

wss.on('connection', async function (ws, req) {
    // Rate limiting and connection validation
    const ip = req.socket.remoteAddress;
    if (peers.size >= serverOptions.maxClients) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Server is at capacity',
            code: 'MAX_CLIENTS_REACHED'
        }));
        return ws.close();
    }

    // Set up the new peer
    const peerId = uuidv4();
    ws.id = peerId;
    ws.isAlive = true;

    // Set up ping/pong
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    // Handle disconnection
    ws.on('close', (code, reason) => {
        console.log(`Client ${peerId} disconnected. Code: ${code}, Reason: ${reason}`);
        cleanupPeer(ws.id);
    });

    // Handle errors
    ws.on('error', (error) => {
        console.error(`WebSocket error for peer ${peerId}:`, error);
        cleanupPeer(ws.id);
    });


    ws.send(JSON.stringify({ 'type': 'welcome', id: peerId }));
    ws.on('message', async function (message) {
        const body = JSON.parse(message);
        switch (body.type) {
            case 'connect':
                try {
                    if (peers.has(body.uqid)) {
                        console.log(`Peer ${body.uqid} already exists, cleaning up old connection`);
                        cleanupPeer(body.uqid);
                    }

                    peers.set(body.uqid, { 
                        socket: ws,
                        username: body.username,
                        tracks: new Map(),
                        connectedAt: Date.now()
                    });

                    const peer = createPeer(body.uqid);
                    peers.get(body.uqid).peer = peer;
                    peer.ontrack = (e) => { handleTrackEvent(e, body.uqid, ws) };

                    const desc = new webrtc.RTCSessionDescription(body.sdp);
                    await peer.setRemoteDescription(desc);
                    const answer = await peer.createAnswer();
                    await peer.setLocalDescription(answer);

                    const payload = {
                        type: 'answer',
                        sdp: peer.localDescription
                    };

                    ws.send(JSON.stringify(payload));

                    // Update stats
                    stats.totalConnections++;
                } catch (error) {
                    console.error('Error in connect:', error);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Failed to establish connection',
                        code: 'CONNECT_ERROR'
                    }));
                }
                break;
            case 'getPeers':
                let uuid = body.uqid;
                const list = [];
                peers.forEach((peer, key) => {
                    if (key != uuid) {
                        const peerInfo = {
                            id: key,
                            username: peer.username,
                        }
                        list.push(peerInfo);
                    }
                });

                const peersPayload = {
                    type: 'peers',
                    peers: list
                }

                ws.send(JSON.stringify(peersPayload));
                break;
            case 'ice':
                const user = peers.get(body.uqid);
                if (user.peer)
                    user.peer.addIceCandidate(new webrtc.RTCIceCandidate(body.ice)).catch(e => console.log(e));
                break;
            case 'consume':
                try {
                    let { id, sdp, consumerId } = body;
                    const remoteUser = peers.get(id);
                    
                    if (!remoteUser) {
                        throw new Error(`Remote user ${id} not found`);
                    }

                    // Check if consumer already exists
                    if (consumers.has(consumerId)) {
                        console.log(`Consumer ${consumerId} already exists, skipping`);
                        return;
                    }

                    const newPeer = createPeer(consumerId);
                    consumers.set(consumerId, {
                        peer: newPeer,
                        peerId: id,
                        tracks: new Set()
                    });

                    const _desc = new webrtc.RTCSessionDescription(sdp);
                    await newPeer.setRemoteDescription(_desc);

                    // Add tracks if they exist
                    if (remoteUser.stream && remoteUser.tracks) {
                        remoteUser.stream.getTracks().forEach(track => {
                            // Only add track if we haven't already added it
                            if (!consumers.get(consumerId).tracks.has(track.id)) {
                                newPeer.addTrack(track, remoteUser.stream);
                                consumers.get(consumerId).tracks.add(track.id);
                            }
                        });
                    }

                    const _answer = await newPeer.createAnswer();
                    await newPeer.setLocalDescription(_answer);

                    const _payload = {
                        type: 'consume',
                        sdp: newPeer.localDescription,
                        username: remoteUser.username,
                        id,
                        consumerId
                    };

                    ws.send(JSON.stringify(_payload));
                } catch (error) {
                    console.error('Error in consume:', error);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Failed to consume media',
                        code: 'CONSUME_ERROR'
                    }));
                }

                break;
            case 'consumer_ice':
                if (consumers.has(body.consumerId)) {
                    const consumer = consumers.get(body.consumerId);
                    if (consumer.peer) {
                        consumer.peer.addIceCandidate(new webrtc.RTCIceCandidate(body.ice))
                            .catch(e => console.error('Error adding ICE candidate:', e));
                    }
                }
                break;
            case 'disconnect':
                try {
                    let { id } = body;
                    cleanupPeer(id);
                } catch (error) {
                    console.error('Error in disconnect:', error);
                }
                break;
            default:
                wss.broadcast(message);

        }
    });

    ws.on('error', () => ws.terminate());
});

/**
 * Broadcast a message to all connected peers
 * @param {string} data - The message to broadcast
 * @param {string} [excludePeerId] - Optional peer ID to exclude from broadcast
 * @param {string} [roomId] - Optional room ID to limit broadcast scope
 */
wss.broadcast = function (data, excludePeerId = null, roomId = null) {
    try {
        peers.forEach((peer, peerId) => {
            if (excludePeerId && peerId === excludePeerId) return;
            if (roomId && peer.roomId !== roomId) return;
            
            if (peer.socket && peer.socket.readyState === WebSocket.OPEN) {
                peer.socket.send(data);
            }
        });
    } catch (error) {
        console.error('Broadcast error:', error);
    }
};

/**
 * Set up periodic ping to keep connections alive and clean up dead connections
 */
const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log(`Client ${ws.id} timed out, terminating connection`);
            return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping();
    });
}, serverOptions.pingInterval);

wss.on('close', () => {
    clearInterval(pingInterval);
});

console.log('Server running.');
