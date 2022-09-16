// setupWebSocket.js, https://dev.to/ksankar/websockets-with-react-express-part-1-4o68
const WebSocket = require('ws')

// accepts an http server (covered later)
function setupWebSocket(server, backend) {
  // ws instance
  var ws = new WebSocket.Server({server: server})
  ws.on('connection', function(ws, req) {
    // inspect req.headers.authorization (or cookies) for session info
    ws.send(
      "[Secure Echo Server] Hello!\nAuth: '" +
        (req.headers.authorization || 'none') +
        "'\n" +
        "Cookie: '" +
        (req.headers.cookie || 'none') +
        "'\n"
    )
    ws.on('message', function(data) {
      console.log(`Received message => ${data}`)
      ws.send(data)
    })
  })
}

module.exports = setupWebSocket
