'use strict'

const webrtc = require("wrtc");
const cors = require('cors');
const HTTP_PORT = 5000; //default port for http is 80
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
// based on examples at https://www.npmjs.com/package/ws 
const WebSocketServer = WebSocket.Server;

const handleRequest = function (request, response) {
    // Render the single client html file for any request the HTTP server receives
    console.log('request received: ' + request.url);

    if (request.url === '/webrtc.js') {
        response.writeHead(200, { 'Content-Type': 'application/javascript' });
        response.end(fs.readFileSync('client/webrtc.js'));
    } else if (request.url === '/style.css') {
        response.writeHead(200, { 'Content-Type': 'text/css' });
        response.end(fs.readFileSync('client/style.css'));
    } else {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(fs.readFileSync('client/index.html'));
    }
};

const httpServer = http.createServer();
httpServer.listen(HTTP_PORT);
let peers = new Map();
let consumers = new Map();

function handleTrackEvent(e, peer, ws) {
    if (e.streams && e.streams[0]) {
        peers.get(peer).stream = e.streams[0];

        const payload = {
            type: 'newProducer',
            id: peer,
            username: peers.get(peer).username
        }
        wss.broadcast(JSON.stringify(payload));
    }
}

function createPeer() {
    let peer = new webrtc.RTCPeerConnection({
        iceServers: [
            { 'urls': 'stun:stun.stunprotocol.org:3478' },
            { 'urls': 'stun:stun.l.google.com:19302' },
          ]
    });

    return peer;
}

// Create a server for handling websocket calls
const wss = new WebSocketServer({ server: httpServer });


wss.on('connection', function (ws) {
    let peerId = uuidv4();
    ws.id = peerId;
    ws.on('close', (event) => {
        peers.delete(ws.id);
        consumers.delete(ws.id);

        wss.broadcast(JSON.stringify({
            type: 'user_left',
            id: ws.id
        }));
    });
    
    
    ws.send(JSON.stringify({'type': 'welcome', id: peerId}));
    ws.on('message', async function (message) {
        const body = JSON.parse(message);
        switch (body.type) {
            case 'connect':
                peers.set(body.uqid, { socket: ws });
                const peer = createPeer();                
                peers.get(body.uqid).username = body.username;
                peers.get(body.uqid).peer = peer;
                peer.ontrack = (e) => { handleTrackEvent(e, body.uqid, ws) };
                const desc = new webrtc.RTCSessionDescription(body.sdp);
                await peer.setRemoteDescription(desc);
                const answer = await peer.createAnswer();
                await peer.setLocalDescription(answer);

               
   
                const payload = {
                    type: 'answer',
                    sdp: peer.localDescription
                }

                ws.send(JSON.stringify(payload));
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
                if(user.peer)
                 user.peer.addIceCandidate(new webrtc.RTCIceCandidate(body.ice)).catch(e => console.log(e));
                break;
            case 'consume':
                try {
                    let { id, sdp, consumerId } = body;
                    const remoteUser = peers.get(id);
                    const newPeer = createPeer();
                    consumers.set(consumerId, newPeer);
                    const _desc = new webrtc.RTCSessionDescription(sdp);
                    await consumers.get(consumerId).setRemoteDescription(_desc);

                    remoteUser.stream.getTracks().forEach(track => {
                        consumers.get(consumerId).addTrack(track, remoteUser.stream); 
                    });
                    const _answer = await consumers.get(consumerId).createAnswer();
                    await consumers.get(consumerId).setLocalDescription(_answer);

                    const _payload = {
                        type: 'consume',
                        sdp: consumers.get(consumerId).localDescription,
                        username: remoteUser.username,
                        id,
                        consumerId
                    }

                    ws.send(JSON.stringify(_payload));
                } catch (error) {
                    console.log(error)
                }
                
                break;
            case 'consumer_ice':
                if(consumers.has(body.consumerId)) {
                    consumers.get(body.consumerId).addIceCandidate(new webrtc.RTCIceCandidate(body.ice)).catch(e => console.log(e));
                }
                break;
            default:
                wss.broadcast(message);

        }
    });

    ws.on('error', () => ws.terminate());
});

wss.broadcast = function (data) {
    peers.forEach(function (peer) {
        if (peer.socket.readyState === WebSocket.OPEN) {
            peer.socket.send(data);
        }
    });
};

console.log('Server running.');