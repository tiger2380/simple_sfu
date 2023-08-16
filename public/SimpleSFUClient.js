'use strict'

const _EVENTS = {
    onLeave: 'onLeave',
    onJoin: 'onJoin',
    onCreate: 'onCreate',
    onStreamStarted: 'onStreamStarted',
    onStreamEnded: 'onStreamEnded',
    onReady: 'onReady',
    onScreenShareStopped: 'onScreenShareStopped',
    exitRoom: 'exitRoom',
    onConnected: 'onConnected',
    onRemoteTrack: 'onRemoteTrack',
    onRemoteSpeaking: 'onRemoteSpeaking',
    onRemoteStoppedSpeaking: 'onRemoteStoppedSpeaking',
};

class SimpleSFUClient {
    constructor(options) {
        const defaultSettings = {
            port: 5000,
            configuration: {
                iceServers: [
                    { 'urls': 'stun:stun.stunprotocol.org:3478' },
                    { 'urls': 'stun:stun.l.google.com:19302' },
                ]
            }
        };

        this.settings = Object.assign({}, defaultSettings, options);
        this._isOpen = false;
        this.eventListeners = new Map();
        this.connection = null;
        this.consumers = new Map();
        this.clients = new Map();
        this.localPeer = null;
        this.localUUID = null;
        this.localStream = null;
        Object.keys(_EVENTS).forEach(event => {
            this.eventListeners.set(event, []);
        });

        this.initWebSocket();
        this.trigger(_EVENTS.onReady);
    }

    initWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const url = `${protocol}://${window.location.hostname}:${this.settings.port}`;
        this.connection = new WebSocket(url);
        this.connection.onmessage = (data) => this.handleMessage(data);
        this.connection.onclose = () => this.handleClose();
        this.connection.onopen = event => {
            this.trigger(_EVENTS.onConnected, event);
            this._isOpen = true;
        }
    }

    on(event, callback) {
        if (this.eventListeners.has(event)) {
            this.eventListeners.get(event).push(callback);
        }
    }

    trigger(event, args = null) {
        if (this.eventListeners.has(event)) {
            this.eventListeners.get(event).forEach(callback => callback.call(this, args));
        }
    }

    static get EVENTS() {
        return _EVENTS;
    }

    get IsOpen() {
        return _isOpen;
    }

    findUserVideo(consumerId) {
        const video = document.querySelector(`#remote_${consumerId}`)
        if (!video) {
            return false;
        }
        return video
    }

    /**
     * 
     * @returns {Promise<MediaStream>}
     * @memberof SimpleSFUClient
     * @description This method will return a promise that resolves to a MediaStream object.
     * The MediaStream object will contain the white noise that you can use instead of an actual webcam video/audio.
     */
    whiteNoise = () => {
        let canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 120;
        let ctx = canvas.getContext('2d');
        let p = ctx.getImageData(0, 0, canvas.width, canvas.height);
        requestAnimationFrame(function draw() {
            for (var i = 0; i < p.data.length; i++) {
                p.data[i++] = p.data[i++] = p.data[i++] = Math.random() * 255;
            }
            ctx.putImageData(p, 0, 0);
            requestAnimationFrame(draw);
        });
        return canvas;
    }


    createVideoElement(username, stream, consumerId) {
        const video = document.createElement('video');
        video.id = `remote_${consumerId}`
        video.srcObject = stream;
        video.autoplay = true;
        video.muted = (username == username.value);
        return video;
    }

    createDisplayName(username) {
        const nameContainer = document.createElement('div');
        nameContainer.classList.add('display_name')
        const textNode = document.createTextNode(username);
        nameContainer.appendChild(textNode);
        return nameContainer;
    }

    /**
     * 
     * @param {*} video 
     * @param {*} username 
     * @returns {HTMLDivElement}
     */
    createVideoWrapper(video, username, consumerId) {
        const div = document.createElement('div')
        div.id = `user_${consumerId}`;
        div.classList.add('videoWrap')
        div.appendChild(this.createDisplayName(username));
        div.appendChild(video);
        return div;
    }

    async handleRemoteTrack(stream, username, consumerId) {
        const userVideo = this.findUserVideo(consumerId);
        if (userVideo) {
            // If the track already exists, do not add it again.
            // This can happen when the remote user unmutes their mic.
            const tracks = userVideo.srcObject.getTracks();
            const track = stream.getTracks()[0];
            if (tracks.includes(track)) {
                return;
            }

            userVideo.srcObject.addTrack(track)
        } else {
            const video = this.createVideoElement(username, stream, consumerId);

            const Hark = new hark(stream);

            Hark.on('volume_change', (dBs, threshold) => {
                this.trigger(_EVENTS.onRemoteVolumeChange, { username, stream, consumerId, dBs, threshold });
            });

            Hark.on('stopped_speaking', () => {
                this.trigger(_EVENTS.onRemoteStoppedSpeaking, { username, stream, consumerId });
                video.classList.remove('speaking');
            });

            Hark.on('speaking', () => {
                this.trigger(_EVENTS.onRemoteSpeaking, { username, stream, consumerId });
                video.classList.add('speaking');
            });

            const div = this.createVideoWrapper(video, username, consumerId);
            document.querySelector('.videos-inner').appendChild(div);

            this.trigger(_EVENTS.onRemoteTrack, stream)
        }

        this.recalculateLayout();
    }

    async handleIceCandidate({ candidate }) {
        if (candidate && candidate.candidate && candidate.candidate.length > 0) {
            const payload = {
                type: 'ice',
                ice: candidate,
                uqid: this.localUUID
            }
            this.connection.send(JSON.stringify(payload));
        }
    }

    handleConsumerIceCandidate(e, id, consumerId) {
        const { candidate } = e;
        if (candidate && candidate.candidate && candidate.candidate.length > 0) {
            const payload = {
                type: 'consumer_ice',
                ice: candidate,
                uqid: id,
                consumerId
            }
            this.connection.send(JSON.stringify(payload));
        }
    }

    handleConsume({ sdp, id, consumerId }) {
        const desc = new RTCSessionDescription(sdp);
        this.consumers.get(consumerId).setRemoteDescription(desc).catch(e => console.log(e));
    }

    async createConsumeTransport(peer) {
        const consumerId = this.uuidv4();
        const consumerTransport = new RTCPeerConnection(this.settings.configuration);
        this.clients.get(peer.id).consumerId = consumerId;
        consumerTransport.id = consumerId;
        consumerTransport.peer = peer;
        this.consumers.set(consumerId, consumerTransport);
        this.consumers.get(consumerId).addTransceiver('video', { direction: "recvonly" })
        this.consumers.get(consumerId).addTransceiver('audio', { direction: "recvonly" })
        const offer = await this.consumers.get(consumerId).createOffer();
        await this.consumers.get(consumerId).setLocalDescription(offer);

        this.consumers.get(consumerId).onicecandidate = (e) => this.handleConsumerIceCandidate(e, peer.id, consumerId);

        this.consumers.get(consumerId).ontrack = (e) => {
            this.handleRemoteTrack(e.streams[0], peer.username, consumerId);
        };

        return consumerTransport;
    }

    async consumeOnce(peer) {
        const transport = await this.createConsumeTransport(peer);
        const payload = {
            type: 'consume',
            id: peer.id,
            consumerId: transport.id,
            sdp: await transport.localDescription
        }

        this.connection.send(JSON.stringify(payload))
    }

    async handlePeers({ peers }) {
        if (peers.length > 0) {
            for (const peer in peers) {
                this.clients.set(peers[peer].id, peers[peer]);
                await this.consumeOnce(peers[peer]);
            }
        }
    }

    handleAnswer({ sdp }) {
        const desc = new RTCSessionDescription(sdp);
        this.localPeer.setRemoteDescription(desc).catch(e => console.log(e));
    }

    async handleNewProducer({ id, username }) {
        if (id === this.localUUID) return;

        this.clients.set(id, { id, username });

        await this.consumeOnce({ id, username });
    }

    handleMessage({ data }) {
        const message = JSON.parse(data);

        switch (message.type) {
            case 'welcome':
                this.localUUID = message.id;
                break;
            case 'answer':
                this.handleAnswer(message);
                break;
            case 'peers':
                this.handlePeers(message);
                break;
            case 'consume':
                this.handleConsume(message)
                break
            case 'newProducer':
                this.handleNewProducer(message);
                break;
            case 'user_left':
                this.removeUser(message);
                break;
        }
    }

    removeUser({ id }) {
        const { username, consumerId } = this.clients.get(id);
        this.consumers.delete(consumerId);
        this.clients.delete(id);
        document.querySelector(`#remote_${consumerId}`).srcObject.getTracks().forEach(track => track.stop());
        document.querySelector(`#user_${consumerId}`).remove();

        this.recalculateLayout();
    }

    async connect() { //Produce media
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        this.handleRemoteTrack(stream, username.value)
        this.localStream = stream;

        this.localPeer = this.createPeer();
        this.localStream.getTracks().forEach(track => this.localPeer.addTrack(track, this.localStream));
        await this.subscribe();
    }

    createPeer() {
        this.localPeer = new RTCPeerConnection(this.configuration);
        this.localPeer.onicecandidate = (e) => this.handleIceCandidate(e);
        //peer.oniceconnectionstatechange = checkPeerConnection;
        this.localPeer.onnegotiationneeded = () => this.handleNegotiation();
        return this.localPeer;
    }

    async subscribe() { // Consume media
        await this.consumeAll();
    }

    async consumeAll() {
        const payload = {
            type: 'getPeers',
            uqid: this.localUUID
        }

        this.connection.send(JSON.stringify(payload));
    }

    async handleNegotiation(peer, type) {
        console.log('*** negoitating ***')
        const offer = await this.localPeer.createOffer();
        await this.localPeer.setLocalDescription(offer);

        this.connection.send(JSON.stringify({ type: 'connect', sdp: this.localPeer.localDescription, uqid: this.localUUID, username: username.value }));
    }

    handleClose() {
        this.connection = null;
        if(this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
        }
        this.clients = null;
        this.consumers = null;
    }


    uuidv4() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    recalculateLayout() {
        const container = remoteContainer;
        const videoContainer = document.querySelector('.videos-inner');
        const videoCount = container.querySelectorAll('.videoWrap').length;

        if (videoCount >= 3) {
            videoContainer.style.setProperty("--grow", 0 + "");
        } else {
            videoContainer.style.setProperty("--grow", 1 + "");
        }
    }
}