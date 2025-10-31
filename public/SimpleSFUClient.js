'use strict';

/**
 * @typedef {Object} SimpleSFUEvents
 * @property {string} onLeave - Triggered when a user leaves
 * @property {string} onJoin - Triggered when a user joins
 * @property {string} onCreate - Triggered when the client is created
 * @property {string} onStreamStarted - Triggered when a media stream starts
 * @property {string} onStreamEnded - Triggered when a media stream ends
 * @property {string} onReady - Triggered when the client is ready
 * @property {string} onScreenShareStopped - Triggered when screen sharing stops
 * @property {string} exitRoom - Triggered when leaving the room
 * @property {string} onConnected - Triggered when WebSocket connects
 * @property {string} onRemoteTrack - Triggered when receiving a remote track
 * @property {string} onRemoteSpeaking - Triggered when a remote user starts speaking
 * @property {string} onRemoteStoppedSpeaking - Triggered when a remote user stops speaking
 * @property {string} onError - Triggered when an error occurs
 * @property {string} onConnectionStateChange - Triggered when connection state changes
 */

/** @type {SimpleSFUEvents} */
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
    onError: 'onError',
    onConnectionStateChange: 'onConnectionStateChange',
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

    /**
     * Initializes the WebSocket connection
     * @private
     */
    initWebSocket() {
        try {
            const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
            const url = `${protocol}://${window.location.hostname}:${this.settings.port}`;
            
            this.connection = new WebSocket(url);
            
            this.connection.onmessage = (data) => this.handleMessage(data);
            this.connection.onclose = () => this.handleClose();
            this.connection.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.trigger(_EVENTS.onError, { type: 'websocket', error });
            };
            this.connection.onopen = event => {
                this.trigger(_EVENTS.onConnected, event);
                this._isOpen = true;
            };

            // Add connection timeout
            const timeout = setTimeout(() => {
                if (this.connection.readyState !== WebSocket.OPEN) {
                    this.trigger(_EVENTS.onError, { 
                        type: 'connection',
                        error: new Error('Connection timeout')
                    });
                    this.connection.close();
                }
            }, 10000); // 10 second timeout

            this.connection.addEventListener('open', () => clearTimeout(timeout));
        } catch (error) {
            console.error('Failed to initialize WebSocket:', error);
            this.trigger(_EVENTS.onError, { type: 'initialization', error });
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

    /**
     * Handle incoming remote media tracks
     * @param {MediaStream} stream - The media stream containing the track
     * @param {string} username - The username associated with the track
     * @param {string} consumerId - The unique consumer ID
     * @private
     */
    async handleRemoteTrack(stream, username, consumerId) {
        try {
            const userVideo = this.findUserVideo(consumerId);
            
            if (userVideo) {
                // Handle existing video element
                const tracks = userVideo.srcObject.getTracks();
                const newTrack = stream.getTracks()[0];
                
                // Prevent duplicate tracks
                if (tracks.some(track => track.id === newTrack.id)) {
                    return;
                }

                // Add new track to existing stream
                userVideo.srcObject.addTrack(newTrack);
                
                // Monitor track status
                newTrack.onended = () => {
                    this.trigger(_EVENTS.onStreamEnded, { username, consumerId, trackId: newTrack.id });
                };
            } else {
                // Create new video element for the stream
                const video = this.createVideoElement(username, stream, consumerId);
                
                // Set up audio analysis with Hark
                try {
                    const harkInstance = new hark(stream, {
                        play: false,           // don't play the stream
                        threshold: -65,        // voice activity detection threshold
                        interval: 100          // how often to check audio level
                    });

                    const handleVolumeChange = (dBs, threshold) => {
                        this.trigger(_EVENTS.onRemoteVolumeChange, { 
                            username, 
                            consumerId, 
                            dBs, 
                            threshold 
                        });
                    };

                    const handleStoppedSpeaking = () => {
                        this.trigger(_EVENTS.onRemoteStoppedSpeaking, { username, consumerId });
                        video.classList.remove('speaking');
                    };

                    const handleSpeaking = () => {
                        this.trigger(_EVENTS.onRemoteSpeaking, { username, consumerId });
                        video.classList.add('speaking');
                    };

                    harkInstance.on('volume_change', handleVolumeChange);
                    harkInstance.on('stopped_speaking', handleStoppedSpeaking);
                    harkInstance.on('speaking', handleSpeaking);

                    // Store hark instance for cleanup
                    video.harkInstance = harkInstance;
                } catch (error) {
                    console.warn('Failed to initialize audio monitoring:', error);
                }

                // Create and add video wrapper to DOM
                const div = this.createVideoWrapper(video, username, consumerId);
                const container = document.querySelector('.videos-inner');
                if (container) {
                    container.appendChild(div);
                } else {
                    console.warn('Video container not found');
                }

                this.trigger(_EVENTS.onRemoteTrack, { stream, username, consumerId });
            }

            this.recalculateLayout();
        } catch (error) {
            console.error('Error handling remote track:', error);
            this.trigger(_EVENTS.onError, { 
                type: 'remote-track', 
                error,
                details: { username, consumerId } 
            });
        }
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

    /**
     * Creates a new consumer transport for receiving media
     * @param {Object} peer - The peer to create the transport for
     * @returns {Promise<RTCPeerConnection>} The created consumer transport
     * @private
     */
    async createConsumeTransport(peer) {
        try {
            const consumerId = this.uuidv4();
            const consumerTransport = new RTCPeerConnection(this.settings.configuration);
            
            if (!this.clients.has(peer.id)) {
                throw new Error(`Client ${peer.id} not found`);
            }
            
            this.clients.get(peer.id).consumerId = consumerId;
            consumerTransport.id = consumerId;
            consumerTransport.peer = peer;
            
            this.consumers.set(consumerId, consumerTransport);
            
            // Add transceivers for video and audio
            ['video', 'audio'].forEach(kind => {
                this.consumers.get(consumerId).addTransceiver(kind, { direction: "recvonly" });
            });

            // Set up connection state change handler
            consumerTransport.onconnectionstatechange = () => {
                this.trigger(_EVENTS.onConnectionStateChange, {
                    id: consumerId,
                    state: consumerTransport.connectionState
                });

                if (consumerTransport.connectionState === 'failed') {
                    this.trigger(_EVENTS.onError, {
                        type: 'connection',
                        error: new Error(`Consumer transport ${consumerId} failed`)
                    });
                }
            };

            // Create and set local description
            const offer = await this.consumers.get(consumerId).createOffer();
            await this.consumers.get(consumerId).setLocalDescription(offer);

            // Set up ICE candidate handling
            this.consumers.get(consumerId).onicecandidate = (e) => {
                this.handleConsumerIceCandidate(e, peer.id, consumerId);
            };

            // Set up track handling
            this.consumers.get(consumerId).ontrack = (e) => {
                this.handleRemoteTrack(e.streams[0], peer.username, consumerId);
            };

            return consumerTransport;
        } catch (error) {
            console.error('Failed to create consume transport:', error);
            this.trigger(_EVENTS.onError, { type: 'transport', error });
            throw error;
        }
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

    async handleNewProducer({ id, username, trackInfo }) {
        if (id === this.localUUID || this.clients.has(id)) return;

        this.clients.set(id, { id, username, trackInfo });

        await this.consumeOnce({ id, username, trackInfo });
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

    /**
     * Connect to the SFU and start producing media
     * @returns {Promise<void>}
     */
    async connect() {
        try {
            // Request media with constraints
            const constraints = {
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    frameRate: { ideal: 30 }
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            
            // Handle the local stream
            this.handleRemoteTrack(stream, username.value);
            this.localStream = stream;

            // Create and set up peer connection
            this.localPeer = this.createPeer();
            
            // Add all tracks to the peer connection
            this.localStream.getTracks().forEach(track => {
                this.localPeer.addTrack(track, this.localStream);
                
                // Handle track ended events
                track.onended = () => {
                    this.trigger(_EVENTS.onStreamEnded, { track });
                };
            });

            // Set up connection state monitoring
            this.localPeer.onconnectionstatechange = () => {
                this.trigger(_EVENTS.onConnectionStateChange, {
                    state: this.localPeer.connectionState
                });

                if (this.localPeer.connectionState === 'failed') {
                    this.trigger(_EVENTS.onError, {
                        type: 'connection',
                        error: new Error('Local peer connection failed')
                    });
                }
            };

            await this.subscribe();
        } catch (error) {
            console.error('Failed to connect:', error);
            this.trigger(_EVENTS.onError, { type: 'connection', error });
            throw error;
        }
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

    /**
     * Handles cleanup when the connection is closed
     * @private
     */
    handleClose() {
        try {
            // Stop all local tracks
            if (this.localStream) {
                this.localStream.getTracks().forEach(track => {
                    try {
                        track.stop();
                    } catch (error) {
                        console.warn('Error stopping track:', error);
                    }
                });
                this.localStream = null;
            }

            // Close all consumer connections
            if (this.consumers) {
                this.consumers.forEach((consumer, id) => {
                    try {
                        consumer.close();
                        const videoElement = document.querySelector(`#remote_${id}`);
                        if (videoElement) {
                            const stream = videoElement.srcObject;
                            if (stream) {
                                stream.getTracks().forEach(track => track.stop());
                            }
                            videoElement.srcObject = null;
                        }
                    } catch (error) {
                        console.warn(`Error closing consumer ${id}:`, error);
                    }
                });
            }

            // Close local peer connection
            if (this.localPeer) {
                try {
                    this.localPeer.close();
                } catch (error) {
                    console.warn('Error closing local peer:', error);
                }
                this.localPeer = null;
            }

            // Clear collections
            this.consumers = new Map();
            this.clients = new Map();
            this._isOpen = false;

            // Clean up WebSocket
            if (this.connection) {
                this.connection.onclose = null;
                this.connection.onmessage = null;
                this.connection.onerror = null;
                this.connection = null;
            }

            // Clear video container
            const videoContainer = document.querySelector('.videos-inner');
            if (videoContainer) {
                videoContainer.innerHTML = '';
            }

            this.trigger(_EVENTS.onStreamEnded);
        } catch (error) {
            console.error('Error in handleClose:', error);
            this.trigger(_EVENTS.onError, { type: 'cleanup', error });
        }
    }


    uuidv4() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    /**
     * Recalculates the layout of video elements in a Zoom-like grid
     * @private
     */
    recalculateLayout() {
        try {
            const container = remoteContainer;
            const videoContainer = document.querySelector('.videos-inner');
            const videos = container.querySelectorAll('.videoWrap');
            const videoCount = videos.length;

            if (!videoContainer || videoCount === 0) return;

            // Reset any existing styles
            videoContainer.style.removeProperty('--columns');
            videoContainer.style.removeProperty('--rows');
            videos.forEach(video => {
                video.style.width = '';
                video.style.height = '';
                video.style.order = '';
            });

            // Calculate optimal grid dimensions
            const aspectRatio = 16/9;
            const containerWidth = videoContainer.clientWidth;
            const containerHeight = videoContainer.clientHeight;
            const containerAspectRatio = containerWidth / containerHeight;

            let columns, rows;
            if (videoCount === 1) {
                columns = 1;
                rows = 1;
            } else if (videoCount === 2) {
                columns = 2;
                rows = 1;
            } else {
                // Calculate the best grid arrangement
                const sqrt = Math.sqrt(videoCount);
                columns = Math.ceil(sqrt * containerAspectRatio);
                rows = Math.ceil(videoCount / columns);

                // Adjust if we have too many columns
                if (columns > 4) {
                    columns = 4;
                    rows = Math.ceil(videoCount / columns);
                }
            }

            // Calculate video dimensions
            const padding = 8; // Gap between videos
            const availableWidth = containerWidth - (padding * (columns - 1));
            const availableHeight = containerHeight - (padding * (rows - 1));
            const videoWidth = Math.floor(availableWidth / columns);
            const videoHeight = Math.floor(availableHeight / rows);

            // Set grid properties
            videoContainer.style.setProperty('--columns', columns);
            videoContainer.style.setProperty('--rows', rows);
            videoContainer.style.setProperty('--video-width', videoWidth + 'px');
            videoContainer.style.setProperty('--video-height', videoHeight + 'px');
            videoContainer.style.setProperty('--gap', padding + 'px');

            // Apply layout to videos
            videos.forEach((video, index) => {
                // Calculate position in grid
                const row = Math.floor(index / columns);
                const col = index % columns;
                
                // Center videos in last row if it's not full
                if (row === rows - 1) {
                    const itemsInLastRow = videoCount - (rows - 1) * columns;
                    const offset = Math.floor((columns - itemsInLastRow) / 2);
                    if (offset > 0) {
                        video.style.order = index + offset;
                    }
                }

                // Set video dimensions and position
                video.style.width = videoWidth + 'px';
                video.style.height = videoHeight + 'px';

                // Add CSS classes for animations
                video.classList.add('video-transition');
            });

            // Update speaking indicator position for active speaker
            const activeSpeaker = container.querySelector('.videoWrap.speaking');
            if (activeSpeaker) {
                // Move active speaker to first position if not already there
                const currentIndex = Array.from(videos).indexOf(activeSpeaker);
                if (currentIndex > 0) {
                    activeSpeaker.style.order = '0';
                }
            }

            // Set container properties
            videoContainer.style.display = 'grid';
            videoContainer.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
            videoContainer.style.gap = padding + 'px';
            videoContainer.style.justifyContent = 'center';
            videoContainer.style.alignContent = 'center';
        } catch (error) {
            console.error('Error in recalculateLayout:', error);
            this.trigger(_EVENTS.onError, { type: 'layout', error });
        }
    }
}