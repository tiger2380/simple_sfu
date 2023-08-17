# Simple SFU

Simple SFU is a very simple SFU (Selective Forwarding Unit) application that allows you to exchange media streams with other clients using WebRTC (Web Real-Time Communication) technology.

## Features

- Exchange media streams with other clients using WebRTC technology
- Selectively forward media streams using the SFU server
- Automatically adjust the layout of remote video streams based on the number of active streams

## Installation

To install Simple SFU, run the following command:

```
npm install
```

This will install all the required dependencies.

## Usage

To start the Simple SFU server, run the following command:

```
npm start
```

This will start the server on port 5000.

To use Simple SFU, open your browser and navigate to the following URL:

```
http://localhost:5000
```

This will open the Simple SFU client in your browser.

## How it works

Simple SFU uses WebRTC technology to establish peer-to-peer connections between clients and exchange media streams. The SFU server receives media streams from multiple clients and selectively forwards them to other clients.

When a client joins the SFU server, it sends its media stream to the server. The server creates a new media consumer for the client's stream and sends it to all other clients. The other clients subscribe to the media consumer and receive the client's media stream.

When a client leaves the SFU server, its media stream is removed from the server and all other clients stop receiving the stream.

## Contributing

Contributions are welcome! If you find a bug or have a feature request, please open an issue or submit a pull request.

## License

Simple SFU is licensed under the [MIT License](https://opensource.org/licenses/MIT).