window.onload = () => {
    init();
};

let peer = null;
const configuration = {
    iceServers: [
        { 'urls': 'stun:stun.stunprotocol.org:3478' },
        { 'urls': 'stun:stun.l.google.com:19302' },
    ]
};
const WS_PORT = 5000;
const username = document.querySelector('#username');
const connectBtn = document.querySelector('#connect');
const remoteContainer = document.querySelector('#remote_videos');
connectBtn.addEventListener('click', connect)

let localUUID = null;
let localStream = null;
let connection = null;
const consumers = new Map();
const clients = new Map();

async function init() {
    console.log('window loaded');
    const protocol = window.location.protocol === 'https' ? 'wss' : 'ws';
    const url = `${protocol}://${window.location.hostname}:${WS_PORT}`;
    connection = new WebSocket(url);
    connection.onmessage = handleMessage;
    connection.onclose = handleClose;
    connection.onopen = event => {
        connectBtn.disabled = false;
        console.log('socket connected')
    }
}

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

async function handleRemoteTrack(e, username) {
    if (document.querySelector(`#remote_${username}`)) {
        document.querySelector(`#remote_${username}`).srcObject.addTrack(e.streams[0].getTracks()[0])
    } else {
        const video = document.createElement('video');
        video.id = `remote_${username}`
        video.srcObject = e.streams[0];
        video.autoplay = true;

        const div = document.createElement('div')
        div.id = `user_${username}`;
        div.classList.add('video_container')
        const textNode = document.createTextNode(username)
        div.appendChild(textNode);
        div.appendChild(video);
        remoteContainer.appendChild(div);
    }
}

async function handleIceCandidate({ candidate }) {
    if (candidate && candidate.candidate && candidate.candidate.length > 0) {
        const payload = {
            type: 'ice',
            ice: candidate,
            uqid: localUUID
        }
        connection.send(JSON.stringify(payload));
    }
}


async function checkPeerConnection(e) {
    var state = peer.iceConnectionState;
    if (state === "failed" || state === "closed" || state === "disconnected") {
        delete peerConnections[peerUuid];
        document.getElementById('videos').removeChild(document.getElementById('remoteVideo_' + peerUuid));
        updateLayout();
    }
}

function handleConsumerIceCandidate(e, id, consumerId) {
    const { candidate } = e;
    if (candidate && candidate.candidate && candidate.candidate.length > 0) {
        const payload = {
            type: 'consumer_ice',
            ice: candidate,
            uqid: id,
            consumerId
        }
        connection.send(JSON.stringify(payload));
    }
}

function handleConsume({ sdp, id, consumerId }) {
    const desc = new RTCSessionDescription(sdp);
    consumers.get(consumerId).setRemoteDescription(desc).catch(e => console.log(e));
}

async function createConsumeTransport(peer) {
    const consumerId = uuidv4();
    const consumerTransport = new RTCPeerConnection(configuration);
    consumerTransport.id = consumerId;
    consumerTransport.peer = peer;
    consumers.set(consumerId, consumerTransport);
    consumers.get(consumerId).addTransceiver('video', { direction: "recvonly" })
    consumers.get(consumerId).addTransceiver('audio', { direction: "recvonly" })
    const offer = await consumers.get(consumerId).createOffer();
    await consumers.get(consumerId).setLocalDescription(offer);

    consumers.get(consumerId).onicecandidate = (e) => handleConsumerIceCandidate(e, peer.id, consumerId);

    consumers.get(consumerId).ontrack = (e) => {
        handleRemoteTrack(e, peer.username)
    };

    return consumerTransport;
}

async function consumeOnce(peer) {
    const transport = await createConsumeTransport(peer);
    const payload = {
        type: 'consume',
        id: peer.id,
        consumerId: transport.id,
        sdp: await transport.localDescription
    }

    connection.send(JSON.stringify(payload))
}

async function handlePeers({ peers }) {
    if(peers.length > 0) {
        for (const peer in peers) {
            clients.set(peers[peer].id, peers[peer]);
            await consumeOnce(peers[peer]);
        }
    }
}

function handleAnswer({ sdp }) {
    const desc = new RTCSessionDescription(sdp);
    peer.setRemoteDescription(desc).catch(e => console.log(e));
}

async function handleNewProducer({ id, username }) {
    console.log(id, username)
    if (id === localUUID) return;
    clients.set(id, { id, username });

    await consumeOnce({ id, username });
}


function handleMessage({ data }) {
    const message = JSON.parse(data);

    switch (message.type) {
        case 'welcome':
            localUUID = message.id;
            break;
        case 'answer':
            handleAnswer(message);
            break;
        case 'peers':
            handlePeers(message);
            break;
        case 'consume':
            handleConsume(message)
            break
        case 'newProducer':
            handleNewProducer(message);
            break;
        case 'user_left':
            removeUser(message);
            break;
    }
}

function removeUser({ id }) {
    consumers.delete(id);
    const { username } = clients.get(id);
    clients.delete(id);
    document.querySelector(`#remote_${username}`).srcObject.getTracks().forEach(track => track.stop());
    document.querySelector(`#user_${username}`).remove();
}

async function connect() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById("video").srcObject = stream;
    localStream = stream;

    peer = createPeer();
    localStream.getTracks().forEach(track => peer.addTrack(track, localStream));
    await subscribe();
}

function handleClose() {
    connection = null;
    localStream.getTracks().forEach(track => track.stop());
    clients = null;
    consumers = null;
}

function createPeer() {
    console.log('creating peer')
    peer = new RTCPeerConnection(configuration);
    peer.ontrack = handleRemoteTrack;
    peer.onicecandidate = handleIceCandidate;
    //peer.oniceconnectionstatechange = checkPeerConnection;
    peer.onnegotiationneeded = () => handleNegotiation(peer);
    return peer;
}

async function handleNegotiation(peer, type) {
    console.log('*** negoitating ***')
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);

    connection.send(JSON.stringify({ type: 'connect', sdp: peer.localDescription, uqid: localUUID, username: username.value }));
}

async function subscribe() {
    await consumeAll();
}

async function consumeAll() {
    const payload = {
        type: 'getPeers',
        uqid: localUUID
    }

    connection.send(JSON.stringify(payload));
}